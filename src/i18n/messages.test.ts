import { afterEach, describe, expect, it, vi } from "vitest";
import { dateLocale, detectInitialLocale, isDefaultProjectName, LOCALE_STORAGE_KEY, localizeExportError, localizeModelProgressMessage, messages, normalizeLocale } from "./messages";

describe("Traditional Chinese locale", () => {
  it.each([
    "zh-TW", "zh_Hant_TW", "zh-Hant", "zh-HK", "zh-MO",
    "zh-Hant-HK", "zh_Hant_MO", "zh-Hant-US", "zh-TW-u-nu-latn",
  ])("recognizes Traditional Chinese locale %s", (locale) => {
    expect(normalizeLocale(locale)).toBe("zh-TW");
  });

  it.each(["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-TW", "zh-Hans-HK"])(
    "does not treat Simplified or unspecified Chinese locale %s as Traditional",
    (locale) => expect(normalizeLocale(locale)).toBeNull(),
  );

  it("uses Traditional Chinese dates", () => {
    expect(dateLocale("zh-TW")).toBe("zh-TW");
  });
  it("localizes status messages and recognizes the default project name", () => {
    expect(localizeModelProgressMessage("zh-TW", "Loading model")).toBe("正在載入模型");
    expect(isDefaultProjectName(messages["zh-TW"].defaults.untitledProject)).toBe(true);
  });
});

describe("initial interface language", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
  });

  it.each(["zh-Hant-HK", "zh-Hant-MO"])("prefers %s over the English fallback", (locale) => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    vi.stubGlobal("navigator", { language: locale, languages: [locale, "en-US"] });
    expect(detectInitialLocale()).toBe("zh-TW");
  });

  it("keeps the saved interface language ahead of the system locale", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "ru");
    vi.stubGlobal("navigator", { language: "zh-Hant-HK", languages: ["zh-Hant-HK"] });
    expect(detectInitialLocale()).toBe("ru");
  });

  it.each([["en_US", "en"], ["ru_RU", "ru"]])("retains detection of %s", (locale, expected) => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    vi.stubGlobal("navigator", { language: locale, languages: [locale] });
    expect(detectInitialLocale()).toBe(expected);
  });
});

describe("export prerequisites", () => {
  it.each(["en", "ru", "zh-TW"] as const)("explains missing encoders in %s", (locale) => {
    expect(localizeExportError(locale, "FFmpeg encoder unavailable: libvorbis"))
      .toBe(messages[locale].topBar.exportEncoderMissing("libvorbis"));
    expect(localizeExportError(locale, "FFmpeg unavailable"))
      .toBe(messages[locale].topBar.exportFfmpegMissing);
    expect(localizeExportError(locale, "Disk is full")).toBe("Disk is full");
  });
});
