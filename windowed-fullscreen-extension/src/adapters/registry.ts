/**
 * Adapter Registry.
 *
 * Holds an ordered list of registered Site_Adapters and resolves the active
 * adapter for a given URL. Resolution is deterministic by registration order:
 * the earliest-registered adapter whose `matches(url)` returns true wins
 * (Requirement 6.4). When no registered adapter matches, resolution returns
 * `null` so callers can decline to inject the button / activate the mode
 * (Requirement 6.6). Resolving on a loaded page is what activates the adapter
 * (Requirement 6.3).
 */

import type { AdapterRegistry, SiteAdapter } from "../shared/types";

/**
 * Default ordered implementation of {@link AdapterRegistry}.
 *
 * Adapters are stored in registration order. `resolve` walks them in that
 * order and returns the first match, guaranteeing exactly one adapter is
 * selected even when several would match (Requirement 6.4).
 */
export class OrderedAdapterRegistry implements AdapterRegistry {
  private readonly adapters: SiteAdapter[] = [];

  /** Append an adapter, preserving registration order. */
  register(adapter: SiteAdapter): void {
    this.adapters.push(adapter);
  }

  /**
   * Returns the earliest-registered adapter whose `matches(url)` is true, or
   * `null` when none match (Requirement 6.6).
   */
  resolve(url: string): SiteAdapter | null {
    for (const adapter of this.adapters) {
      if (adapter.matches(url)) {
        return adapter;
      }
    }
    return null;
  }

  /**
   * Host-level resolution: returns the earliest-registered adapter whose
   * `matchesSite(url)` is true (falling back to `matches(url)` when an adapter
   * does not implement the broader check), or `null` when none handle the site.
   */
  resolveSite(url: string): SiteAdapter | null {
    for (const adapter of this.adapters) {
      const handlesSite = adapter.matchesSite
        ? adapter.matchesSite(url)
        : adapter.matches(url);
      if (handlesSite) {
        return adapter;
      }
    }
    return null;
  }
}

/**
 * Create a fresh, empty {@link AdapterRegistry}.
 */
export function createAdapterRegistry(): AdapterRegistry {
  return new OrderedAdapterRegistry();
}
