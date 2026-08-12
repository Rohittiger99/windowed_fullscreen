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
import { createStubDocument, type StubDocument } from "./support/dom.ts";
import { bool, forAll, type Gen, type Rng } from "./support/pbt.ts";

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

// Feature: fullscreen-exit-and-rating-footer, Property 5: Escape changes exactly one layer, and auto-repeat changes none
//
// Outside browser fullscreen there are two layers, not three: the side panel and
// the mode. The claim under test is that one press moves exactly one of them, and
// that a held key moves none — the bug this guards against is the auto-repeat
// cascade, where holding Escape closed the panel and then took the whole mode
// down with it before the reader let go.
//
// The document stub journals every write, which is what makes the no-op cases
// (R5.5, R5.6) assertable as "nothing was written at all" rather than only as
// "the classes look the same afterwards". A no-op that removed a class and put it
// back would pass the second and fail the first.

/** The two classes that are the two layers. Literals, as elsewhere in this file. */
const WINDOWED_CLASS = "wfs-windowed";
const PANEL_CLASS = "wfs-side-panel";

/** One generated `keydown`. `repeat` is the browser's auto-repeat flag. */
interface KeyPress {
  readonly key: string;
  readonly repeat: boolean;
}

/**
 * The keys worth mixing in. `Esc` is the legacy IE spelling and `esc` the wrong
 * case: both must miss, because the handler compares `e.key` exactly.
 */
const RUN_KEYS = ["Escape", "Esc", "esc", "Enter", " ", "a", "ArrowDown"] as const;

/** Shortest and longest generated run, per the property's stated generators. */
const MIN_RUN = 1;
const MAX_RUN = 10;

/**
 * A run of 1-10 keydowns. Hand-written rather than `arrayOf`, which starts at
 * length 0; `valid` keeps the harness's halving shrink from reporting an empty
 * run, which the property says nothing about.
 */
const keyRun: Gen<KeyPress[]> = {
  sample: (rng: Rng) => {
    const length = MIN_RUN + Math.floor(rng() * (MAX_RUN - MIN_RUN + 1));
    return Array.from({ length }, () => ({
      key: RUN_KEYS[Math.floor(rng() * RUN_KEYS.length)] as string,
      repeat: rng() < 0.5,
    }));
  },
  valid: (value: unknown) =>
    Array.isArray(value) &&
    value.length >= MIN_RUN &&
    value.length <= MAX_RUN &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as KeyPress).key === "string" &&
        typeof (entry as KeyPress).repeat === "boolean",
    ),
};

function propertyDescriptor(stub: StubDocument): SiteDescriptor {
  return {
    player: stub.createElement("div").asElement(),
    nativeFullscreenButton: stub.createElement("button").asElement(),
    // Always dockable, so the "panel open" half of the starting state is reachable.
    hasSideContent: () => true,
    siteChromeElements: [],
    missingChromeSelectors: [],
    activePlayerClasses: [],
    keepPlayerClasses: false,
  };
}

