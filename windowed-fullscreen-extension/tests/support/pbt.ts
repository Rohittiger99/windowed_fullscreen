// A seeded property-testing harness, hand-rolled on purpose.
//
// The obvious move is `fast-check` as a devDependency. This repo forbids it:
// the dependency list is pinned to typescript, esbuild, @types/chrome and
// @types/node, and the whole test layer is `node:test` with no assertion
// library. So the properties in this feature run against the ~200 lines below
// instead. If that trade is ever revisited, the properties transfer unchanged.
//
// What it gives up compared with a real PBT library: no integrated shrinking,
// no bias towards edge values, no replay database. What it keeps, because the
// properties need them: determinism (same seed, same cases, every run),
// exhaustive enumeration for the finite domains this feature is full of
// (three triggers x four flags, five stars, two prompt caps), and a failure
// message you can act on without re-running anything by hand.
import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

/** Uniform draw in [0, 1). One call, one step of the stream. */
export type Rng = () => number;

export interface Gen<T> {
  /** Draw one value from the seeded stream. */
  readonly sample: (rng: Rng) => T;
  /**
   * Every value of a finite domain, small enough to enumerate. When every
   * generator in a property supplies one, `forAll` runs the whole cartesian
   * product instead of sampling — an exhaustive proof beats 100 samples.
   */
  readonly domain?: readonly T[];
  /**
   * Whether a shrink candidate is still a member of this domain. Without it,
   * halving `int(3, 7)` down to 1 would print a counterexample the property
   * never claimed anything about.
   */
  readonly valid?: (value: unknown) => boolean;
}

export interface ForAllOptions {
  /** Sampled cases when the domain is not enumerable. */
  readonly cases?: number;
  /** Base seed. Printed on failure so a run is reproducible from the output. */
  readonly seed?: number;
}

/** Sampled cases per property. 100 is the floor the requirements ask for. */
const DEFAULT_CASES = 100;

/**
 * Base seed when none is given. Fixed rather than time-derived: a suite that
 * fails one run in twenty is worse than one that never explores that case,
 * because nobody can bisect it. Override with WFS_PBT_SEED to widen the search.
 */
const DEFAULT_SEED = 0x5eed;

/**
 * Cap on the cartesian product before enumeration is abandoned for sampling.
 * 4096 covers every finite domain this feature enumerates with room to spare,
 * and keeps a careless `int(0, 1000) x int(0, 1000)` from hanging the suite.
 */
const MAX_EXHAUSTIVE_CASES = 4096;

/**
 * Longest integer range that publishes a domain. 16 covers the small bounded
 * counters this feature enumerates (stars 0-5, prompt caps, attempt counts)
 * and leaves anything timestamp-shaped to sampling.
 */
const MAX_ENUMERABLE_SPAN = 16;

/** Halving steps attempted before the shrunk counterexample is reported as is. */
const MAX_SHRINK_STEPS = 100;

/**
 * mulberry32. Chosen for being 5 lines with a full 2^32 period and no state
 * beyond one integer, which is all a test needs. Not cryptographic; nothing
 * here wants it to be.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator that always yields the same value. Domain of one. */
export function constant<T>(value: T): Gen<T> {
  return { sample: () => value, domain: [value], valid: (v) => v === value };
}

/** Every value of a finite domain, enumerated in the order given. */
export function exhaustive<T>(values: readonly T[]): Gen<T> {
  if (values.length === 0) throw new Error("exhaustive() needs at least one value");
  return {
    sample: (rng) => values[Math.floor(rng() * values.length)] as T,
    domain: values,
    valid: (v) => values.some((candidate) => Object.is(candidate, v)),
  };
}

/** Sugar for the same thing when the values read better inline. */
export function oneOf<T>(...values: readonly T[]): Gen<T> {
  return exhaustive(values);
}

export function bool(): Gen<boolean> {
  return exhaustive([false, true]);
}

/**
 * Integer in [min, max] inclusive. A short range publishes a domain, so
 * `int(0, 5)` for a star rating is enumerated rather than sampled; a wide one
 * does not, because enumerating a thousand timestamps is not the point of
 * exhaustive support and would quietly turn a 100-case property into a slow one.
 */
export function int(min: number, max: number): Gen<number> {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new Error(`int(${min}, ${max}) is not a range`);
  }
  const span = max - min + 1;
  const valid = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  const sample = (rng: Rng) => min + Math.floor(rng() * span);
  if (span > MAX_ENUMERABLE_SPAN) return { sample, valid };
  return {
    sample,
    domain: Array.from({ length: span }, (_, i) => min + i),
    valid,
  };
}

