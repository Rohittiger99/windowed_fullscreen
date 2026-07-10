/**
 * Adapter wiring.
 *
 * Provides the canonical, ready-to-use {@link AdapterRegistry} with every v1
 * Site_Adapter registered in order. The Content_Script bootstrap consumes this
 * shared registry to resolve the active adapter for the current URL
 * (Requirements 6.4, 6.5, 6.6).
 *
 * Registry creation is kept reusable: {@link buildDefaultRegistry} returns a
 * fresh, fully-populated registry (handy for tests and isolated contexts),
 * while {@link defaultRegistry} is the shared singleton for runtime surfaces.
 */

import type { AdapterRegistry } from "../shared/types";
import { createAdapterRegistry } from "./registry";
import { youtubeAdapter } from "./youtube";

/**
 * Build a fresh registry with all v1 adapters registered in priority order.
 *
 * Registration order is the resolution order (Requirement 6.4). YouTube is the
 * single v1 adapter (Requirement 6.5).
 */
export function buildDefaultRegistry(): AdapterRegistry {
  const registry = createAdapterRegistry();
  registry.register(youtubeAdapter);
  return registry;
}

/**
 * Shared singleton registry for runtime surfaces (content-script bootstrap).
 * Created once so all consumers resolve against the same adapter set.
 */
export const defaultRegistry: AdapterRegistry = buildDefaultRegistry();

export { youtubeAdapter } from "./youtube";
export { createAdapterRegistry, OrderedAdapterRegistry } from "./registry";
