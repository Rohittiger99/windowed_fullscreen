// A synthetic document for the tests that need one. No browser, no jsdom.
//
// jsdom would be the obvious tool and is deliberately not here: the project pins
// its dev dependencies to typescript, esbuild, @types/chrome and @types/node, and
// a test-only DOM implementation is not worth breaking that for. This stub is an
// extraction of the shape `tests/panel.test.ts` already builds inline, widened to
// the surface §7 (Controller) and §11 (Settings UI) actually touch: a
// `documentElement` with a `classList`, elements with inline style, attributes,
// `isConnected`, `appendChild`, a flat-registry `querySelector`, and the view's
// `scrollTo` / `scrollX` / `scrollY`.
//
// The load-bearing difference from an inline stub: every read and every write is
// appended to one ordered journal. That is what lets a test assert "no write
// happened at all" — the R1.7 and R1.8 no-op claims — rather than only "the final
// state is right", and what lets it check that the snapshot read of a property
// precedes the first write to it (R4.1).
//
// What it deliberately does not have: layout, computed style, and event bubbling.
// Anything that needs those belongs in `npm run verify:live`, not here. Events are
// delivered by calling the registered listener directly, via `fire` and
// `fireDocument`, so a test drives a click or an Escape press without the stub
// pretending to own a propagation model.

/** One entry in the ordered read/write journal. */
export interface JournalEntry {
  /** Sequence number, so ordering questions are answered without array indices. */
  readonly seq: number;
  /** Whether the entry observed state or changed it. */
  readonly kind: "read" | "write";
  /**
   * What happened. Stable strings so a test can filter:
   * `style.get`, `style.set`, `style.remove`, `style.cssText`,
   * `class.contains`, `class.add`, `class.remove`, `class.toggle`,
   * `attr.get`, `attr.set`, `attr.remove`, `prop.set`, `text.set`,
   * `child.append`, `child.replace`, `event.listen`, `event.dispatch`,
   * `scroll.read`, `scroll.write`.
   */
  readonly op: string;
  /** The element involved, or null for document- and view-level entries. */
  readonly target: StubElement | null;
  /** Property, class, attribute, or event name, where the op has one. */
  readonly name?: string;
  /** The value written, or the value a read returned. */
  readonly value?: string | null;
}

/** The journal, shared by a document and everything it created. */
class Journal {
  readonly entries: JournalEntry[] = [];

  record(
    kind: "read" | "write",
    op: string,
    target: StubElement | null,
    name?: string,
    value?: string | null,
  ): void {
    this.entries.push({ seq: this.entries.length, kind, op, target, name, value });
  }
}

/** `classList`, with `contains` recorded as a read so R4.1 ordering is checkable. */
export class StubClassList {
  private readonly names = new Set<string>();
  // Written out rather than declared as constructor parameter properties: Node
  // runs these files by stripping types only, and it rejects that shorthand.
  private readonly journal: Journal;
  private readonly owner: StubElement;

  constructor(journal: Journal, owner: StubElement) {
    this.journal = journal;
    this.owner = owner;
  }

  add(...names: string[]): void {
    for (const name of names) {
      this.names.add(name);
      this.journal.record("write", "class.add", this.owner, name);
    }
  }

  remove(...names: string[]): void {
    for (const name of names) {
      this.names.delete(name);
      this.journal.record("write", "class.remove", this.owner, name);
    }
  }

  contains(name: string): boolean {
    const present = this.names.has(name);
    this.journal.record("read", "class.contains", this.owner, name, present ? "true" : "false");
    return present;
  }

  /** The two-argument form is the one §7 uses; the one-argument form flips. */
  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.names.has(name);
    if (on) this.names.add(name);
    else this.names.delete(name);
    this.journal.record("write", "class.toggle", this.owner, name, on ? "true" : "false");
    return on;
  }

  /** Test-side view. Reading this does not touch the journal. */
  snapshot(): Set<string> {
    return new Set(this.names);
  }

  get length(): number {
    return this.names.size;
  }
}

