// Build: bundle the single source file once per Manifest V3 surface and
// assemble a loadable extension in `extension/`.
//
// All the code lives in `src/windowed-fullscreen.ts`. Rather than keeping four
// near-empty entry files around just to satisfy the manifest, each surface is
// built from a synthesized one-line entry that calls its exported start
// function. esbuild then tree-shakes everything that surface does not reach, so
// the popup bundle carries no content-script code and vice versa.
//
// Output format is not a free choice:
// - The content script is injected by Chrome as a CLASSIC script, so it must be
//   an IIFE. A top-level `export` is a syntax error in that context and would
//   stop the entire content script from running.
// - The service worker is declared `"type": "module"`, and the options/popup
//   pages load their bundles with `<script type="module">`, so those are ESM.
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "extension");
const source = resolve(root, "src/windowed-fullscreen.ts");
const watch = process.argv.includes("--watch");

// Source maps make DevTools stack traces readable, but they bloat the upload and
// expose the full source, so they are dev-only and never reach the store zip.
const sourcemap = watch;

/** One bundle per surface: the exported entry function and where it lands. */
const surfaces = [
  { start: "startContentScript", outfile: "content/index.js", format: "iife" },
  { start: "startServiceWorker", outfile: "background/service-worker.js", format: "esm" },
  { start: "startOptionsPage", outfile: "options/main.js", format: "esm" },
  { start: "startPopup", outfile: "popup/main.js", format: "esm" },
];

/** @returns {import("esbuild").BuildOptions} */
function optionsFor({ start, outfile, format }) {
  return {
    stdin: {
      contents: `import { ${start} } from "./src/windowed-fullscreen";\n${start}();\n`,
      // Resolved relative to the project root so the import above finds the
      // source file, and loaded as TS so esbuild applies the right pipeline.
      resolveDir: root,
      sourcefile: `${start}-entry.ts`,
      loader: "ts",
    },
    outfile: resolve(outdir, outfile),
    bundle: true,
    format,
    target: ["chrome116"],
    platform: "browser",
    sourcemap,
    logLevel: "info",
  };
}

/** Copy the manifest plus the static HTML and icons. */
async function copyStatic() {
  await cp(resolve(root, "manifest.json"), resolve(outdir, "manifest.json"));
  await cp(resolve(root, "public"), outdir, { recursive: true });
}

async function run() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  if (watch) {
    for (const surface of surfaces) {
      const ctx = await context(optionsFor(surface));
      await ctx.watch();
    }
    await copyStatic();
    console.log("[build] watching for changes...");
    return;
  }

  await Promise.all(surfaces.map((surface) => build(optionsFor(surface))));
  await copyStatic();
  console.log(`[build] extension emitted to ${outdir}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
