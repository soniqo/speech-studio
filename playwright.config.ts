import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1454",
    headless: true,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    channel: process.env.PLAYWRIGHT_CHANNEL,
    launchOptions: { args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 1454 --strictPort",
    url: "http://127.0.0.1:1454/tests/browser/",
    reuseExistingServer: false,
  },
});
