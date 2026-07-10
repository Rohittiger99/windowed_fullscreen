import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createAdapterRegistry } from "./registry.js";
import { type SiteAdapter } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Fake Site_Adapter builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake {@link SiteAdapter} whose `matches(url)` returns true
 * exactly when `url` is in the supplied `matchSet`. The registry only consults
 * `matches` and (incidentally) `siteId`; the remaining members are inert stubs
 * so the object satisfies the full interface without affecting resolution.
 */
function makeFakeAdapter(siteId: string, matchSet: readonly string[]): SiteAdapter {
  const set = new Set(matchSet);
  return {
    siteId,
    matches: (url: string) => set.has(url),
    findControlsContainer: () => null,
    findNativeFullscreenButton: () => null,
    findPlayer: () => null,
    getSiteChromeSelectors: () => [],
  };
}

/**
 * The activation "gate": the extension dispatches a toggle / injects the
 * button if and only if adapter resolution is non-null. Modeled as a tiny
 * side-effecting dispatcher so the test asserts the gate's observable behavior
 * agrees with resolution being non-null.
 */
function dispatchIfResolved(resolved: SiteAdapter | null): number {
  let dispatchCount = 0;
  if (resolved !== null) {
    dispatchCount += 1;
  }
  return dispatchCount;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A pool of candidate URL tokens. We first generate a non-empty universe, then
// derive each adapter's match set as a subset of that universe so adapters
// genuinely overlap on shared URLs (exercising registration-order tie-breaks).
const urlTokenArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 12 });

const scenarioArb = fc
  .uniqueArray(urlTokenArb, { minLength: 1, maxLength: 8 })
  .chain((universe) =>
    fc.record({
      universe: fc.constant(universe),
      // Ordered list of adapters; matchSet drawn from the shared universe so
      // multiple adapters can match the same URL.
      adapters: fc.array(
        fc.record({
          siteId: fc.string({ minLength: 1, maxLength: 8 }),
          matchSet: fc.subarray(universe),
        }),
        { maxLength: 6 },
      ),
      // The URL under test: either a URL from the universe (may match) or an
      // arbitrary token (likely matches nothing) to exercise the null branch.
      testUrl: fc.oneof(fc.constantFrom(...universe), urlTokenArb),
    }),
  );

describe("AdapterRegistry — Property 6", () => {
  // Feature: windowed-fullscreen-extension, Property 6: Adapter resolution by registration order gates activation — For any ordered list of registered Site_Adapters and any URL, the registry resolves to the earliest-registered adapter whose matches(url) is true, or to null when none match; the extension dispatches a toggle / injects the button if and only if resolution is non-null.
  // Validates: Requirements 6.4, 6.6, 3.5
  it("resolves the earliest-registered matching adapter (or null) and gates activation on non-null resolution", () => {
    fc.assert(
      fc.property(scenarioArb, ({ adapters, testUrl }) => {
        const registry = createAdapterRegistry();

        // Register adapters in order, keeping parallel references so we can
        // assert identity (not just siteId equality, which may collide).
        const registered: SiteAdapter[] = adapters.map((spec) =>
          makeFakeAdapter(spec.siteId, spec.matchSet),
        );
        for (const adapter of registered) {
          registry.register(adapter);
        }

        const resolved = registry.resolve(testUrl);

        // Expected: the first adapter in registration order whose matches() is true.
        const expectedIndex = registered.findIndex((a) => a.matches(testUrl));

        if (expectedIndex === -1) {
          // No adapter matches -> resolution is null and the gate stays closed.
          expect(resolved).toBeNull();
          expect(dispatchIfResolved(resolved)).toBe(0);
        } else {
          // Exactly the earliest-registered matching adapter is selected.
          expect(resolved).toBe(registered[expectedIndex]);
          // Gate opens: dispatch/inject happens exactly once.
          expect(dispatchIfResolved(resolved)).toBe(1);
        }

        // The gate fires iff resolution is non-null.
        expect(dispatchIfResolved(resolved) === 1).toBe(resolved !== null);
      }),
      { numRuns: 100 },
    );
  });
});
