// The Pro entitlement layer (§14): the record's coercion, the gate, the
// revalidation schedule, and the fail-open reducer.
//
// Storage is faked by assigning a minimal `chrome` to globalThis, the same way
// `prefs.test.ts` does it: the source resolves `chrome.storage.local` through
// `storageArea()` at call time, so swapping the fake per test needs no seam.
//
// The three rules under test, stated in §14 and asserted here:
//   1. Nothing previously free is gated — no code to test, only the absence of a
//      grandfathering path, so nothing here touches `SitePrefs`.
//   2. Fail open: an unreachable validator leaves an entitled reader entitled.
//   3. Fail open never grants: an install with no definite answer is not Pro.
import test from "node:test";
import assert from "node:assert/strict";

import {
  activateLicence,
  applyValidation,
  deactivateLicence,
  DEFAULT_PRO_STATE,
  getProState,
  isPro,
  licenceKeyLooksWellFormed,
  MAX_LICENCE_KEY_LENGTH,
  MIN_LICENCE_KEY_LENGTH,
  normalizeLicenceKey,
  normalizeProState,
  PRO_KEY,
  PRO_PURCHASE_URL,
  PRO_RETRY_INTERVAL_MS,
  PRO_REVALIDATE_INTERVAL_MS,
  proCheckDue,
  refusalMessage,
  setProState,
  validateLicenceKey,
  type ProState,
} from "../src/windowed-fullscreen.ts";

type Store = Record<string, unknown>;

/** Install a working fake storage area, and return its backing object. */
function fakeStorage(initial: Store = {}): Store {
  const data: Store = { ...initial };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set: async (entries: Store) => Object.assign(data, entries),
      },
    },
  };
  return data;
}

/** Install storage that throws, standing in for a revoked or broken area. */
function brokenStorage(): void {
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async () => {
          throw new Error("storage unavailable");
        },
        set: async () => {
          throw new Error("storage unavailable");
        },
      },
    },
  };
}

function noStorage(): void {
  delete (globalThis as Record<string, unknown>).chrome;
}

/** A key of the documented shape. 36 characters, as Dodo issues. */
const GOOD_KEY = "8f14e45f-ceea-467a-9e7f-2b1c3d4e5f60";

/** The provider's id for this device's activation. */
const INSTANCE = "lki_abc123";

/** An entitled record, confirmed at `checkedAt` and bound to this device. */
function entitled(overrides: Partial<ProState> = {}): ProState {
  return {
    key: GOOD_KEY,
    instanceId: INSTANCE,
    entitled: true,
    status: "active",
    checkedAt: 1_000_000,
    attemptedAt: 1_000_000,
    ...overrides,
  };
}

// --- Key handling ----------------------------------------------------------

test("a key pasted with a line break through it is stripped, not rejected", () => {
  // A receipt email wraps the key; the reader did not type the newline and a key
  // never legitimately contains one, so stripping is always their intent.
  assert.equal(normalizeLicenceKey(`  8f14e45f-ceea-467a\n-9e7f-2b1c3d4e5f60 `), GOOD_KEY);
  assert.equal(licenceKeyLooksWellFormed(normalizeLicenceKey(`${GOOD_KEY}\r\n`)), true);
});

test("case is preserved, because a provider may treat its keys case-sensitively", () => {
  const mixed = "AbCdEfGh-1234";
  assert.equal(normalizeLicenceKey(mixed), mixed);
});

test("a non-string key normalizes to none rather than throwing", () => {
  for (const value of [undefined, null, 42, {}, [], true]) {
    assert.equal(normalizeLicenceKey(value), "");
  }
});

