// The structure `renderSettings` builds, and the one arrangement in it that was a
// bug. Stub document, no browser.
//
// The bug: the rating prompt mounted into `[data-wfs-footer-host]`, the same node
// the rating footer repaints by replacing all of its children. The prompt writes the
// Rating_State to record the answer, `storage.onChanged` fires in the writing
// context too, and the footer repainted straight over the prompt. Back then the
// write happened on mount, so it spent a lifetime ask on something the reader never
// got to see; the write moved to the answer, which would instead pull the row out
// from under the press. Nothing caught it because nothing rendered these two
// together.
import test from "node:test";
import assert from "node:assert/strict";

import { createStubDocument, type StubDocument, type StubElement } from "./support/dom.ts";
import {
  MAX_RATING_PROMPTS,
  RATING_KEY,
  renderRatingPrompt,
  renderSettings,
  type RatingState,
} from "../src/windowed-fullscreen.ts";

type Store = Record<string, unknown>;

/**
 * The minimum browser surface `renderSettings` touches synchronously: a storage
 * area for the preference reads, and nothing else. `chrome.commands` is absent on
 * purpose — the shortcut lookup is wrapped in a `try`, so its absence exercises
 * the "no combination to print" path rather than breaking the render.
 */
function fakeChrome(initial: Store = {}): Store {
  const data: Store = { ...initial };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {},
    storage: {
      local: {
        get: async (keys: string[]) => {
          const out: Store = {};
          for (const key of keys) if (key in data) out[key] = data[key];
          return out;
        },
        set: async (items: Store) => {
          Object.assign(data, items);
        },
      },
    },
  };
  return data;
}

/**
 * Render the settings tree into a fresh stub document and hand back the document,
 * the tree, and the backing store, so a test can ask what was persisted.
 *
 * The `options` surface, because it is the one with the tab strip: the regions
 * these tests are about sit outside both panels, and building the shape that has
 * panels is the only way to prove they stayed outside them.
 */
function render(): { doc: StubDocument; root: StubElement; store: Store } {
  const store = fakeChrome();
  const doc = createStubDocument();
  const root = doc.createElement("div");
  renderSettings(doc as unknown as Document, root as unknown as Element, {
    surface: "options",
  });
  return { doc, root, store };
}