/**
 * Inline style. Kebab-case properties only, which is what §7 uses via
 * `setProperty` / `getPropertyValue`; an unset property reads back as `""`, as it
 * does in a browser, so the controller's "unset versus set" distinction is tested
 * against the same signal it sees in production.
 */
export class StubStyle {
  private readonly props = new Map<string, string>();
  private text = "";
  private readonly journal: Journal;
  private readonly owner: StubElement;

  constructor(journal: Journal, owner: StubElement) {
    this.journal = journal;
    this.owner = owner;
  }

  getPropertyValue(prop: string): string {
    const value = this.props.get(prop) ?? "";
    this.journal.record("read", "style.get", this.owner, prop, value);
    return value;
  }

  setProperty(prop: string, value: string): void {
    this.props.set(prop, value);
    this.journal.record("write", "style.set", this.owner, prop, value);
  }

  removeProperty(prop: string): string {
    const previous = this.props.get(prop) ?? "";
    this.props.delete(prop);
    this.journal.record("write", "style.remove", this.owner, prop, previous);
    return previous;
  }

  /** §11 sets the footer's style in one string; treated as one opaque write. */
  get cssText(): string {
    return this.text;
  }

  set cssText(value: string) {
    this.text = value;
    this.journal.record("write", "style.cssText", this.owner, undefined, value);
  }

  /** Test-side view: the inline properties actually present, unrecorded. */
  snapshot(): Map<string, string> {
    return new Map(this.props);
  }
}

/**
 * An element with just enough surface for the controller's capture/restore and
 * for the settings renderers. `isConnected` is a plain flag rather than something
 * derived from the tree, because the case worth testing (R4.7) is an element the
 * page tore out from under us, which no amount of tree bookkeeping here would
 * model more faithfully. Use {@link StubElement.detach} to produce it.
 */
export class StubElement {
  readonly classList: StubClassList;
  readonly style: StubStyle;
  readonly children: StubElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  isConnected = true;
  parentNode: StubElement | null = null;
  readonly tagName: string;
  private text = "";
  private readonly journal: Journal;
  private readonly owner: StubDocument | null;

  constructor(journal: Journal, tagName: string, owner: StubDocument | null) {
    this.journal = journal;
    this.tagName = tagName;
    this.owner = owner;
    this.classList = new StubClassList(journal, this);
    this.style = new StubStyle(journal, this);
  }

  get ownerDocument(): Document | null {
    return this.owner ? this.owner.doc : null;
  }

  get textContent(): string {
    // Matches the browser closely enough for the copy assertions: a parent reads
    // back as its own text plus its descendants'.
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    this.children.length = 0;
    this.journal.record("write", "text.set", this, undefined, value);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    this.journal.record("write", "attr.set", this, name, value);
  }

  getAttribute(name: string): string | null {
    const value = this.attributes.get(name) ?? null;
    this.journal.record("read", "attr.get", this, name, value);
    return value;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    this.journal.record("write", "attr.remove", this, name);
  }

  appendChild(child: StubElement): StubElement {
    child.parentNode = this;
    this.children.push(child);
    this.journal.record("write", "child.append", this, child.tagName);
    return child;
  }

  insertBefore(child: StubElement, referenceNode: StubElement | null): StubElement {
    child.parentNode = this;
    const index = referenceNode ? this.children.indexOf(referenceNode) : -1;
    if (index >= 0) {
      this.children.splice(index, 0, child);
    } else {
      this.children.push(child);
    }
    this.journal.record("write", "child.append", this, child.tagName);
    return child;
  }