test("the shape check bounds length and charset", () => {
  assert.equal(licenceKeyLooksWellFormed(GOOD_KEY), true);
  assert.equal(licenceKeyLooksWellFormed("a".repeat(MIN_LICENCE_KEY_LENGTH)), true);
  assert.equal(licenceKeyLooksWellFormed("a".repeat(MAX_LICENCE_KEY_LENGTH)), true);

  assert.equal(licenceKeyLooksWellFormed(""), false);
  assert.equal(licenceKeyLooksWellFormed("a".repeat(MIN_LICENCE_KEY_LENGTH - 1)), false);
  assert.equal(licenceKeyLooksWellFormed("a".repeat(MAX_LICENCE_KEY_LENGTH + 1)), false);
  // Anything that would need escaping in a URL or a JSON body.
  for (const bad of ["key with space", "key/slash", "key.dot", "key<script>", "kéy-accented"]) {
    assert.equal(licenceKeyLooksWellFormed(bad), false, bad);
  }
});

// --- Coercion --------------------------------------------------------------

test("nothing stored reads as the documented defaults, un-entitled", () => {
  assert.deepEqual(normalizeProState(undefined), DEFAULT_PRO_STATE);
  assert.equal(isPro(normalizeProState(undefined)), false);
});

test("a non-object value coerces to the defaults", () => {
  for (const stored of [null, 42, "yes", [], true, NaN]) {
    assert.deepEqual(normalizeProState(stored), DEFAULT_PRO_STATE, String(stored));
  }
});

test("coercion round-trips a well-formed record", () => {
  const state = entitled();
  assert.deepEqual(normalizeProState(state), state);
});

test("each field is checked on its own, so an older record still reads", () => {
  // A record written before `attemptedAt` and `instanceId` existed must not be
  // condemned whole. The absent activation reads as "not bound to a device", which
  // still validates — a reader must not lose a licence they already entered because
  // a later version learned to count devices.
  const stored = { key: GOOD_KEY, entitled: true, status: "active", checkedAt: 500 };
  assert.deepEqual(normalizeProState(stored), {
    key: GOOD_KEY,
    instanceId: "",
    entitled: true,
    status: "active",
    checkedAt: 500,
    attemptedAt: 0,
  });
  assert.equal(isPro(normalizeProState(stored)), true, "an unbound licence stopped working");
});

test("an activation id that could not have come from the provider is dropped", () => {
  // It goes straight into a request body, so it is bounded and restricted to the
  // characters an identifier can hold. An unusable one degrades to "not bound"
  // rather than invalidating the licence around it.
  for (const bad of ["lki with space", "lki/../x", "a".repeat(200), 7, null, {}]) {
    const state = normalizeProState({ ...entitled(), instanceId: bad });
    assert.equal(state.instanceId, "", JSON.stringify(bad));
    assert.equal(isPro(state), true, "a damaged activation id revoked the licence");
  }
});

test("an activation without a key is dropped with it", () => {
  const state = normalizeProState({ instanceId: INSTANCE, entitled: true, status: "active" });
  assert.equal(state.instanceId, "");
  assert.equal(state.key, "");
});

test("unknown fields from a newer version are ignored, not fatal", () => {
  assert.deepEqual(normalizeProState({ ...entitled(), tier: "team", seats: 4 }), entitled());
});

test("entitlement requires a key, so a hand-edited record is not a permanent unlock", () => {
  // Not a security boundary — local storage belongs to the reader — but a record
  // claiming entitlement with nothing to revalidate could never be re-checked.
  const forged = normalizeProState({ entitled: true, status: "active", checkedAt: 1 });
  assert.equal(forged.key, "");
  assert.equal(isPro(forged), false);
  assert.equal(forged.status, "none", "with no key there is no outcome to report");

  const malformed = normalizeProState({ key: "short", entitled: true, status: "active" });
  assert.equal(malformed.key, "");
  assert.equal(isPro(malformed), false);
});

test("a damaged status or timestamp falls back without losing the rest", () => {
  const state = normalizeProState({
    key: GOOD_KEY,
    entitled: true,
    status: "definitely-pro",
    checkedAt: -1,
    attemptedAt: "yesterday",
  });
  assert.deepEqual(state, {
    key: GOOD_KEY,
    instanceId: "",
    entitled: true,
    status: "none",
    checkedAt: 0,
    attemptedAt: 0,
  });
});

