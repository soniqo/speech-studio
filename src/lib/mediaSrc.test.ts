import { describe, expect, it, vi } from "vitest";
import { mediaFileSrc } from "./mediaSrc";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

describe("mediaFileSrc", () => {
  it("appends a media version query for regenerated takes", () => {
    expect(mediaFileSrc("/tmp/render.wav", "take 1")).toBe(
      "asset:///tmp/render.wav?v=take%201",
    );
  });

  it("preserves unversioned URLs when no version is supplied", () => {
    expect(mediaFileSrc("/tmp/render.wav")).toBe("asset:///tmp/render.wav");
  });
});
