/**
 * Preference Store
 *
 * Wraps `chrome.storage` with per-site namespacing and documented defaults.
 * In production it is backed by `chrome.storage.local` ONLY, so preferences are
 * stored on the user's device and never leave it — keeping the privacy promise
 * ("data sent off device: No") strictly true. The store still coordinates a
 * `sync`-preferred / `local`-fallback pair generically, so an injected backend
 * (e.g. in tests) may supply both; the ambient production backend supplies only
 * `local`.
 *
 * Implements the `PreferenceStore` interface shape from the design:
 *
 *   interface PreferenceStore {
 *     getGlobal(): Promise<GlobalPrefs>;
 *     setGlobal(p: Partial<GlobalPrefs>): Promise<WriteResult>;
 *     getSite(siteId: string): Promise<SitePrefs>;
 *     setSite(siteId: string, p: Partial<SitePrefs>): Promise<WriteResult>;
 *   }
 *
 * Behavior (Requirement 4):
 * - Per-site values are stored under namespaced keys `site:<siteId>` so writing
 *   one site never affects another (4.6).
 * - Reads return documented defaults when no value exists (4.7) or when storage
 *   is unavailable/corrupt, and the latter case signals a load error (4.4).
 * - On write failure the prior stored value is left intact (storage is never
 *   mutated on a failed write) and a failure `WriteResult` is returned (4.2).
 *
 * The store is constructed with an injectable storage backend so tests can
 * substitute an in-memory `chrome.storage` stub (including one configured to
 * fail). When no backend is provided it binds to the ambient `chrome.storage`.
 */

import {
  DEFAULT_SITE_PREFS,
  type GlobalPrefs,
  type SitePrefs,
  type WriteResult,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Documented default global preferences applied on absence/corruption (Req 4.4/4.7). */
export const DEFAULT_GLOBAL_PREFS: GlobalPrefs = {
  schemaVersion: 1,
};

/** The storage key holding global preferences. */
export const GLOBAL_KEY = "global";

/** Build the namespaced storage key for a site's preferences (Req 4.6). */
export function siteKey(siteId: string): string {
  return `site:${siteId}`;
}

// ---------------------------------------------------------------------------
// Storage backend abstraction (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of a `chrome.storage` area used by the store. Mirrors the
 * promise-based MV3 API so the real `chrome.storage.sync` / `chrome.storage.local`
 * satisfy it directly, and an in-memory stub can implement it for tests.
 */
export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The two storage areas the store coordinates: sync (preferred) and local (fallback). */
export interface StorageBackend {
  sync?: StorageArea | null;
  local?: StorageArea | null;
}

/** Describes why a read could not return stored data (Req 4.4). */
export interface PreferenceLoadError {
  /** "unavailable" when no storage area could be read; "corrupt" when data was unreadable. */
  reason: "unavailable" | "corrupt";
  /** The key that failed to load. */
  key: string;
  /** Optional human-readable detail. */
  detail?: string;
}

export interface PreferenceStoreOptions {
  /**
   * Storage backend to use. Defaults to the ambient `chrome.storage` areas.
   * Tests pass an in-memory stub here (optionally configured to fail).
   */
  backend?: StorageBackend;
  /**
   * Invoked when a read falls back to defaults because storage was unavailable
   * or the stored value was corrupt (Req 4.4). Absence of a stored value is the
   * normal default case (Req 4.7) and does NOT trigger this callback.
   */
  onLoadError?: (error: PreferenceLoadError) => void;
}

// ---------------------------------------------------------------------------
// Public interface (matches design.md)
// ---------------------------------------------------------------------------

export interface PreferenceStore {
  getGlobal(): Promise<GlobalPrefs>;
  setGlobal(p: Partial<GlobalPrefs>): Promise<WriteResult>;
  getSite(siteId: string): Promise<SitePrefs>;
  setSite(siteId: string, p: Partial<SitePrefs>): Promise<WriteResult>;
}

// ---------------------------------------------------------------------------
// Validation helpers (corruption detection)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidGlobalPrefs(value: unknown): value is GlobalPrefs {
  return isRecord(value) && typeof value.schemaVersion === "number";
}

function isValidSitePrefs(value: unknown): value is SitePrefs {
  return (
    isRecord(value) &&
    typeof value.siteId === "string" &&
    typeof value.autoApply === "boolean"
  );
}

// ---------------------------------------------------------------------------
// Ambient chrome.storage binding
// ---------------------------------------------------------------------------

/**
 * Adapt the ambient `chrome.storage` areas to the `StorageBackend` shape. Returns
 * areas only when they exist; a missing `chrome`/`chrome.storage` yields empty
 * areas so reads surface an "unavailable" load error and writes report failure.
 */
function getAmbientBackend(): StorageBackend {
  const storage =
    typeof chrome !== "undefined" && chrome.storage ? chrome.storage : undefined;
  if (!storage) {
    return { sync: null, local: null };
  }
  // Local-only by design: settings are stored on this device and never leave it,
  // which keeps the published privacy policy ("data sent off device: No, runs
  // locally") strictly true. `chrome.storage.sync` would replicate settings
  // across the user's devices via their browser account, so it is intentionally
  // NOT used here. (The store still supports a sync area for tests/other
  // deployments via an injected backend.)
  return {
    sync: null,
    local: storage.local ? adaptChromeArea(storage.local) : null,
  };
}

