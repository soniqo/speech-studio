import { describe, expect, it } from "vitest";
import { LANGUAGE_LABELS, languageLabel } from "./languageLabels";

const VOXCPM2_LANGUAGE_IDS = [
  "ar",
  "my",
  "zh",
  "da",
  "nl",
  "en",
  "fi",
  "fr",
  "de",
  "el",
  "he",
  "hi",
  "id",
  "it",
  "ja",
  "km",
  "ko",
  "lo",
  "ms",
  "no",
  "pl",
  "pt",
  "ru",
  "es",
  "sw",
  "sv",
  "tl",
  "th",
  "tr",
  "vi",
];

describe("language labels", () => {
  it("covers the full VoxCPM2 language set", () => {
    for (const id of VOXCPM2_LANGUAGE_IDS) {
      expect(LANGUAGE_LABELS[id], id).toBeTruthy();
      expect(languageLabel(id)).not.toBe(id);
    }
  });

  it("falls back to the id for unknown languages", () => {
    expect(languageLabel("xx")).toBe("xx");
  });
});