  append(...nodes: StubElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes: StubElement[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.journal.record("write", "child.replace", this, undefined, String(nodes.length));
    for (const node of nodes) this.appendChild(node);
  }

  remove(): void {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentNode = null;
    this.journal.record("write", "child.remove", parent, this.tagName);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
    this.journal.record("write", "event.listen", this, type);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (!existing) return;
    const index = existing.indexOf(handler);
    if (index >= 0) existing.splice(index, 1);
  }

  focus(): void {
    this.journal.record("write", "focus", this);
  }

  /**
   * A property §11 assigns directly rather than through `setAttribute` — `type`,
   * `href`, `rel`, `target`, `checked`, `className`. Those land as ordinary own
   * fields on the instance, so this is the read side of them. They are not
   * journalled: the production code types them against the real DOM interfaces,
   * and intercepting each one would mean declaring a fake of every HTML element.
   */
  prop<T>(name: string): T | undefined {
    return (this as unknown as Record<string, T>)[name];
  }

  /** Flat-registry lookup, scoped to this element's descendants. */
  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): StubElement[] {
    return descendants(this).filter((el) => matchesSelector(el, selector));
  }

  contains(other: StubElement): boolean {
    return other === this || descendants(this).includes(other);
  }

  /** Mark this element and everything under it as torn out of the document. */
  detach(): void {
    this.isConnected = false;
    for (const child of descendants(this)) child.isConnected = false;
  }

  /** Cast for handing the element to production code that wants an `Element`. */
  asElement(): Element {
    return this as unknown as Element;
  }
}