test("a coerced record is a fresh object, so the defaults cannot be poisoned", () => {
  const first = normalizeProState("not a record");
  first.entitled = true;
  assert.equal(DEFAULT_PRO_STATE.entitled, false);
  assert.equal(isPro(normalizeProState("not a record")), false);
});

// --- Storage ---------------------------------------------------------------

test("a fresh install is not entitled, and that is not a load failure", async () => {
  fakeStorage();
  const { state, loadFailed } = await getProState();
  assert.deepEqual(state, DEFAULT_PRO_STATE);
  assert.equal(loadFailed, false, "an empty store is a first run, not a failure");
});

test("round-trips an entitled record", async () => {
  fakeStorage();
  const state = entitled();
  assert.deepEqual(await setProState(state), { ok: true });
  const read = await getProState();
  assert.deepEqual(read.state, state);
  assert.equal(isPro(read.state), true);
});

test("the record is its own top-level key, beside the per-site record", async () => {
  const data = fakeStorage({ "site:youtube": { autoApply: true, scrollable: false } });
  await setProState(entitled());
  assert.deepEqual(Object.keys(data).sort(), ["pro", "site:youtube"]);
  assert.deepEqual(
    data["site:youtube"],
    { autoApply: true, scrollable: false },
    "the entitlement write disturbed the per-site record",
  );
  assert.equal(PRO_KEY, "pro");
});

test("a write is normalized too, so an incoherent record cannot be stored", async () => {
  const data = fakeStorage();
  await setProState({ ...DEFAULT_PRO_STATE, entitled: true, status: "active" });
  assert.deepEqual(data[PRO_KEY], DEFAULT_PRO_STATE);
});

test("storage failures degrade to un-entitled and report the failure", async () => {
  noStorage();
  let read = await getProState();
  assert.deepEqual(read.state, DEFAULT_PRO_STATE);
  assert.equal(read.loadFailed, true);
  assert.deepEqual(await setProState(entitled()), { ok: false, error: "storage unavailable" });

  brokenStorage();
  read = await getProState();
  assert.deepEqual(read.state, DEFAULT_PRO_STATE);
  assert.equal(read.loadFailed, true);
  assert.equal((await setProState(entitled())).ok, false);
});

test("a damaged stored record reads as un-entitled without throwing", async () => {
  for (const stored of [null, 42, "pro", [], { entitled: true }]) {
    fakeStorage({ [PRO_KEY]: stored });
    const { state } = await getProState();
    assert.equal(isPro(state), false, JSON.stringify(stored));
  }
});

// --- The gate --------------------------------------------------------------

test("the gate reads entitlement alone, and ignores staleness", () => {
  // Rule 2 in one line: a record confirmed a year ago and never rechecked because
  // the reader has been offline still says yes. `proCheckDue` is the other question.
  assert.equal(isPro(entitled({ checkedAt: 1, attemptedAt: 1 })), true);
  assert.equal(isPro(entitled({ entitled: false, status: "invalid" })), false);
  assert.equal(isPro(DEFAULT_PRO_STATE), false);
});

// --- The revalidation schedule --------------------------------------------

test("nothing is due when there is no key", () => {
  assert.equal(proCheckDue(DEFAULT_PRO_STATE, Date.now()), false);
});

test("a key with no definite answer yet is due at the first opportunity", () => {
  // Rule 3: activation does not get the grace period that protects a confirmed
  // licence, so a key entered a moment ago is asked about immediately. Both
  // timestamps read 0 as never, not as the epoch — read the other way, a key
  // entered on a device whose clock had not been set would wait six hours for the
  // retry of an attempt that never happened.
  const fresh: ProState = { ...DEFAULT_PRO_STATE, key: GOOD_KEY };
  assert.equal(proCheckDue(fresh, 0), true);
  assert.equal(proCheckDue(fresh, 10_000), true);
  assert.equal(proCheckDue(fresh, Date.now()), true);
});

