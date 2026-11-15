/// <reference types="vitest/jsdom" />
import "@testing-library/jest-dom/vitest";

// Use browser storage rather than Node's process-wide storage in DOM tests.
Object.defineProperty(window, "localStorage", {
  value: jsdom.window.localStorage,
  configurable: true,
});

Object.defineProperty(navigator, "language", {
  value: "en-US",
  configurable: true,
});

if (!("randomUUID" in crypto)) {
  let counter = 0;
  Object.defineProperty(crypto, "randomUUID", {
    value: () => `test-uuid-${++counter}`,
  });
}
