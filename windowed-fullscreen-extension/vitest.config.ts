import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DOM-dependent logic (injector, controller) is tested against a simulated DOM.
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    // Property-based tests (fast-check) can run many iterations; give them room.
    testTimeout: 20_000,
  },
});
