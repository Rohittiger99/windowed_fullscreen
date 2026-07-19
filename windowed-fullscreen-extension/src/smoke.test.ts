import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDefaultRegistry, youtubeAdapter } from "./adapters/index.js";

// ---------------------------------------------------------------------------
// Smoke / configuration tests (single-execution checks)
//
// These verify cross-cutting configuration and architectural invariants that
// do not generalize across inputs:
//   - the manifest commands block (Requirement 3.3),
//   - exactly one YouTube Site_Adapter is registered (Requirement 6.5),
//   - the Generic_Core imports no site-specific selectors (Requirement 6.1).
//
// Files are read relative to the project root (the vitest cwd).
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Manifest: commands block (Requirement 3.3)
// ---------------------------------------------------------------------------

interface ManifestCommand {
  suggested_key?: Record<string, string>;
  description?: string;
}

interface Manifest {
  commands?: Record<string, ManifestCommand>;
}

function loadManifest(): Manifest {
  const manifestPath = resolve(PROJECT_ROOT, "manifest.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

describe("manifest commands block", () => {
  // Validates: Requirements 3.3
  it("declares the toggle-windowed-fullscreen command", () => {
    const manifest = loadManifest();
    expect(manifest.commands).toBeDefined();
    expect(manifest.commands).toHaveProperty("toggle-windowed-fullscreen");
  });

  // Validates: Requirements 3.3
  it("declares only functional commands (no unassigned/no-op spare commands)", () => {
    const manifest = loadManifest();
    const commands = manifest.commands ?? {};

    // For a clean Chrome Web Store submission the manifest must not ship
    // unassigned, non-functional "spare" commands (a reviewer red flag). Every
    // declared command other than the toggle would be such a no-op; assert none
    // exist so only the functional toggle command is shipped.
    const unassigned = Object.entries(commands).filter(
      ([name, command]) =>
        name !== "toggle-windowed-fullscreen" && command.suggested_key === undefined,
    );

    expect(unassigned).toHaveLength(0);
    expect(Object.keys(commands)).toEqual(["toggle-windowed-fullscreen"]);
  });
});

// ---------------------------------------------------------------------------
// Adapters: exactly one YouTube adapter is registered (Requirement 6.5)
// ---------------------------------------------------------------------------

describe("adapter registration", () => {
  // Validates: Requirements 6.5
  it("resolves a YouTube watch URL to a youtube adapter", () => {
    const registry = buildDefaultRegistry();
    const adapter = registry.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(adapter).not.toBeNull();
    expect(adapter?.siteId).toBe("youtube");
  });

  // Validates: Requirements 6.5
  it("registers exactly one adapter whose siteId is 'youtube'", () => {
    // The adapters module registers only the youtube adapter (see index.ts:
    // buildDefaultRegistry registers youtubeAdapter and nothing else). Verify
    // the single exported adapter carries the youtube siteId, and that the
    // adapters barrel exports no other Site_Adapter instances.
    expect(youtubeAdapter.siteId).toBe("youtube");

    // Source-level guard: index.ts must register exactly one adapter, the
    // youtubeAdapter. Counting register(...) calls keeps this honest if a
    // second adapter is ever added without updating Requirement 6.5 coverage.
    const indexSrc = readFileSync(
      resolve(PROJECT_ROOT, "src/adapters/index.ts"),
      "utf8",
    );
    const registerCalls = indexSrc.match(/registry\.register\(/g) ?? [];
    expect(registerCalls).toHaveLength(1);
    expect(indexSrc).toContain("registry.register(youtubeAdapter)");
  });
});

// ---------------------------------------------------------------------------
// Architectural boundary: Generic_Core imports no site-specific selectors
// (Requirement 6.1)
// ---------------------------------------------------------------------------

describe("Generic_Core architectural boundary", () => {
  const controllerSrc = readFileSync(
    resolve(PROJECT_ROOT, "src/core/controller.ts"),
    "utf8",
  );

  // Validates: Requirements 6.1
  it("does not import from any adapter module", () => {
    // No import statement may reference the adapters directory.
    expect(controllerSrc).not.toMatch(/from\s+["'][^"']*adapters[^"']*["']/);
    expect(controllerSrc).not.toMatch(/import\(["'][^"']*adapters[^"']*["']\)/);
  });

  // Validates: Requirements 6.1
  it("contains no YouTube-specific selector strings", () => {
    const siteSpecificSelectors = [
      "ytp-",
      "movie_player",
      "#masthead",
      "#secondary",
      "#comments",
      "html5-video-player",
    ];
    for (const selector of siteSpecificSelectors) {
      expect(controllerSrc).not.toContain(selector);
    }
  });

  // Validates: Requirements 6.1
  // The generic active-mode stylesheet must stay site-independent: all
  // YouTube CSS selectors live in the adapter (via getActiveModeCss), not in
  // windowed-styles.ts. This guards against the site-CSS drifting back out of
  // the adapter.
  it("keeps the generic windowed stylesheet free of YouTube selectors", () => {
    const stylesSrc = readFileSync(
      resolve(PROJECT_ROOT, "src/content/windowed-styles.ts"),
      "utf8",
    );
    const siteSpecificSelectors = [
      "ytp-",
      "movie_player",
      "#masthead",
      "#secondary",
      "#comments",
      "html5-video",
      "ytd-watch",
    ];
    for (const selector of siteSpecificSelectors) {
      expect(stylesSrc).not.toContain(selector);
    }
  });
});
