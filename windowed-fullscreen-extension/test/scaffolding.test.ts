import { describe, expect, it } from "vitest";
import fc from "fast-check";

// Baseline test confirming the toolchain is wired up:
// - Vitest runs TypeScript tests
// - jsdom environment provides a DOM
// - fast-check is available for property-based tests
describe("scaffolding", () => {
  it("runs unit tests", () => {
    expect(1 + 1).toBe(2);
  });

  it("provides a jsdom DOM environment", () => {
    const el = document.createElement("div");
    el.textContent = "ok";
    document.body.appendChild(el);
    expect(document.body.querySelector("div")?.textContent).toBe("ok");
  });

  it("provides fast-check for property-based tests", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 },
    );
  });
});