test("a confirmed licence is trusted for the whole interval, then due", () => {
  const confirmedAt = Date.now();
  const state = entitled({ checkedAt: confirmedAt, attemptedAt: confirmedAt });
  assert.equal(proCheckDue(state, confirmedAt + PRO_REVALIDATE_INTERVAL_MS - 1), false);
  assert.equal(proCheckDue(state, confirmedAt + PRO_REVALIDATE_INTERVAL_MS), true);
});

test("a failed attempt is retried on a bounded schedule, not on every wake", () => {
  // The bound is what keeps fail-open from becoming a retry storm against
  // someone else's server — the network form of the bounded-loops invariant.
  const attemptedAt = Date.now();
  const state = entitled({
    checkedAt: attemptedAt - PRO_REVALIDATE_INTERVAL_MS * 3,
    attemptedAt,
    status: "unreachable",
  });
  assert.equal(proCheckDue(state, attemptedAt + PRO_RETRY_INTERVAL_MS - 1), false);
  assert.equal(proCheckDue(state, attemptedAt + PRO_RETRY_INTERVAL_MS), true);
});

test("a clock moved backwards past the last check is due, not trusted forever", () => {
  // Trusting a future-dated `checkedAt` would be an unlock that outlasts any
  // interval, so the skew resolves towards asking rather than towards trusting.
  const now = Date.now();
  const future = now + 10 * PRO_REVALIDATE_INTERVAL_MS;
  assert.equal(proCheckDue(entitled({ checkedAt: future, attemptedAt: 0 }), now), true);
  // The same for a future-dated attempt: it must not park the retry bound out of
  // reach, or one bad clock reading suspends validation indefinitely.
  assert.equal(proCheckDue(entitled({ checkedAt: future, attemptedAt: future }), now), true);
});

test("an unusable clock reading is never due", () => {
  const state = entitled({ checkedAt: 0, attemptedAt: 0 });
  for (const now of [NaN, Infinity, -1]) {
    assert.equal(proCheckDue(state, now), false, String(now));
  }
});

// --- The reducer -----------------------------------------------------------

test("a definite yes entitles and records the answer", () => {
  const before = { ...DEFAULT_PRO_STATE, key: GOOD_KEY, instanceId: INSTANCE };
  assert.deepEqual(applyValidation(before, { outcome: "active" }, 5_000), {
    key: GOOD_KEY,
    instanceId: INSTANCE,
    entitled: true,
    status: "active",
    checkedAt: 5_000,
    attemptedAt: 5_000,
  });
});

test("a definite no revokes, whatever came before it", () => {
  // A refunded or charged-back key has to stop working. Rule 2 does not cover a
  // rejection: it covers the absence of an answer.
  const next = applyValidation(entitled(), { outcome: "invalid", reason: "refunded" }, 9_000);
  assert.equal(isPro(next), false);
  assert.equal(next.status, "invalid");
  assert.equal(next.checkedAt, 9_000);
  assert.equal(next.key, GOOD_KEY, "the key is kept so the reader can see what was rejected");
});

test("an unreachable validator leaves an entitled reader entitled", () => {
  // Rule 2. `checkedAt` must not move, or every hiccup would push the next real
  // check another fortnight out and a revoked key could stay live indefinitely.
  const before = entitled({ checkedAt: 1_000, attemptedAt: 1_000 });
  const next = applyValidation(before, { outcome: "unreachable", reason: "offline" }, 60_000);
  assert.equal(isPro(next), true);
  assert.equal(next.checkedAt, 1_000, "a failed attempt must not extend the grace period");
  assert.equal(next.attemptedAt, 60_000);
  assert.equal(next.status, "unreachable");
});

