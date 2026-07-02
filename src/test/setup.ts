import "@testing-library/jest-dom/vitest";

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
