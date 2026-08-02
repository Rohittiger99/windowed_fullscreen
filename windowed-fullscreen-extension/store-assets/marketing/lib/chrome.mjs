/**
 * Minimal headless-Chrome driver over the DevTools protocol.
 *
 * Shared by `render.mjs` (store assets, flattened to opaque PNG) and
 * `icons.mjs` (extension icons, which must keep their alpha channel).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  join(process.env.ProgramFiles ?? "", "Google/Chrome/Application/chrome.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => p && existsSync(p));
  if (!found) {
    throw new Error(
      "Could not find a Chrome executable. Set CHROME_PATH to point at one.",
    );
  }
  return found;
}

/**
 * Launch headless Chrome with remote debugging and resolve its WebSocket URL.
 *
 * Each launch gets its own profile directory. Sharing one makes Chrome fail to
 * acquire the profile lock and exit with code 21 whenever two of these scripts
 * run back to back, since the previous instance has not finished releasing it.
 *
 * Returns a `dispose()` that stops Chrome and removes its profile.
 */
export async function launchChrome() {
  const executable = process.env.CHROME_PATH ?? findChrome();
  const userDataDir = join(
    HERE,
    "..",
    ".chrome-profile",
    `${process.pid}-${Date.now().toString(36)}`,
  );
  mkdirSync(userDataDir, { recursive: true });

  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const wsUrl = await new Promise((resolvePromise, rejectPromise) => {
    let buffered = "";
    const timer = setTimeout(
      () => rejectPromise(new Error("Chrome did not report a debugger URL in time")),
      20_000,
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      buffered += text;
      const match = buffered.match(/ws:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[0]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Chrome exited early (code ${code})`));
    });
  });

  const dispose = () => {
    child.kill();
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A locked profile file is harmless: the directory is gitignored.
    }
  };

  return { child, wsUrl, dispose };
}

/** Thin CDP client: send a command, await its matching reply. */
export class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.#pending.has(message.id)) {
        const { resolve: ok, reject: fail } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        message.error ? fail(new Error(message.error.message)) : ok(message.result);
      }
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((ok, fail) => {
      socket.addEventListener("open", ok, { once: true });
      socket.addEventListener("error", () => fail(new Error("CDP socket failed")), {
        once: true,
      });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#socket.send(JSON.stringify(payload));
    return new Promise((ok, fail) => this.#pending.set(id, { resolve: ok, reject: fail }));
  }

  /** Open a fresh page target and return its attached session id. */
  async newPage() {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await this.send("Page.enable", {}, sessionId);
    return { targetId, sessionId };
  }

  close() {
    this.#socket.close();
  }
}

/** Wait until the page reports a completed load and two animation frames pass. */
export async function waitForPaint(cdp, sessionId) {
  await cdp.send(
    "Runtime.evaluate",
    {
      awaitPromise: true,
      expression: `
        (async () => {
          if (document.readyState !== "complete") {
            await new Promise((r) => window.addEventListener("load", r, { once: true }));
          }
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
          await Promise.all(
            [...document.images].map((img) =>
              img.complete
                ? null
                : new Promise((r) => {
                    img.addEventListener("load", r, { once: true });
                    img.addEventListener("error", r, { once: true });
                  }),
            ),
          );
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        })()
      `,
    },
    sessionId,
  );
}

/**
 * Screenshot a document at `width x height` logical pixels.
 *
 * Pass `transparent: true` to clear Chrome's default white backdrop so the
 * capture keeps an alpha channel — needed for extension icons, which require
 * transparent padding.
 */
export async function shoot(
  cdp,
  sessionId,
  url,
  width,
  height,
  scale,
  { transparent = false } = {},
) {
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: scale, mobile: false },
    sessionId,
  );
  if (transparent) {
    await cdp.send(
      "Emulation.setDefaultBackgroundColorOverride",
      { color: { r: 0, g: 0, b: 0, a: 0 } },
      sessionId,
    );
  }
  await cdp.send("Page.navigate", { url }, sessionId);
  await waitForPaint(cdp, sessionId);
  const { data } = await cdp.send(
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height, scale },
    },
    sessionId,
  );
  return Buffer.from(data, "base64");
}
