import "@testing-library/jest-dom/vitest";

if (!("randomUUID" in crypto)) {
  let counter = 0;
  Object.defineProperty(crypto, "randomUUID", {
    value: () => `test-uuid-${++counter}`,
  });
}
