import { describe, expect, it } from "vitest";
import { dateLocale, isDefaultProjectName, localizeModelProgressMessage, messages, normalizeLocale } from "./messages";

describe("Traditional Chinese locale", () => {
  it("recognizes Traditional Chinese locales without treating Simplified Chinese as Traditional", () => {
    expect(normalizeLocale("zh-TW")).toBe("zh-TW");
    expect(normalizeLocale("zh_Hant_TW")).toBe("zh-TW");
    expect(normalizeLocale("zh-CN")).toBeNull();
    expect(dateLocale("zh-TW")).toBe("zh-TW");
  });
  it("localizes status messages and recognizes the default project name", () => {
    expect(localizeModelProgressMessage("zh-TW", "Loading model")).toBe("正在載入模型");
    expect(isDefaultProjectName(messages["zh-TW"].defaults.untitledProject)).toBe(true);
  });
});