test("an unreachable validator never grants entitlement", () => {
  // Rule 3, and the asymmetry that makes the reducer a reducer rather than a
  // mapping from an outcome to a state.
  const fresh: ProState = { ...DEFAULT_PRO_STATE, key: GOOD_KEY };
  const next = applyValidation(fresh, { outcome: "unreachable", reason: "offline" }, 60_000);
  assert.equal(isPro(next), false);
  assert.equal(next.checkedAt, 0);
});

test("an unusable clock reading leaves the timestamps alone", () => {
  const before = entitled();
  const next = applyValidation(before, { outcome: "unreachable", reason: "offline" }, NaN);
  assert.equal(next.attemptedAt, before.attemptedAt);
});

// --- The validator --------------------------------------------------------
//
// `fetch` is replaced per test. The one thing every case here is really about is
// that ONLY a definite `{"valid": false}` comes back as `invalid`: every other
// way a network call can go wrong has to be `unreachable`, because that is the
// outcome §14 rule 2 protects an entitled reader through. A failure misreported
// as a rejection takes the features off somebody who paid.

const realFetch = globalThis.fetch;

/** One request the code under test made, decomposed for assertions. */
interface SeenCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** Install a `fetch` that answers with `body` at `status`, and record the calls. */
function fakeFetch(status: number, body: unknown): { calls: SeenCall[] } {
  const calls: SeenCall[] = [];
  (globalThis as Record<string, unknown>).fetch = async (
    url: string,
    init?: { body?: string },
  ): Promise<unknown> => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { calls };
}

/** Install a `fetch` that fails the way an offline browser does. */
function throwingFetch(error: Error): void {
  (globalThis as Record<string, unknown>).fetch = async (): Promise<never> => {
    throw error;
  };
}

function restoreFetch(): void {
  (globalThis as Record<string, unknown>).fetch = realFetch;
}

test("a malformed key is rejected without a request", async () => {
  // The shape check is the reason: an obvious typo is not worth a round trip, and
  // nothing junk should reach the endpoint. A `fetch` that throws on sight proves
  // no request was made.
  throwingFetch(new Error("no request should have been made"));
  try {
    const result = await validateLicenceKey("nope");
    assert.equal(result.outcome, "invalid");
  } finally {
    restoreFetch();
  }
});

test("a confirmed key is active, and the key is what gets sent", async () => {
  const { calls } = fakeFetch(200, { valid: true });
  try {
    assert.deepEqual(await validateLicenceKey(`  ${GOOD_KEY}\n`), { outcome: "active" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body.license_key, GOOD_KEY, "the key was sent un-normalized");
  } finally {
    restoreFetch();
  }
});

test("nothing but the key and the activation id is ever sent", async () => {
  // The privacy claim, asserted rather than promised. Every published statement
  // about this extension says the licence key and nothing else leaves the device,
  // so a request body that grew a field would make a document somewhere untrue.
  const { calls } = fakeFetch(200, { valid: true });
  try {
    await validateLicenceKey(GOOD_KEY, "lki_123");
    assert.deepEqual(Object.keys(calls[0]?.body ?? {}).sort(), [
      "license_key",
      "license_key_instance_id",
    ]);
  } finally {
    restoreFetch();
  }
});

test("an unbound record validates without an activation id rather than failing", async () => {
  // A record written before this extension learned to activate has no instance. It
  // keeps working unbound: a reader must not lose a licence they already entered
  // because a later version learned to count devices.
  const { calls } = fakeFetch(200, { valid: true });
  try {
    assert.equal((await validateLicenceKey(GOOD_KEY)).outcome, "active");
    assert.deepEqual(Object.keys(calls[0]?.body ?? {}), ["license_key"]);
  } finally {
    restoreFetch();
  }
});

test("a definite no is the only thing that comes back as invalid", async () => {
  const { calls } = fakeFetch(200, { valid: false });
  try {
    const result = await validateLicenceKey(GOOD_KEY);
    assert.equal(result.outcome, "invalid");
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch();
  }
});

test("a 4xx is a definite refusal and a 5xx is not", async () => {
  // The line the whole fail-open design sits on. The provider read the request and
  // said no; a 5xx means it never got that far.
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    fakeFetch(status, { error: "nope" });
    assert.equal((await validateLicenceKey(GOOD_KEY)).outcome, "invalid", `status ${status}`);
  }
  for (const status of [500, 502, 503, 504]) {
    fakeFetch(status, { error: "nope" });
    assert.equal((await validateLicenceKey(GOOD_KEY)).outcome, "unreachable", `status ${status}`);
  }
  restoreFetch();
});

