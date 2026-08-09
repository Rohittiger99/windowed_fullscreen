// The side panel's availability check. No DOM, no browser.
//
// This exists because of a bug that only ever showed up with auto-apply on, on a
// reload: the mode engaged as soon as the player existed, YouTube mounted the
// below-video block several seconds later, and the comment button was injected
// but permanently inert for the rest of the session. The mode itself looked
// perfect, which is why nothing else caught it — the availability of the panel is
// a question about the page NOW, not about the page at the moment of entry.
import test from "node:test";
import assert from "node:assert/strict";

import { WindowedFullscreenController, type SiteDescriptor } from "../src/windowed-fullscreen.ts";

/**
 * The handful of DOM surfaces the controller actually touches. MutationObserver
 * is absent in Node, which the controller already treats as "no observer", so the
 * watchers simply do not start here.
 */
function stubDocument(): { doc: Document; classes: Set<string> } {
  const classes = new Set<string>();
  const classList = {
    add: (...names: string[]) => names.forEach((n) => classes.add(n)),
    remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
    contains: (name: string) => classes.has(name),
    toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
  };
  const doc = {
    documentElement: { classList },
    defaultView: {
      scrollX: 0,
      scrollY: 0,
      scrollTo: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      requestAnimationFrame: () => 0,
      dispatchEvent: () => true,
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { doc: doc as unknown as Document, classes };
}

/** An element with just enough surface for capture/restore and class tracking. */
function stubElement(): Element {
  const props = new Map<string, string>();
  return {
    isConnected: true,
    parentNode: null,
    style: {
      getPropertyValue: (p: string) => props.get(p) ?? "",
      setProperty: (p: string, v: string) => void props.set(p, v),
      removeProperty: (p: string) => void props.delete(p),
    },
    classList: { contains: () => false, add: () => {}, remove: () => {} },
  } as unknown as Element;
}

function descriptor(hasSideContent: () => boolean): SiteDescriptor {
  return {
    player: stubElement(),
    nativeFullscreenButton: stubElement(),
    hasSideContent,
    siteChromeElements: [],
    missingChromeSelectors: [],
    activePlayerClasses: [],
    keepPlayerClasses: false,
  };
}

test("the panel docks when the below-video block mounts AFTER the mode engaged", () => {
  const { doc, classes } = stubDocument();
  const controller = new WindowedFullscreenController(doc);

  // Auto-apply on a reload: the player is ready, the below-video block is not.
  let mounted = false;
  assert.equal(controller.enter(descriptor(() => mounted)), true);
  assert.equal(controller.setPanelOpen(true), false, "nothing to dock yet");

  // Seconds later, YouTube mounts it. The reader presses the comment button.
  mounted = true;
  assert.equal(controller.setPanelOpen(true), true);
  assert.equal(controller.isPanelOpen, true);
  assert.ok(classes.has("wfs-side-panel"));
});

test("the panel is refused while the page genuinely has nothing to dock", () => {
  const { doc, classes } = stubDocument();
  const controller = new WindowedFullscreenController(doc);

  controller.enter(descriptor(() => false));
  assert.equal(controller.setPanelOpen(true), false);
  assert.equal(controller.isPanelOpen, false);
  assert.ok(!classes.has("wfs-side-panel"));
});

test("the panel is refused while the mode is off, and closing it is always safe", () => {
  const { doc } = stubDocument();
  const controller = new WindowedFullscreenController(doc);

  // Every panel rule is nested under the active-mode class, so docking outside
  // the mode would set a class that styles nothing.
  assert.equal(controller.setPanelOpen(true), false);
  assert.equal(controller.togglePanel(), false);

  controller.enter(descriptor(() => true));
  assert.equal(controller.setPanelOpen(false), true, "already closed is not a failure");
});

test("exiting the mode undocks the panel", () => {
  const { doc, classes } = stubDocument();
  const controller = new WindowedFullscreenController(doc);

  controller.enter(descriptor(() => true));
  controller.setPanelOpen(true);
  controller.exit();

  assert.equal(controller.isPanelOpen, false);
  assert.ok(!classes.has("wfs-side-panel"));
  assert.ok(!classes.has("wfs-windowed"));
});
