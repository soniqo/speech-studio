import { expect, test } from "@playwright/test";
import type {} from "./fixture";

function wav(seconds: number): Buffer {
  const frames = seconds * 16000;
  const out = Buffer.alloc(44 + frames * 2);
  out.write("RIFF", 0); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) out.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 220 * frame / 16000)), 44 + frame * 2);
  return out;
}

test.beforeEach(async ({ page }) => {
  await page.route("**/fixture-tone.wav*", route => route.fulfill({ contentType: "audio/wav", body: wav(20) }));
});

test("decoded audio extends a fresh canvas and plays through its real end", async ({ page }) => {
  await page.goto("/tests/browser/");
  await page.evaluate(() => {
    const store = window.studioTest.store.getState();
    store.resetProject("Audio");
    store.addTrack({ kind: "audio", id: "audio", name: "Audio", sourcePath: "/fixture-tone.wav", gainDb: 0 });
  });
  await expect.poll(() => page.evaluate(() => window.studioTest.store.getState().project.durationSec)).toBe(20);
  await page.evaluate(() => { const store = window.studioTest.store.getState(); store.seek(4.9); store.setPlaying(true); });
  await expect.poll(() => page.evaluate(() => window.studioTest.store.getState().transport.positionSec)).toBeGreaterThan(5.2);
  expect(await page.evaluate(() => window.studioTest.store.getState().transport.playing)).toBe(true);
  await page.evaluate(() => window.studioTest.store.getState().seek(19.9));
  await expect.poll(() => page.evaluate(() => window.studioTest.store.getState().transport.playing)).toBe(false);
  expect(await page.evaluate(() => window.studioTest.store.getState().transport.positionSec)).toBe(20);
});

test("opening, editing, saving and reopening an older project retains its canvas", async ({ page }) => {
  await page.goto("/tests/browser/");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByText("Legacy custom canvas", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.studioTest.store.getState().project.canvasSec)).toBe(60);
  await expect.poll(() => page.evaluate(() => {
    const state = window.studioTest.store.getState();
    return state.savedSnapshot === JSON.stringify(state.project);
  })).toBe(true);
  await page.locator("header input").fill("Edited legacy");
  await expect.poll(() => page.evaluate(() => window.studioTest.saved.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.studioTest.saved.at(-1)?.durationSec)).toBe(60);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "Edited legacy open now", exact: true }).click();
  expect(await page.evaluate(() => window.studioTest.store.getState().project.durationSec)).toBe(60);
});

test("failed comparison loads retain the editor's recovery controls", async ({ page }) => {
  await page.goto("/tests/browser/");
  await expect.poll(() => page.evaluate(() => window.studioTest.store.getState().model.status)).toBe("ready");
  await page.getByRole("button", { name: "Compare voices", exact: true }).click();
  await page.evaluate(() => { window.studioTest.failLoad = true; });
  await page.getByRole("button", { name: "Download weights", exact: true }).first().click();
  await expect(page.getByRole("alert")).toContainText("Fixture model load failed");
  expect(await page.evaluate(() => window.studioTest.store.getState().model.status)).toBe("error");
  await expect(page.getByRole("button", { name: "Pick another model", exact: true })).toBeVisible();
});

test("shared startup picks a daemon-supported engine", async ({ page }) => {
  await page.goto("/tests/browser/?shared=1");
  await expect.poll(() => page.evaluate(() => window.studioTest.store.getState().model.status)).toBe("ready");
  expect(await page.evaluate(() => window.studioTest.calls.filter(call => call.command === "init_model").map(call => (call.args as { args: { engine: string } }).args.engine))).toEqual(["voxcpm2"]);
  await page.getByRole("button", { name: "Compare voices", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Shared Speech Runtime" })).toBeChecked();
});

test("Traditional Chinese track controls remain translated and reachable", async ({ page }) => {
  await page.goto("/tests/browser/");
  await page.getByRole("combobox", { name: "Interface language" }).click();
  await page.getByRole("option", { name: "繁體中文" }).click();
  await page.evaluate(() => {
    const store = window.studioTest.store.getState();
    store.addTrack({ kind: "audio", id: "audio", name: "Audio", sourcePath: "/fixture-tone.wav", gainDb: 0 });
    store.select({ kind: "track", id: "audio" });
  });
  await expect(page.getByRole("button", { name: "將音軌靜音" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "所有音軌", exact: true })).toBeVisible();
  const header = page.locator("header");
  const width = page.viewportSize()!.width;
  for (const button of await header.getByRole("button").all()) {
    const box = await button.boundingBox();
    if (box) expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
});
