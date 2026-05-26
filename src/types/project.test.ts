import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_DURATION_SEC, EMOTION_TAGS, emptyProject, wrapTag } from "./project";
import { newClip } from "../state/projectStore";

describe("wrapTag", () => {
  it("wraps text in the given emotion tag", () => {
    expect(wrapTag("hello", "excited")).toBe("<excited>hello</excited>");
  });

  it("supports every declared emotion tag", () => {
    for (const tag of EMOTION_TAGS) {
      expect(wrapTag("x", tag)).toBe(`<${tag}>x</${tag}>`);
    }
  });
});

describe("newClip", () => {
  it("defaults to fixed mode, unlocked, empty history", () => {
    const c = newClip({ trackId: "t1", startSec: 0, endSec: 1 });
    expect(c.mode).toBe("fixed");
    expect(c.locked).toBe(false);
    expect(c.history).toEqual([]);
    expect(c.text).toBe("");
  });

  it("accepts text and mode overrides", () => {
    const c = newClip({ trackId: "t1", startSec: 1, endSec: 2, text: "hi", mode: "dynamic" });
    expect(c.text).toBe("hi");
    expect(c.mode).toBe("dynamic");
  });

  it("emits a unique id per clip", () => {
    const a = newClip({ trackId: "t", startSec: 0, endSec: 1 });
    const b = newClip({ trackId: "t", startSec: 0, endSec: 1 });
    expect(a.id).not.toBe(b.id);
  });
});

describe("emptyProject", () => {
  it("creates a project with no tracks, no voices, default duration", () => {
    const p = emptyProject("My project");
    expect(p.name).toBe("My project");
    expect(p.durationSec).toBe(DEFAULT_PROJECT_DURATION_SEC);
    expect(p.tracks).toEqual([]);
    expect(p.voices).toEqual([]);
  });
});
