// Build script: bundles the MV3 extension surfaces with esbuild and assembles
// the loadable extension in dist/. Each MV3 surface (service worker, content
// script, options page, popup) is bundled as a self-contained file.
//
// Output format matters per surface:
// - The content script is injected by Chrome as a CLASSIC script, so it MUST be
//   an IIFE bundle. A top-level `export` (ESM) is a syntax error in that
//   context and would prevent the whole content script from running.
// - The service worker is declared `"type": "module"` in the manifest, and the
//   options/popup pages load their bundles via `<script type="module">`, so
//   those are emitted as ESM.
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "dist");
const watch = process.argv.includes("--watch");

/** ESM entry points -> output file (relative to dist). Paths must match manifest.json. */
const esmEntryPoints = {
  "background/service-worker": resolve(root, "src/background/service-worker.ts"),
  "options/main": resolve(root, "src/options/main.ts"),
  "popup/main": resolve(root, "src/popup/main.ts"),
};

/** @type {import("esbuild").BuildOptions} */
const commonOptions = {
  outdir,
  bundle: true,
  target: ["chrome116"],
  platform: "browser",
  sourcemap: true,
  logLevel: "info",
};

/** ESM surfaces: service worker (module SW) + options/popup module scripts. */
const esmOptions = {
  ...commonOptions,
  entryPoints: esmEntryPoints,
  format: "esm",
};

/**
 * Content script: must be a classic, self-contained IIFE (no ESM `export`).
 * `globalName` parks the module's exports on a harmless global instead of
 * emitting `export` statements.
 */
const contentOptions = {
  ...commonOptions,
  entryPoints: { "content/index": resolve(root, "src/content/index.ts") },
  format: "iife",
  globalName: "__wfsContent",
};

async function copyStatic() {
  // manifest + per-surface HTML and static assets.
  await cp(resolve(root, "manifest.json"), resolve(outdir, "manifest.json"));
  await cp(resolve(root, "public"), outdir, { recursive: true });
}

async function run() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  if (watch) {
    const esmCtx = await context(esmOptions);
    const contentCtx = await context(contentOptions);
    await esmCtx.watch();
    await contentCtx.watch();
    await copyStatic();
    console.log("[build] watching for changes...");
    return;
  }

  await Promise.all([build(esmOptions), build(contentOptions)]);
  await copyStatic();
  console.log("[build] extension emitted to dist/");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