/** Array of 0..maxLength items. Never enumerable, so no domain. */
export function arrayOf<T>(item: Gen<T>, maxLength = 8): Gen<T[]> {
  return {
    sample: (rng) => {
      const length = Math.floor(rng() * (maxLength + 1));
      return Array.from({ length }, () => item.sample(rng));
    },
    valid: (v) =>
      Array.isArray(v) &&
      v.length <= maxLength &&
      (item.valid === undefined || v.every((entry) => item.valid?.(entry) === true)),
  };
}

type ShapeValues<S> = { -readonly [K in keyof S]: S[K] extends Gen<infer T> ? T : never };

/**
 * Object built field by field. Enumerable when every field is, which is what
 * makes a whole stored record (four fields, all small) exhaustible.
 */
export function record<S extends Record<string, Gen<unknown>>>(shape: S): Gen<ShapeValues<S>> {
  const keys = Object.keys(shape) as (keyof S & string)[];
  const sample = (rng: Rng) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = shape[key]?.sample(rng);
    return out as ShapeValues<S>;
  };
  const valid = (v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const asRecord = v as Record<string, unknown>;
    return keys.every((key) => shape[key]?.valid?.(asRecord[key]) !== false);
  };

  const domains = keys.map((key) => shape[key]?.domain);
  if (domains.some((domain) => domain === undefined)) return { sample, valid };
  const size = domains.reduce((total, domain) => total * (domain?.length ?? 1), 1);
  if (size > MAX_EXHAUSTIVE_CASES) return { sample, valid };

  const domain: ShapeValues<S>[] = [];
  for (let index = 0; index < size; index++) {
    const out: Record<string, unknown> = {};
    let rest = index;
    for (let k = 0; k < keys.length; k++) {
      const values = domains[k] as readonly unknown[];
      out[keys[k] as string] = values[rest % values.length];
      rest = Math.floor(rest / values.length);
    }
    domain.push(out as ShapeValues<S>);
  }
  return { sample, domain, valid };
}

/**
 * One generator per value, positionally. Written as a mapped type over the
 * value tuple rather than `Gen<unknown>[]`, because inferring through the
 * mapping is what gives the predicate one named parameter per generator — a
 * plain array constraint infers a union array and every parameter comes out as
 * `boolean | number | string`.
 */
type Gens<T extends readonly unknown[]> = { [K in keyof T]: Gen<T[K]> };

type Predicate<T extends readonly unknown[]> = (
  ...values: T
) => boolean | void | Promise<boolean | void>;

/**
 * Register a property as a `node:test` test. Returning `false` fails the case;
 * so does throwing, which is what lets a body use plain `assert` calls.
 *
 * Cases come from the cartesian product when every generator is enumerable, and
 * from `opts.cases` seeded draws otherwise. Each case gets its own stream seeded
 * `seed + index`, so a reported case can be reproduced on its own rather than
 * only by replaying every draw before it.
 */