test("an answer in a shape we do not recognise fails open", async () => {
  // `valid: "yes"` is the case that matters: a truthy check here would unlock the
  // tier the day the provider changed its response format.
  for (const body of [{}, null, { valid: "yes" }, { valid: 1 }, { ok: true }, "true"]) {
    fakeFetch(200, body);
    const result = await validateLicenceKey(GOOD_KEY);
    assert.equal(result.outcome, "unreachable", JSON.stringify(body));
  }
  restoreFetch();
});

test("a network failure fails open", async () => {
  // Offline, DNS, CORS, a refused connection, and our own timeout abort.
  for (const error of [
    new Error("Failed to fetch"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
  ]) {
    throwingFetch(error);
    const result = await validateLicenceKey(GOOD_KEY);
    assert.equal(result.outcome, "unreachable", error.name);
  }
  restoreFetch();
});

test("an unreachable provider cannot entitle an install that never had a key", async () => {
  // Rule 3 end to end, through the real validator rather than the reducer alone.
  throwingFetch(new Error("Failed to fetch"));
  try {
    const state = applyValidation(
      { ...DEFAULT_PRO_STATE, key: GOOD_KEY },
      await validateLicenceKey(GOOD_KEY),
      Date.now(),
    );
    assert.equal(isPro(state), false);
  } finally {
    restoreFetch();
  }
});

test("a long key inside the bound is still sent, not truncated", async () => {
  const long = "A".repeat(MAX_LICENCE_KEY_LENGTH);
  const { calls } = fakeFetch(200, { valid: true });
  try {
    assert.equal((await validateLicenceKey(long)).outcome, "active");
    assert.equal(calls[0]?.body.license_key, long);
  } finally {
    restoreFetch();
  }
});

// --- Activation -----------------------------------------------------------

test("activation binds the licence to this device and returns the instance", async () => {
  const { calls } = fakeFetch(200, {
    id: "lki_abc123",
    // The real response carries the buyer's details. Included here precisely so the
    // assertion below has something to catch if any of it starts being kept.
    customer: { email: "someone@example.com", name: "Someone" },
  });
  try {
    const { validation, instanceId } = await activateLicence(GOOD_KEY);
    assert.deepEqual(validation, { outcome: "active" });
    assert.equal(instanceId, "lki_abc123");
    assert.match(calls[0]?.url ?? "", /\/licenses\/activate$/);
  } finally {
    restoreFetch();
  }
});

test("activation sends the key and a name, and no device fingerprint", async () => {
  // The name is a fixed string on purpose. An extension that collects nothing has
  // no business inventing a per-device identifier so a licence page looks tidier.
  const { calls } = fakeFetch(200, { id: "lki_abc123" });
  try {
    await activateLicence(GOOD_KEY);
    const body = calls[0]?.body ?? {};
    assert.deepEqual(Object.keys(body).sort(), ["license_key", "name"]);
    assert.equal(typeof body.name, "string");
    // Nothing derived from the machine: no version numbers, no platform, no digits
    // that could be a screen size or a generated id.
    assert.ok(!/\d/.test(String(body.name)), `the instance name carries digits: ${body.name}`);
  } finally {
    restoreFetch();
  }
});

test("a refused activation is definite whatever the reason, and binds nothing", async () => {
  // Every 4xx is one entitlement answer: no. Which sentence the reader is shown is a
  // separate, later decision — see `refusalMessage` — and it cannot reach back and
  // change this, which is what makes reading the provider's `code` there safe.
  for (const status of [400, 403, 404, 409, 422]) {
    fakeFetch(status, { code: "LICENSE_KEY_LIMIT_REACHED" });
    const { validation, instanceId } = await activateLicence(GOOD_KEY);
    assert.equal(validation.outcome, "invalid", `status ${status}`);
    assert.equal(instanceId, "");
  }
  restoreFetch();
});

test("a refusal carries the provider's status and code through", async () => {
  fakeFetch(403, {
    code: "LICENSE_KEY_LIMIT_REACHED",
    message: "License key activation limit reached",
  });
  try {
    const { validation } = await activateLicence(GOOD_KEY);
    assert.equal(validation.outcome, "invalid");
    assert.equal(validation.outcome === "invalid" ? validation.status : 0, 403);
    assert.equal(
      validation.outcome === "invalid" ? validation.code : "",
      "LICENSE_KEY_LIMIT_REACHED",
    );
  } finally {
    restoreFetch();
  }
});

test("a refusal with no readable body is still a refusal", async () => {
  // The body is read only to choose words, so a missing or non-JSON one degrades to
  // the general message rather than failing the request a second time.
  (globalThis as Record<string, unknown>).fetch = async (): Promise<unknown> => ({
    ok: false,
    status: 404,
    json: async () => {
      throw new Error("not json");
    },
  });
  try {
    const { validation } = await activateLicence(GOOD_KEY);
    assert.equal(validation.outcome, "invalid");
    assert.equal(validation.outcome === "invalid" ? validation.code : "unset", undefined);
  } finally {
    restoreFetch();
  }
});

test("an activation we cannot identify is not an entitlement", async () => {
  // Accepted, but with no instance id there is no way to hand the slot back later.
  // Entitling here would leak one of the reader's device slots permanently, so this
  // resolves toward asking again rather than toward unlocking.
  for (const body of [{}, null, { id: "" }, { id: 7 }]) {
    fakeFetch(200, body);
    const { validation, instanceId } = await activateLicence(GOOD_KEY);
    assert.equal(validation.outcome, "unreachable", JSON.stringify(body));
    assert.equal(instanceId, "");
  }
  restoreFetch();
});

test("a malformed key is refused before any request", async () => {
  throwingFetch(new Error("no request should have been made"));
  try {
    const { validation } = await activateLicence("nope");
    assert.equal(validation.outcome, "invalid");
  } finally {
    restoreFetch();
  }
});

// --- Deactivation ---------------------------------------------------------

test("removing a key hands the activation back", async () => {
  const { calls } = fakeFetch(200, null);
  try {
    assert.equal(await deactivateLicence(GOOD_KEY, "lki_abc123"), true);
    assert.match(calls[0]?.url ?? "", /\/licenses\/deactivate$/);
    assert.deepEqual(calls[0]?.body, {
      license_key: GOOD_KEY,
      license_key_instance_id: "lki_abc123",
    });
  } finally {
    restoreFetch();
  }
});

test("a deactivation with nothing to deactivate makes no request", async () => {
  throwingFetch(new Error("no request should have been made"));
  try {
    assert.equal(await deactivateLicence(GOOD_KEY, ""), false);
    assert.equal(await deactivateLicence("nope", "lki_abc123"), false);
  } finally {
    restoreFetch();
  }
});

test("a failed deactivation reports false rather than throwing", async () => {
  // The Remove button removes the licence either way — it must work offline — so
  // this only decides which of two messages the reader gets.
  throwingFetch(new Error("Failed to fetch"));
  try {
    assert.equal(await deactivateLicence(GOOD_KEY, "lki_abc123"), false);
  } finally {
    restoreFetch();
  }
});

// --- The hosts the build talks to ------------------------------------------

test("the licence API and the checkout link are in the same mode", async () => {
  // Not "both are live". Test mode is the correct state for the whole development
  // phase — working against live keys means buying the product to test it — and an
  // earlier version of this file asserted liveness here, which made the suite red
  // for every commit that was not a release. A permanently red check is a check
  // nobody reads, and it hid nothing useful: whether a *shipped* build is live is
  // answered by `scripts/package.mjs`, which searches the emitted bundle and is the
  // only thing that can produce an upload.
  //
  // What is left is the half no other guard covers, and it is the quietest form of
  // the bug. A live API host with a test checkout link sends the reader to a page
  // that accepts a test card, charges nothing, and issues a key the live host will
  // never recognise — a purchase that silently did not happen, with no error
  // anywhere. The two constants are different strings, so nothing but this makes
  // them move together.
  const { calls } = fakeFetch(200, { valid: true });
  let apiUrl: string | undefined;
  try {
    await validateLicenceKey(GOOD_KEY);
    apiUrl = calls[0]?.url;
  } finally {
    restoreFetch();
  }

  const apiLive = apiUrl?.startsWith("https://live.dodopayments.com/") ?? false;
  const apiTest = apiUrl?.startsWith("https://test.dodopayments.com/") ?? false;
  assert.ok(apiLive || apiTest, `the licence API host is neither mode: ${apiUrl}`);

  // Checked with the live prefix rather than the test one, because a substring
  // search for the API host does not catch `test.checkout.dodopayments.com`.
  const checkoutLive = PRO_PURCHASE_URL.startsWith("https://live.checkout.dodopayments.com/");

  assert.equal(
    apiLive,
    checkoutLive,
    `the licence API is ${apiLive ? "live" : "test"} mode but the checkout link is ` +
      `${checkoutLive ? "live" : "test"} mode: ${PRO_PURCHASE_URL}`,
  );
});

// --- Which sentence a refusal gets ----------------------------------------
//
// One message for every refusal was the original design, on the reasoning that only
// the provider's prose separates them. It cost a working afternoon: a key refused
// for the activation limit read as a key typed wrongly, so the response was to
// re-paste it, and every re-paste burned another activation. These assert the split
// and, just as importantly, that an unrecognised code lands on the safe side.

const REFUSAL_COPY = {
  invalid: "check what you pasted",
  limit: "too many devices",
  revoked: "no longer active",
  unreachable: "could not reach",
} as const;

test("the activation limit is named as itself, not as a bad key", () => {
  assert.equal(
    refusalMessage(
      { outcome: "invalid", reason: "provider refused with 403", code: "LICENSE_KEY_LIMIT_REACHED" },
      REFUSAL_COPY,
    ),
    REFUSAL_COPY.limit,
  );
});

test("a revoked key is named as itself, so nobody hunts for a typo", () => {
  assert.equal(
    refusalMessage(
      { outcome: "invalid", reason: "provider refused with 403", code: "INACTIVE_LICENSE_KEY" },
      REFUSAL_COPY,
    ),
    REFUSAL_COPY.revoked,
  );
});

test("an unknown key, and any code we do not recognise, gets the general refusal", () => {
  // The default matters more than the two special cases: a provider adding a code
  // must not be able to produce a message that misleads, and it certainly must not
  // unlock anything.
  for (const code of [undefined, "", "NOT_FOUND", "LICENSE_KEY_NOT_FOUND", "SOMETHING_NEW"]) {
    assert.equal(
      refusalMessage({ outcome: "invalid", reason: "refused", code }, REFUSAL_COPY),
      REFUSAL_COPY.invalid,
      String(code),
    );
  }
});

test("an unreachable check is not called a refusal", () => {
  // The reader keeps every feature, so telling them the key was not accepted would
  // be false, and it is the message that generates the support email.
  assert.equal(
    refusalMessage({ outcome: "unreachable", reason: "offline" }, REFUSAL_COPY),
    REFUSAL_COPY.unreachable,
  );
});