/** Wrap a real `chrome.storage` area into the promise-based `StorageArea`. */
function adaptChromeArea(area: chrome.storage.StorageArea): StorageArea {
  return {
    get: (key: string) => Promise.resolve(area.get(key) as Promise<Record<string, unknown>>),
    set: (items: Record<string, unknown>) => Promise.resolve(area.set(items) as Promise<void>),
  };
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

class ChromeStoragePreferenceStore implements PreferenceStore {
  private readonly backend: StorageBackend;
  private readonly onLoadError?: (error: PreferenceLoadError) => void;

  constructor(options: PreferenceStoreOptions = {}) {
    this.backend = options.backend ?? getAmbientBackend();
    this.onLoadError = options.onLoadError;
  }

  async getGlobal(): Promise<GlobalPrefs> {
    const read = await this.readRaw(GLOBAL_KEY);
    if (!read.ok) {
      this.signalLoadError({ reason: "unavailable", key: GLOBAL_KEY });
      return { ...DEFAULT_GLOBAL_PREFS };
    }
    if (read.value === undefined) {
      // No stored value: documented defaults, not an error (Req 4.7).
      return { ...DEFAULT_GLOBAL_PREFS };
    }
    if (!isValidGlobalPrefs(read.value)) {
      this.signalLoadError({ reason: "corrupt", key: GLOBAL_KEY });
      return { ...DEFAULT_GLOBAL_PREFS };
    }
    return { ...DEFAULT_GLOBAL_PREFS, ...read.value };
  }

  async setGlobal(p: Partial<GlobalPrefs>): Promise<WriteResult> {
    const current = await this.getGlobal();
    const next: GlobalPrefs = { ...current, ...p };
    return this.writeRaw(GLOBAL_KEY, next);
  }

  async getSite(siteId: string): Promise<SitePrefs> {
    const key = siteKey(siteId);
    const read = await this.readRaw(key);
    if (!read.ok) {
      this.signalLoadError({ reason: "unavailable", key });
      return { siteId, ...DEFAULT_SITE_PREFS };
    }
    if (read.value === undefined) {
      // No stored value for this site: documented defaults (Req 4.7).
      return { siteId, ...DEFAULT_SITE_PREFS };
    }
    if (!isValidSitePrefs(read.value)) {
      this.signalLoadError({ reason: "corrupt", key });
      return { siteId, ...DEFAULT_SITE_PREFS };
    }
    // Merge over defaults so missing optional fields fall back to documented
    // defaults, and force siteId to the requested id for consistency.
    return { ...DEFAULT_SITE_PREFS, ...read.value, siteId };
  }

  async setSite(siteId: string, p: Partial<SitePrefs>): Promise<WriteResult> {
    const key = siteKey(siteId);
    const current = await this.getSite(siteId);
    // Always persist a normalized full SitePrefs so reads round-trip; the
    // requested siteId wins regardless of any siteId in the partial.
    const next: SitePrefs = { ...current, ...p, siteId };
    return this.writeRaw(key, next);
  }


  // -------------------------------------------------------------------------
  // Low-level storage coordination (sync preferred, local fallback)
  // -------------------------------------------------------------------------

  /**
   * Read a single key across the coordinated areas (sync preferred, then local).
   *
   * A value present in `sync` wins. But a successful-but-EMPTY `sync` read must
   * NOT shadow a value that exists in `local`: writes made while sync was
   * temporarily unavailable land in `local`, and once sync recovers it returns
   * empty until it re-replicates. Treating that empty sync read as
   * authoritative would make a locally-persisted preference appear to vanish.
   * So when sync reads successfully but has no value for the key, we fall
   * through to `local` and adopt its value if present.
   *
   * Returns `{ ok: true, value }` when at least one area could be read (value is
   * `undefined` only when every readable area lacked the key — the normal
   * "use defaults" case). Returns `{ ok: false }` only when no area could be
   * read at all (none exist, or every existing area threw).
   */
  private async readRaw(
    key: string,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const areas = [this.backend.sync, this.backend.local];
    let anyReadSucceeded = false;
    for (const area of areas) {
      if (!area) continue;
      try {
        const result = await area.get(key);
        anyReadSucceeded = true;
        const value = isRecord(result) ? result[key] : undefined;
        // Adopt the first defined value (sync takes precedence over local).
        if (value !== undefined) {
          return { ok: true, value };
        }
        // Empty here: fall through to the next area (local) to recover a value
        // written during a sync outage, rather than shadowing it.
      } catch {
        // Try the next area (local fallback) on read failure.
        continue;
      }
    }
    // Every readable area lacked the key -> undefined (documented-default case).
    if (anyReadSucceeded) {
      return { ok: true, value: undefined };
    }
    // No area exists, or every existing area threw.
    return { ok: false };
  }

  /**
   * Write a single key. Prefers `sync`; on a sync write error falls back to
   * `local`. On failure of all areas, storage is left untouched (the prior
   * value is retained) and a failure `WriteResult` is returned (Req 4.2).
   */
  private async writeRaw(key: string, value: unknown): Promise<WriteResult> {
    const areas: Array<{ name: string; area: StorageArea | null | undefined }> = [
      { name: "sync", area: this.backend.sync },
      { name: "local", area: this.backend.local },
    ];
    let lastError = "no storage area available";
    for (const { name, area } of areas) {
      if (!area) continue;
      try {
        await area.set({ [key]: value });
        return { ok: true };
      } catch (err) {
        lastError = `${name}: ${errorMessage(err)}`;
        continue;
      }
    }
    return { ok: false, error: lastError };
  }

  private signalLoadError(error: PreferenceLoadError): void {
    this.onLoadError?.(error);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `PreferenceStore`. Pass `options.backend` to inject an in-memory
 * `chrome.storage` stub for testing; otherwise the ambient `chrome.storage`
 * areas are used.
 */
export function createPreferenceStore(
  options?: PreferenceStoreOptions,
): PreferenceStore {
  return new ChromeStoragePreferenceStore(options);
}
