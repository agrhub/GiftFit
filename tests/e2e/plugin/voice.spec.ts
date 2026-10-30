/**
 * Voice in the embeddable gift assistant (owner: A4, P8.3), on the demo store (a second origin), with
 * the app server in voice mock mode (VOICE_MOCK=1: canned transcript, tone WAV, no Google call) and
 * Chromium's fake microphone:
 *   panel → turn voice on → first-mic notice → Continue arms the mic → tap to record, tap to send →
 *   transcript sent → reply spoken (TTS request, character talking, "AI voice" label) → push-to-talk
 *   hold → mute → no more TTS requests.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

const STORE_PORT = Number(process.env.DEMO_STORE_VOICE_PORT ?? 4330);
const STORE = `http://127.0.0.1:${STORE_PORT}`;
const TRANSCRIPT = "I'm looking for a gift for my sister, maybe earrings under 200 dollars.";
let server: ChildProcess | undefined;

test.describe.configure({ mode: "serial" });
test.use({
  extraHTTPHeaders: { "X-Forwarded-For": "203.0.113.47" },
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] },
});

test.beforeAll(async ({ baseURL }) => {
  server = spawn(process.execPath, [path.join("server", "demo-store", "server.mjs")], {
    env: { ...process.env, GIFTFIT_ORIGIN: new URL(baseURL!).origin, PORT: String(STORE_PORT), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(STORE)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("demo store did not start");
});

test.afterAll(() => {
  server?.kill();
});

test("voice: mic → transcript → spoken reply (mouth talking) → mute stops TTS", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const appOrigin = new URL(baseURL!).origin;
  const tts: string[] = [];
  const stt: number[] = [];
  page.on("request", (r) => {
    if (r.url() === `${appOrigin}/api/voice/tts`) tts.push(r.postData() ?? "");
  });
  page.on("response", (r) => {
    if (r.url() === `${appOrigin}/api/voice/stt`) stt.push(r.status());
  });

  await page.goto(`${STORE}/p/halo-drop-earrings`);
  const host = page.locator("giftfit-widget");
  await expect(host).toHaveAttribute("data-ready", "", { timeout: 60_000 });
  await expect(host.locator("iframe")).toHaveAttribute("allow", /microphone/);
  const frame = page.frameLocator("giftfit-widget iframe");
  await frame.getByRole("button", { name: "Open the gift assistant" }).click();
  await expect(host).toHaveAttribute("data-mode", "panel");

  // Voice is off until the shopper turns it on.
  const toggle = frame.getByTestId("voice-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(frame.getByTestId("voice-ai-label")).toBeVisible();

  // First mic use: the privacy notice; "Continue" only arms the mic (permission, no recording) and
  // says how to talk; the shopper's own tap then starts recording and the next tap sends.
  const mic = frame.getByTestId("voice-mic");
  await mic.click();
  await expect(frame.getByTestId("voice-mic-notice")).toContainText("Google Cloud Speech-to-Text");
  await frame.getByTestId("voice-mic-notice-ok").click();
  await expect(frame.getByTestId("voice-mic-ready")).toContainText("Hold the mic to talk");
  await expect(mic).toHaveAttribute("data-phase", "idle");
  await expect(mic).toBeFocused();
  await mic.click();
  await expect(mic).toHaveAttribute("data-phase", "recording", { timeout: 15_000 });
  await expect(mic).toHaveAttribute("aria-label", "Stop and send");
  await expect(frame.locator("header [data-state]").first()).toHaveAttribute("data-state", "listening");
  await page.waitForTimeout(1200);
  const spoken = page.waitForRequest((r) => r.url() === `${appOrigin}/api/voice/tts`, { timeout: 60_000 });
  await mic.click();
  await expect(frame.getByTestId("widget-voice-turn").first()).toContainText(TRANSCRIPT, { timeout: 30_000 });
  expect(stt).toEqual([200]);

  // The reply is spoken: TTS requested, the character talks, the AI voice label lights up.
  await spoken;
  await expect(frame.locator("header [data-state]").first()).toHaveAttribute("data-state", "talking", { timeout: 20_000 });
  await expect(frame.getByTestId("voice-ai-label")).toHaveAttribute("data-playing", "");
  await frame.getByTestId("voice-ai-label").click();
  await expect(frame.getByTestId("voice-ai-info")).toContainText("not a real person");
  await frame.getByTestId("voice-ai-label").click();

  // Push-to-talk: hold the mic (interrupts the speech), release to send.
  await expect(mic).toBeEnabled({ timeout: 30_000 });
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(mic).toHaveAttribute("data-phase", "recording", { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await expect(frame.getByTestId("widget-voice-turn")).toHaveCount(2, { timeout: 30_000 });
  await expect(mic).toBeEnabled({ timeout: 30_000 });

  // Mute: speech stops and the next reply makes no TTS request.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(frame.locator("header [data-state]").first()).not.toHaveAttribute("data-state", "talking", { timeout: 10_000 });
  const before = tts.length;
  const input = frame.getByLabel("Your message");
  await input.fill("Something a little cheaper, please.");
  await input.press("Enter");
  await expect(frame.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  expect(tts.length).toBe(before);
  for (const body of tts) expect((JSON.parse(body) as { text: string }).text.length).toBeLessThanOrEqual(400);
});