/**
 * Let the renderers' storage round trips finish. Everything here resolves on the
 * microtask queue — the fake storage area is `async` with no timers — so a handful
 * of macrotask turns is more than enough and costs nothing.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((done) => setImmediate(done));
}

test("the rating prompt and the rating footer get separate hosts", () => {
  const { root } = render();

  const promptHost = root.querySelector("[data-wfs-prompt-host]");
  const footerHost = root.querySelector("[data-wfs-footer-host]");

  assert.ok(promptHost, "no [data-wfs-prompt-host] — the popup has nowhere safe to mount");
  assert.ok(footerHost, "no [data-wfs-footer-host]");
  // The whole fix, in one line. If these are ever the same node again, the footer
  // owns the prompt's subtree and will delete it on its next repaint.
  assert.notEqual(promptHost, footerHost, "the prompt host is the footer host again");
});

test("a footer repaint cannot touch the prompt", () => {
  // The mechanism, end to end: mount a prompt in its own host, then do what the
  // footer does on every Rating_State change and check the prompt survived.
  const { doc, root } = render();

  const promptHost = root.querySelector("[data-wfs-prompt-host]")!;
  const footerHost = root.querySelector("[data-wfs-footer-host]")!;

  renderRatingPrompt(doc as unknown as Document, promptHost as unknown as Element, {
    showError: () => {},
  });
  assert.ok(promptHost.querySelector("[data-wfs-prompt]"), "the prompt did not mount");

  // `renderRatingFooter`'s paint opens with exactly this.
  footerHost.replaceChildren();

  assert.ok(
    promptHost.querySelector("[data-wfs-prompt]"),
    "a footer repaint destroyed the prompt",
  );
});

test("the prompt offers a real answer either way, not two ways of postponing itself", () => {
  // The complaint that produced this shape: "Enjoying it?" over "Maybe later" and
  // "Don't ask again" answered nothing. Someone enjoying it could not say so and
  // someone who was not had nowhere to report it, so the only two things the prompt
  // could do were postpone itself and delete itself.
  const { doc, root } = render();
  const promptHost = root.querySelector("[data-wfs-prompt-host]")!;

  renderRatingPrompt(doc as unknown as Document, promptHost as unknown as Element, {
    showError: () => {},
  });

  const rate = promptHost.querySelector("[data-wfs-prompt-rate]");
  const feedback = promptHost.querySelector("[data-wfs-prompt-feedback]");
  const dismiss = promptHost.querySelector("[data-wfs-prompt-dismiss]");
  assert.ok(rate, "no way to say yes");
  assert.ok(feedback, "no way to say what is wrong");
  assert.ok(dismiss, "no way to decline");

  // Real links, so middle-click and "open in new tab" work, and opened with
  // `noopener` so the destination gets no handle back to the extension page.
  for (const link of [rate!, feedback!]) {
    assert.equal(link.tagName.toLowerCase(), "a");
    assert.match(link.attributes.get("href") ?? "", /^https:\/\//);
    assert.equal(link.attributes.get("target"), "_blank");
    assert.match(link.attributes.get("rel") ?? "", /\bnoopener\b/);
  }

  // Different destinations, or one of the two answers goes nowhere useful.
  assert.notEqual(rate!.attributes.get("href"), feedback!.attributes.get("href"));

  // Declining is an answer: it records one and clears the row. The removal is
  // unconditional, so a rejected write cannot leave the prompt standing after the
  // reader has said no.
  doc.fire(dismiss!, "click");
  assert.equal(promptHost.querySelector("[data-wfs-prompt]"), null, "declining left the prompt");
});

test("closing the popup is not an answer: only a control spends the one lifetime ask", async () => {
  // The bug this fixes: `resolved` was written on mount, so the single ask was
  // spent by whoever opened the popup to flip a checkbox. The row was gone at the
  // next opening and the question had been put to nobody. There is exactly one
  // showing to spend, so it has to be spent on an answer.
  const { doc, root, store } = render();
  const promptHost = root.querySelector("[data-wfs-prompt-host]")!;

  renderRatingPrompt(doc as unknown as Document, promptHost as unknown as Element, {
    showError: () => {},
  });
  await settle();

  // Mounting reads the record so the answer can be one write; it must not write.
  assert.equal(
    store[RATING_KEY],
    undefined,
    "the prompt recorded a showing before anyone answered it",
  );

  // Taking a destination is an answer. Asserted on the link rather than the
  // dismiss button because it is the delicate half: the popup dies when the tab
  // opens, so the write has to be dispatched from inside the handler.
  const rate = promptHost.querySelector("[data-wfs-prompt-rate]")!;
  doc.fire(rate, "click");
  await settle();

  const state = store[RATING_KEY] as RatingState | undefined;
  assert.ok(state, "answering recorded nothing, so the prompt will come back");
  // Both guards, so gate 5 of `ratingPromptDue` still closes the question if only
  // one of the two survives.
  assert.equal(state!.resolved, true, "`resolved` was not written");
  assert.equal(state!.promptsShown, MAX_RATING_PROMPTS, "the showing was not counted");
});

test("both rating destinations are offered to everyone, with no sentiment step in front", () => {
  // The guard against review gating, which is a store-removal offence rather than a
  // warning: routing happy readers to the public review page and unhappy ones to a
  // private form makes the visible score a filtered number. Both links appear on the
  // one showing, so there is no question whose answer decides which one you get.
  //
  // Concretely: no control in the prompt may be a yes/no that reveals a link later.
  // Every action present must already be either a link or the dismiss button.
  const { doc, root } = render();
  const promptHost = root.querySelector("[data-wfs-prompt-host]")!;

  renderRatingPrompt(doc as unknown as Document, promptHost as unknown as Element, {
    showError: () => {},
  });

  const prompt = promptHost.querySelector("[data-wfs-prompt]")!;
  const controls = prompt.querySelectorAll("a").concat(prompt.querySelectorAll("button"));
  assert.equal(controls.length, 3, "the prompt grew a control that is neither answer nor dismiss");

  const dismissable = prompt.querySelectorAll("button");
  assert.equal(dismissable.length, 1, "more than one non-link control — is this a yes/no step?");
});

test("the settings tree keeps its documented order: status, error, prompt, footer", () => {
  // The prompt host sits directly above the footer and below the two message
  // regions, so a prompt never pushes the thing it is talking about off screen.
  const { root } = render();

  const order = ["data-wfs-status", "data-wfs-error", "data-wfs-prompt-host", "data-wfs-footer-host"];
  const positions = order.map((marker) => {
    const el = root.querySelector(`[${marker}]`);
    assert.ok(el, `missing [${marker}]`);
    const index = root.children.indexOf(el!);
    assert.ok(index >= 0, `[${marker}] is not a direct child of the settings root`);
    return index;
  });

  for (let i = 1; i < positions.length; i++) {
    assert.ok(
      positions[i] > positions[i - 1],
      `[${order[i]}] is not after [${order[i - 1]}]`,
    );
  }
});

test("every site toggle names itself", () => {
  const { root } = render();

  // WCAG 2.5.3: where a toggle overrides its visible label, the announced name has
  // to contain that label, or a voice-control user saying what they can see misses.
  const scrollable = root.querySelector("[data-wfs-scrollable]");
  assert.ok(scrollable, "no scrollable-mode toggle");
  const ariaLabel = scrollable!.attributes.get("aria-label");
  if (ariaLabel !== undefined) {
    assert.ok(
      ariaLabel.includes("Scrollable mode"),
      `accessible name drops the visible label: ${JSON.stringify(ariaLabel)}`,
    );
  }

  // Where a hint exists beneath a checkbox, it is associated with aria-describedby.
  const describedBy = scrollable!.attributes.get("aria-describedby");
  if (describedBy) {
    const hint = root.querySelector(`#${describedBy}`);
    assert.ok(hint, `aria-describedby points at #${describedBy}, which does not exist`);
    assert.ok((hint!.textContent ?? "").length > 0, "the hint it points at is empty");
  }
});
