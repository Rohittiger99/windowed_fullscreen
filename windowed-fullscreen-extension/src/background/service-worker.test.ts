import { describe, expect, it, vi } from "vitest";

import {
  TOGGLE_COMMAND,
  handleToggleCommand,
  isSupportedSite,
  routeMessage,
  type MessageRouterDeps,
  type ToggleCommandDeps,
} from "./service-worker.js";
import { buildDefaultRegistry } from "../adapters/index.js";
import { createPreferenceStore, type StorageArea } from "../preferences/store.js";
import type { ExtResponse } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const UNSUPPORTED_URL = "https://example.com/some/page";

/**
 * Build a fully-stubbed ToggleCommandDeps using a real adapter registry (so the
 * Supported_Site gating exercises real resolution logic) and vi.fn() spies for
 * the chrome-backed side effects.
 */
function makeToggleDeps(
  overrides: Partial<ToggleCommandDeps> = {},
): {
  deps: ToggleCommandDeps;
  queryActiveTab: ReturnType<typeof vi.fn>;
  sendToTab: ReturnType<typeof vi.fn>;
  setFailureIndication: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  const queryActiveTab = vi.fn(async () => ({ id: 1, url: YOUTUBE_WATCH_URL }));
  const sendToTab = vi.fn(async (): Promise<ExtResponse | undefined> => ({
    ok: true,
    active: true,
  }));
  const setFailureIndication = vi.fn();
  const log = vi.fn();

  const deps: ToggleCommandDeps = {
    registry: buildDefaultRegistry(),
    queryActiveTab,
    sendToTab,
    setFailureIndication,
    log,
    ...overrides,
  };

  return { deps, queryActiveTab, sendToTab, setFailureIndication, log };
}

// ---------------------------------------------------------------------------
// isSupportedSite (sanity for gating used below)
// ---------------------------------------------------------------------------