forAll(
  "Property 5: Escape changes exactly one layer, and auto-repeat changes none",
  [bool(), bool(), keyRun],
  (windowedOn: boolean, panelOpen: boolean, run: KeyPress[]) => {
    const stub = createStubDocument();
    const controller = new WindowedFullscreenController(stub.doc);

    // Four generated starting states over three reachable ones: the panel cannot
    // be open while the mode is off, because every panel rule is nested under the
    // active-mode class. Asking for it anyway is the point — that combination is
    // exactly the one a caller could get wrong.
    if (windowedOn) {
      assert.equal(controller.enter(propertyDescriptor(stub)), true, "the mode should engage");
      if (panelOpen) assert.equal(controller.setPanelOpen(true), true, "the panel should dock");
    }
    const layersAtStart = (windowedOn ? 1 : 0) + (windowedOn && panelOpen ? 1 : 0);

    let escapePresses = 0;
    let dismissals = 0;

    for (const [index, press] of run.entries()) {
      const where = `event ${index + 1} of ${run.length} (${JSON.stringify(press)})`;
      const before = stub.classes();
      // Time-box the write journal to this one event.
      stub.clearJournal();
      stub.fireDocument("keydown", { key: press.key, repeat: press.repeat });
      const after = stub.classes();

      const windowedChanged = before.has(WINDOWED_CLASS) !== after.has(WINDOWED_CLASS);
      const panelChanged = before.has(PANEL_CLASS) !== after.has(PANEL_CLASS);
      const layersChanged = (windowedChanged ? 1 : 0) + (panelChanged ? 1 : 0);

      // An Escape_Press is a keydown reporting `Escape` with auto-repeat false.
      const isPress = press.key === "Escape" && !press.repeat;
      if (isPress) escapePresses += 1;

      if (!isPress) {
        // R5.6: a repeated Escape dismisses nothing, and neither does any other
        // key. Nothing is written, so nothing can have been undone either.
        assert.equal(layersChanged, 0, `no layer should move on ${where}`);
        assert.equal(stub.writes.length, 0, `nothing should be written on ${where}`);
        continue;
      }

      if (!before.has(WINDOWED_CLASS)) {
        // R5.5: Escape on a plain page adds and removes no class, writes and
        // removes no inline property, and changes no scroll offset.
        assert.equal(stub.writes.length, 0, `Escape should be inert on ${where}`);
        assert.equal(layersChanged, 0, `no layer should move on ${where}`);
        continue;
      }

      // R5.7: exactly one layer moves, and the other is left as it was.
      assert.equal(layersChanged, 1, `exactly one layer should move on ${where}`);
      if (before.has(PANEL_CLASS)) {
        // R5.2: the panel closes and the mode stays.
        assert.ok(panelChanged, `the panel should be the layer that moved on ${where}`);
        assert.equal(after.has(PANEL_CLASS), false, `the panel should be undocked on ${where}`);
        assert.ok(after.has(WINDOWED_CLASS), `the mode should survive ${where}`);
      } else {
        // R5.3: with the panel already closed, the press leaves the mode.
        assert.ok(windowedChanged, `the mode should be the layer that moved on ${where}`);
        assert.equal(after.has(WINDOWED_CLASS), false, `the mode should be off after ${where}`);
        assert.equal(after.has(PANEL_CLASS), false, `no stale panel class after ${where}`);
      }
      dismissals += 1;
    }

    // The count, not just the per-press shape: a run of presses dismisses one
    // layer each until there are none left, so a held key cannot cascade and a
    // press after the last layer is gone cannot dismiss a layer that never was.
    assert.equal(
      dismissals,
      Math.min(escapePresses, layersAtStart),
      `${escapePresses} press(es) against ${layersAtStart} layer(s) should dismiss ${Math.min(
        escapePresses,
        layersAtStart,
      )}`,
    );
  },
);

// The controller's mode-end report.
//
// This exists because `Escape` leaves the mode from inside the controller, so §9
// never saw it: a reader who watched an hour in windowed mode and pressed Escape
// registered no use at all. The report is generic on purpose — it says the mode
// ended and nothing else — so what follows checks the signal, not what anyone
// counts with it.

test("the mode-end report fires once per leave, after the teardown, whatever ended it", () => {
  const stub = createStubDocument();
  const controller = new WindowedFullscreenController(stub.doc);

  let reports = 0;
  let activeWhenReported: boolean | null = null;
  let classPresentWhenReported: boolean | null = null;
  controller.setModeEndListener(() => {
    reports += 1;
    activeWhenReported = controller.isActive;
    classPresentWhenReported = stub.classes().has(WINDOWED_CLASS);
  });

  // Escape: the path the report was added for. The controller handles the key
  // itself and calls its own `exit()`, so nothing outside it is involved.
  assert.equal(controller.enter(propertyDescriptor(stub)), true);
  stub.fireDocument("keydown", { key: "Escape", repeat: false });
  assert.equal(reports, 1, "Escape should report the leave");
  assert.equal(activeWhenReported, false, "reported with the session already inactive");
  assert.equal(classPresentWhenReported, false, "reported with the page already restored");

  // R4.8: a duplicated teardown against an inactive controller changes nothing and
  // reports nothing, so one leave can never be counted twice.
  controller.exit();
  assert.equal(reports, 1, "an inactive exit() should report nothing");

  // A genuine second visit is a genuine second report.
  assert.equal(controller.enter(propertyDescriptor(stub)), true);
  controller.exit();
  assert.equal(reports, 2, "a second leave should report again");

  // Detached, so a session being torn down cannot report afterwards.
  controller.setModeEndListener(null);
  assert.equal(controller.enter(propertyDescriptor(stub)), true);
  controller.exit();
  assert.equal(reports, 2, "a detached listener should hear nothing");
});

test("a throwing mode-end listener cannot break the teardown", () => {
  const stub = createStubDocument();
  const controller = new WindowedFullscreenController(stub.doc);
  controller.setModeEndListener(() => {
    throw new Error("listener blew up");
  });

  // The report runs from an Escape keydown and from a MutationObserver callback in
  // production, both of which belong to the site. A throw must not surface there,
  // and the restore must stand whatever the listener does.
  assert.equal(controller.enter(propertyDescriptor(stub)), true);
  controller.exit();

  assert.equal(controller.isActive, false);
  assert.equal(stub.classes().has(WINDOWED_CLASS), false);
});