export function forAll<T extends readonly unknown[]>(
  name: string,
  gens: Gens<T>,
  predicate: Predicate<T>,
  opts: ForAllOptions = {},
): void {
  const seed = opts.seed ?? envSeed() ?? DEFAULT_SEED;
  const requested = opts.cases ?? DEFAULT_CASES;
  const list = gens as unknown as readonly Gen<unknown>[];
  const enumerated = enumerate(list);
  const total = enumerated ? enumerated.length : requested;

  test(name, async () => {
    /** The failure reason for a case, or null when it held. */
    const check = async (args: unknown[]): Promise<string | null> => {
      try {
        const result = await predicate(...(args as unknown as T));
        return result === false ? "the predicate returned false" : null;
      } catch (err) {
        return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
    };

    for (let index = 0; index < total; index++) {
      // One stream per case, shared by that case's generators. A stream per
      // generator seeded the same way would hand every generator the identical
      // draw, so `[bool(), bool()]` could never disagree.
      const rng = mulberry32(seed + index);
      const args = enumerated
        ? (enumerated[index] as unknown[])
        : list.map((gen) => gen.sample(rng));

      const reason = await check(args);
      if (reason === null) continue;

      const shrunk = await shrink(list, args, check);
      assert.fail(
        report({
          name,
          seed,
          index,
          total,
          mode: enumerated ? "exhaustive" : "sampled",
          reason,
          raw: args,
          shrunk,
        }),
      );
    }
  });
}

/** Every combination, or null when the product is unenumerable or too large. */
function enumerate(gens: readonly Gen<unknown>[]): unknown[][] | null {
  const domains: unknown[][] = [];
  for (const gen of gens) {
    if (gen.domain === undefined) return null;
    domains.push([...gen.domain]);
  }
  const size = domains.reduce((total, domain) => total * domain.length, 1);
  if (size === 0 || size > MAX_EXHAUSTIVE_CASES) return null;

  const cases: unknown[][] = [];
  for (let index = 0; index < size; index++) {
    const combination: unknown[] = [];
    let rest = index;
    for (const domain of domains) {
      combination.push(domain[rest % domain.length]);
      rest = Math.floor(rest / domain.length);
    }
    cases.push(combination);
  }
  return cases;
}

/**
 * Shrink by halving: replace one argument at a time with a simpler value and
 * keep the replacement only while the case still fails. No integrated
 * shrinking, so a shrunk value is a hint rather than a minimum — but "stars: 1,
 * usage: 0" beats "stars: 1, usage: 738" when you are reading the failure.
 */
async function shrink(
  gens: readonly Gen<unknown>[],
  raw: readonly unknown[],
  check: (args: unknown[]) => Promise<string | null>,
): Promise<unknown[]> {
  let current = [...raw];
  for (let step = 0; step < MAX_SHRINK_STEPS; step++) {
    let improved = false;
    for (let i = 0; i < current.length && !improved; i++) {
      for (const candidate of halvings(current[i])) {
        if (gens[i]?.valid?.(candidate) === false) continue;
        const attempt = [...current];
        attempt[i] = candidate;
        if ((await check(attempt)) !== null) {
          current = attempt;
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }
  return current;
}

/** Simpler candidates for one value, each strictly closer to empty or zero. */
function halvings(value: unknown): unknown[] {
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
    const half = value > 0 ? Math.floor(value / 2) : Math.ceil(value / 2);
    return dedupe([0, half], value);
  }
  if (typeof value === "boolean") return value ? [false] : [];
  if (typeof value === "string" && value.length > 0) {
    return dedupe(["", value.slice(0, Math.floor(value.length / 2))], value);
  }
  if (Array.isArray(value) && value.length > 0) {
    return [[], value.slice(0, Math.floor(value.length / 2))];
  }
  if (value !== null && typeof value === "object") {
    // One field at a time, so the surviving fields stay whatever failed.
    const source = value as Record<string, unknown>;
    const candidates: unknown[] = [];
    for (const key of Object.keys(source)) {
      for (const field of halvings(source[key])) {
        candidates.push({ ...source, [key]: field });
      }
    }
    return candidates;
  }
  return [];
}

function dedupe(candidates: unknown[], exclude: unknown): unknown[] {
  const out: unknown[] = [];
  for (const candidate of candidates) {
    if (Object.is(candidate, exclude)) continue;
    if (out.some((seen) => Object.is(seen, candidate))) continue;
    out.push(candidate);
  }
  return out;
}

interface Failure {
  readonly name: string;
  readonly seed: number;
  readonly index: number;
  readonly total: number;
  readonly mode: "exhaustive" | "sampled";
  readonly reason: string;
  readonly raw: readonly unknown[];
  readonly shrunk: readonly unknown[];
}

/**
 * The failure message carries everything needed to reproduce and diagnose:
 * the seed, which case failed, why, and both counterexamples. `inspect` rather
 * than JSON because the damaged-input properties generate NaN, Infinity and
 * undefined, all of which JSON.stringify quietly turns into null.
 */
function report(f: Failure): string {
  const show = (args: readonly unknown[]) =>
    args.map((arg) => inspect(arg, { depth: 4, breakLength: Infinity })).join(", ");
  return [
    `${f.name} failed.`,
    `  reason:         ${f.reason}`,
    `  case:           ${f.index + 1} of ${f.total} (${f.mode})`,
    `  seed:           ${f.seed}  (re-run with WFS_PBT_SEED=${f.seed})`,
    `  counterexample: ${show(f.raw)}`,
    `  shrunk:         ${show(f.shrunk)}`,
  ].join("\n");
}

/** WFS_PBT_SEED widens the search without editing a test. */
function envSeed(): number | null {
  const raw = process.env.WFS_PBT_SEED;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}