describe("isSupportedSite", () => {
  it("returns true for a YouTube watch URL and false otherwise", () => {
    const registry = buildDefaultRegistry();
    expect(isSupportedSite(registry, YOUTUBE_WATCH_URL)).toBe(true);
    expect(isSupportedSite(registry, UNSUPPORTED_URL)).toBe(false);
    expect(isSupportedSite(registry, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleToggleCommand (Requirements 3.1, 3.5, 3.6)
// ---------------------------------------------------------------------------

describe("handleToggleCommand", () => {
  // Req 3.1: toggle dispatch on a Supported_Site forwards TOGGLE and clears any
  // prior failure indication.
  it("dispatches TOGGLE to the content script on a supported site", async () => {
    const { deps, sendToTab, setFailureIndication } = makeToggleDeps();

    const outcome = await handleToggleCommand(TOGGLE_COMMAND, deps);

    expect(outcome).toEqual({ outcome: "toggled", active: true });
    expect(sendToTab).toHaveBeenCalledTimes(1);
    expect(sendToTab).toHaveBeenCalledWith(1, { type: "TOGGLE" });
    // A successful toggle clears the failure indication.
    expect(setFailureIndication).toHaveBeenCalledWith(false);
  });

  // Req 3.5: do nothing on sites that are not a Supported_Site.
  it("ignores the command on a non-supported site without messaging the tab", async () => {
    const { deps, sendToTab, setFailureIndication } = makeToggleDeps({
      queryActiveTab: vi.fn(async () => ({ id: 2, url: UNSUPPORTED_URL })),
    });

    const outcome = await handleToggleCommand(TOGGLE_COMMAND, deps);

    expect(outcome).toEqual({ outcome: "ignored-unsupported" });
    expect(sendToTab).not.toHaveBeenCalled();
    expect(setFailureIndication).not.toHaveBeenCalled();
  });

  // Req 3.6: content script unreachable (sendToTab rejects) -> mode unchanged
  // and a failure indication is surfaced.
  it("surfaces a failure indication when the content script throws", async () => {
    const sendToTab = vi.fn(async (): Promise<ExtResponse | undefined> => {
      throw new Error("Could not establish connection");
    });
    const { deps, setFailureIndication } = makeToggleDeps({ sendToTab });

    const outcome = await handleToggleCommand(TOGGLE_COMMAND, deps);

    expect(outcome).toEqual({
      outcome: "unreachable",
      error: "Could not establish connection",
    });
    expect(setFailureIndication).toHaveBeenCalledTimes(1);
    expect(setFailureIndication).toHaveBeenCalledWith(
      true,
      "Could not establish connection",
    );
  });

  // Req 3.6: a missing/undefined response is also treated as unreachable.
  it("surfaces a failure indication when the content script does not respond", async () => {
    const sendToTab = vi.fn(async (): Promise<ExtResponse | undefined> => undefined);
    const { deps, setFailureIndication } = makeToggleDeps({ sendToTab });

    const outcome = await handleToggleCommand(TOGGLE_COMMAND, deps);

    expect(outcome.outcome).toBe("unreachable");
    expect(setFailureIndication).toHaveBeenCalledWith(
      true,
      "no response from content script",
    );
  });

  // Req 3.6: a non-ok response carries its error through to the indication.
  it("surfaces a failure indication when the content script reports not-ok", async () => {
    const sendToTab = vi.fn(async (): Promise<ExtResponse | undefined> => ({
      ok: false,
      error: "descriptor incomplete",
    }));
    const { deps, setFailureIndication } = makeToggleDeps({ sendToTab });

    const outcome = await handleToggleCommand(TOGGLE_COMMAND, deps);

    expect(outcome).toEqual({ outcome: "unreachable", error: "descriptor incomplete" });
    expect(setFailureIndication).toHaveBeenCalledWith(true, "descriptor incomplete");
  });

  it("ignores commands other than the toggle command", async () => {
    const { deps, queryActiveTab, sendToTab } = makeToggleDeps();

    const outcome = await handleToggleCommand("some-other-command", deps);

    expect(outcome).toEqual({ outcome: "ignored-other-command" });
    expect(queryActiveTab).not.toHaveBeenCalled();
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it("ignores the command when there is no active tab", async () => {
    const { deps, sendToTab } = makeToggleDeps({
      queryActiveTab: vi.fn(async () => undefined),
    });

    const outcome = await handleToggleCommand(TOGGLE_COMMAND, deps);

    expect(outcome).toEqual({ outcome: "ignored-no-tab" });
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it("ignores the command when the active tab has no url", async () => {
    const { deps, sendToTab } = makeToggleDeps({
      queryActiveTab: vi.fn(async () => ({ id: 3 })),
    });

    const outcome = await handleToggleCommand(TOGGLE_COMMAND, deps);

    expect(outcome).toEqual({ outcome: "ignored-no-tab" });
    expect(sendToTab).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// routeMessage (PREF_READ / PREF_WRITE round-trip + GET_STATUS / TOGGLE forwarding)
// ---------------------------------------------------------------------------

/** An in-memory StorageArea for exercising the real Preference Store. */
function memoryArea(seed: Record<string, unknown> = {}): StorageArea {
  const data: Record<string, unknown> = { ...seed };
  return {
    get: (key: string) =>
      Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items: Record<string, unknown>) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
  };
}

/** A StorageArea whose writes always fail, for the PREF_WRITE failure path. */
function failingWriteArea(): StorageArea {
  return {
    get: () => Promise.resolve({}),
    set: () => Promise.reject(new Error("simulated write failure")),
  };
}

describe("routeMessage", () => {
  it("round-trips a site preference via PREF_WRITE then PREF_READ", async () => {
    const store = createPreferenceStore({ backend: { sync: memoryArea(), local: null } });
    const deps: MessageRouterDeps = { store };

    const writeRes = await routeMessage(
      { type: "PREF_WRITE", scope: "site", siteId: "youtube", value: { autoApply: true } },
      deps,
    );
    expect(writeRes).toEqual({ ok: true });

    const readRes = await routeMessage(
      { type: "PREF_READ", scope: "site", siteId: "youtube" },
      deps,
    );
    expect(readRes.ok).toBe(true);
    expect(readRes).toMatchObject({
      ok: true,
      data: { siteId: "youtube", autoApply: true },
    });
  });

  it("reports failure when a PREF_WRITE cannot be persisted", async () => {
    const store = createPreferenceStore({
      backend: { sync: failingWriteArea(), local: null },
    });
    const deps: MessageRouterDeps = { store };

    const writeRes = await routeMessage(
      { type: "PREF_WRITE", scope: "global", value: { schemaVersion: 2 } },
      deps,
    );

    expect(writeRes.ok).toBe(false);
  });

  it("rejects a site-scoped PREF_READ without a siteId", async () => {
    const store = createPreferenceStore({ backend: { sync: memoryArea(), local: null } });
    const deps: MessageRouterDeps = { store };

    const res = await routeMessage({ type: "PREF_READ", scope: "site" }, deps);

    expect(res).toEqual({
      ok: false,
      error: "PREF_READ for site scope requires siteId",
    });
  });

  it("forwards GET_STATUS to the active tab and relays its response", async () => {
    const forwardToActiveTab = vi.fn(async (): Promise<ExtResponse | undefined> => ({
      ok: true,
      active: false,
    }));
    const store = createPreferenceStore({ backend: { sync: memoryArea(), local: null } });
    const deps: MessageRouterDeps = { store, forwardToActiveTab };

    const res = await routeMessage({ type: "GET_STATUS" }, deps);

    expect(forwardToActiveTab).toHaveBeenCalledWith({ type: "GET_STATUS" });
    expect(res).toEqual({ ok: true, active: false });
  });

  it("reports unreachable when forwarding a TOGGLE finds no responding tab", async () => {
    const forwardToActiveTab = vi.fn(async (): Promise<ExtResponse | undefined> => undefined);
    const store = createPreferenceStore({ backend: { sync: memoryArea(), local: null } });
    const deps: MessageRouterDeps = { store, forwardToActiveTab };

    const res = await routeMessage({ type: "TOGGLE" }, deps);

    expect(res).toEqual({ ok: false, error: "content script unreachable" });
  });

  it("reports no active tab when there is no forwarder for status/toggle", async () => {
    const store = createPreferenceStore({ backend: { sync: memoryArea(), local: null } });
    const deps: MessageRouterDeps = { store };

    const res = await routeMessage({ type: "GET_STATUS" }, deps);

    expect(res).toEqual({ ok: false, error: "no active tab to query" });
  });
});