/** Every descendant of `root`, in document order. Journal-free. */
function descendants(root: StubElement): StubElement[] {
  const out: StubElement[] = [];
  const walk = (node: StubElement): void => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * The selector subset the tests need: `*`, a tag name, `#id`, `.class`,
 * `[attr]`, `[attr="value"]`, and a comma-separated list of those. No combinators
 * — the registry is flat by design, and every lookup in §11 is a marker-attribute
 * lookup. A selector outside the subset throws rather than quietly matching
 * nothing, because a silent no-match reads exactly like a real bug.
 */
function matchesSelector(el: StubElement, selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .some((part) => matchesSimple(el, part));
}

function matchesSimple(el: StubElement, selector: string): boolean {
  if (selector === "*") return true;

  if (selector.startsWith("#")) {
    return (el.attributes.get("id") ?? el.prop<string>("id")) === selector.slice(1);
  }
  if (selector.startsWith(".")) {
    return el.classList.snapshot().has(selector.slice(1));
  }
  if (selector.startsWith("[") && selector.endsWith("]")) {
    const body = selector.slice(1, -1);
    const eq = body.indexOf("=");
    if (eq === -1) return el.attributes.has(body);
    const name = body.slice(0, eq);
    const raw = body.slice(eq + 1);
    const value = raw.replace(/^["']|["']$/g, "");
    return el.attributes.get(name) === value;
  }
  if (/^[a-z][a-z0-9-]*$/i.test(selector)) {
    return el.tagName.toLowerCase() === selector.toLowerCase();
  }
  // Support compound selectors like tag[attr="value"], tag.class, :is(...)
  if (selector.startsWith(":is(") && selector.endsWith(")")) {
    const inner = selector.slice(4, -1);
    return matchesSelector(el, inner);
  }
  const match = selector.match(/^([a-z][a-z0-9-]*)?((?:\[[^\]]+\]|\.[a-z0-9-_]+|#[a-z0-9-_]+)+)$/i);
  if (match) {
    const tag = match[1];
    if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const parts = match[2].match(/\[[^\]]+\]|\.[a-z0-9-_]+|#[a-z0-9-_]+/gi) ?? [];
    return parts.every((part) => matchesSimple(el, part));
  }
  throw new Error(`stub querySelector: unsupported selector ${JSON.stringify(selector)}`);
}

/** A pending `setTimeout` callback. */
interface PendingTimer {
  readonly id: number;
  readonly delay: number;
  readonly fn: () => void;
}

/**
 * The view. Scroll offsets are journalled on both sides so a test can prove the
 * snapshot read happened before any write (R4.1) and that a no-op path wrote no
 * offset at all (R1.7). Timers and frames are queued rather than run, so a test
 * decides when the controller's deferred work happens.
 */
export class StubView {
  private x = 0;
  private y = 0;
  private nextTimerId = 1;
  private timers: PendingTimer[] = [];
  private frames: Array<() => void> = [];

  /** Synthetic `resize` events the controller's reflow nudge dispatched. */
  readonly dispatched: string[] = [];

  /** Stand-in for `window.Event`, which §7's reflow nudge constructs off the view. */
  readonly Event = class {
    readonly type: string;
    constructor(type: string) {
      this.type = type;
    }
  };

  private readonly journal: Journal;

  constructor(journal: Journal) {
    this.journal = journal;
  }

  get scrollX(): number {
    this.journal.record("read", "scroll.read", null, "x", String(this.x));
    return this.x;
  }

  get scrollY(): number {
    this.journal.record("read", "scroll.read", null, "y", String(this.y));
    return this.y;
  }

  scrollTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.journal.record("write", "scroll.write", null, undefined, `${x},${y}`);
  }

  setTimeout(fn: () => void, delay = 0): number {
    const id = this.nextTimerId++;
    this.timers.push({ id, delay, fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }

  requestAnimationFrame(fn: () => void): number {
    this.frames.push(fn);
    return this.frames.length;
  }

  dispatchEvent(event: unknown): boolean {
    const type = (event as { type?: string } | null)?.type ?? "unknown";
    this.dispatched.push(type);
    this.journal.record("write", "event.dispatch", null, type);
    return true;
  }

  /** Set the reading position without journalling it, to arrange a test. */
  setScroll(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  /** The current offsets, unrecorded. */
  position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  pendingTimerCount(): number {
    return this.timers.length;
  }

  pendingFrameCount(): number {
    return this.frames.length;
  }

  /**
   * Run every queued frame callback, including ones queued while running — the
   * scroll restore in `exit()` is one frame deep. Bounded, so a callback that
   * re-queues itself forever fails the test instead of hanging the suite.
   */
  flushAnimationFrames(): void {
    for (let round = 0; round < 100 && this.frames.length > 0; round += 1) {
      const due = this.frames;
      this.frames = [];
      for (const fn of due) fn();
    }
    if (this.frames.length > 0) throw new Error("stub view: animation frames never settled");
  }

  /** Run every queued timer, soonest first. Same bound, same reason. */
  flushTimers(): void {
    for (let round = 0; round < 100 && this.timers.length > 0; round += 1) {
      const due = [...this.timers].sort((a, b) => a.delay - b.delay);
      this.timers = [];
      for (const timer of due) timer.fn();
    }
    if (this.timers.length > 0) throw new Error("stub view: timers never settled");
  }
}

/**
 * The document. `doc` is the cast the production code receives; every other
 * member is the test's own handle on what that code did.
 */
export class StubDocument {
  private readonly journal = new Journal();
  readonly view: StubView;
  readonly documentElement: StubElement;
  /**
   * Every element this document created, in creation order. `querySelector` walks
   * it rather than the tree, so a control found by its marker attribute is found
   * whether or not the renderer has attached it yet.
   */
  readonly registry: StubElement[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor() {
    this.view = new StubView(this.journal);
    this.documentElement = new StubElement(this.journal, "html", this);
  }

  /** The handle the production code takes. */
  get doc(): Document {
    return this as unknown as Document;
  }

  get defaultView(): Window {
    return this.view as unknown as Window;
  }

  createElement(tagName: string): StubElement {
    const el = new StubElement(this.journal, tagName, this);
    this.registry.push(el);
    return el;
  }

  /** Text nodes are elements with the tag `#text`; nothing here needs more. */
  createTextNode(text: string): StubElement {
    const node = this.createElement("#text");
    node.textContent = text;
    return node;
  }

  getElementById(id: string): StubElement | null {
    return this.querySelector(`#${id}`);
  }

  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): StubElement[] {
    return this.registry.filter((el) => matchesSelector(el, selector));
  }

  contains(el: StubElement): boolean {
    return this.documentElement.contains(el);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
    this.journal.record("write", "event.listen", null, type);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (!existing) return;
    const index = existing.indexOf(handler);
    if (index >= 0) existing.splice(index, 1);
  }

  // --- The test's side -----------------------------------------------------

  /** Everything recorded, oldest first. */
  get entries(): readonly JournalEntry[] {
    return this.journal.entries;
  }

  /** Only the entries that changed something. `writes.length === 0` is R1.7. */
  get writes(): readonly JournalEntry[] {
    return this.journal.entries.filter((entry) => entry.kind === "write");
  }

  get reads(): readonly JournalEntry[] {
    return this.journal.entries.filter((entry) => entry.kind === "read");
  }

  /** The classes currently on the document element, unrecorded. */
  classes(): Set<string> {
    return this.documentElement.classList.snapshot();
  }

  /**
   * Drop the journal, keeping the tree. Used to time-box an assertion to one
   * operation — arrange with `enter()`, clear, then measure `exit()`.
   */
  clearJournal(): void {
    this.journal.entries.length = 0;
  }

  /**
   * Deliver an event straight to the element's own listeners for `type`. No
   * bubbling and no capture: the stub has no propagation model, and pretending to
   * would be the one thing here that could be wrong in a way a test believes.
   */
  fire(target: StubElement, type: string, event: Record<string, unknown> = {}): void {
    const payload = { type, target, preventDefault: () => {}, stopPropagation: () => {}, ...event };
    for (const handler of [...(target.listeners.get(type) ?? [])]) handler(payload);
  }

  /** The same, for the document-level listeners §7 registers (`keydown`). */
  fireDocument(type: string, event: Record<string, unknown> = {}): void {
    const payload = {
      type,
      target: this.documentElement,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...event,
    };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(payload);
  }

  /**
   * Whether an inline property was read before it was first written — the
   * "snapshot precedes the first mutation" claim of R4.1, stated so a test can
   * assert it rather than trusting the order of the source.
   *
   * A property that was never written passes: nothing was mutated, so nothing
   * needed capturing first. A property written without ever being read fails.
   */
  readPrecededFirstWrite(target: StubElement, prop: string): boolean {
    const firstWrite = this.journal.entries.find(
      (entry) =>
        entry.kind === "write" &&
        entry.target === target &&
        (entry.op === "style.set" || entry.op === "style.remove") &&
        entry.name === prop,
    );
    if (!firstWrite) return true;
    return this.journal.entries.some(
      (entry) =>
        entry.kind === "read" &&
        entry.target === target &&
        entry.op === "style.get" &&
        entry.name === prop &&
        entry.seq < firstWrite.seq,
    );
  }

  /** The same question for a class on the document element. */
  classReadPrecededFirstWrite(name: string): boolean {
    const firstWrite = this.journal.entries.find(
      (entry) =>
        entry.kind === "write" &&
        entry.target === this.documentElement &&
        entry.name === name &&
        (entry.op === "class.add" || entry.op === "class.remove" || entry.op === "class.toggle"),
    );
    if (!firstWrite) return true;
    return this.journal.entries.some(
      (entry) =>
        entry.kind === "read" &&
        entry.op === "class.contains" &&
        entry.target === this.documentElement &&
        entry.name === name &&
        entry.seq < firstWrite.seq,
    );
  }
}

/**
 * A fresh document with an empty journal. Elements come from
 * {@link StubDocument.createElement}, so everything a test builds shares the one
 * journal and the one registry.
 */
export function createStubDocument(): StubDocument {
  return new StubDocument();
}
