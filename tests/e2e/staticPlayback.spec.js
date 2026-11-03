import { expect, test } from "@playwright/test";

// A single-frame scene (port 5597, see playwright.config.js and
// make_static_scene.py) has no timeline: the playback bar keeps only the
// screenshot button and the format select, which then offers image types
// (a recording lasts one timeline loop, so REC would yield an empty clip),
// and the timeline and REC shortcuts do nothing.

const STATIC_URL = "http://127.0.0.1:5597/";

test("a single-frame scene's playback bar keeps only the screenshot controls", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.goto(STATIC_URL);
    await page.waitForSelector("#loading-splash", { state: "detached", timeout: 20_000 });

    expect(pageErrors).toEqual([]);
    await expect(page.locator(".sv-playback")).toHaveClass(/sv-playback--static/);
    await expect(page.getByTitle("Screenshot (S)")).toBeVisible();
    await expect(page.locator(".sv-playback .sv-play")).toBeHidden();
    await expect(page.getByText("REC")).toBeHidden();
    const format = page.locator(".sv-playback .sv-format");
    await expect(format).toBeVisible();
    expect(await format.locator("option").allTextContents()).toEqual(["PNG", "JPG", "WEBP"]);
    await expect(page.locator(".sv-progress")).toBeHidden();

    await page.keyboard.press(" ");
    await page.keyboard.press("r");
    const state = await page.evaluate(() => {
        const ac = window.__debugSimView.animationController;
        return { playing: ac.isPlaying, recording: ac.isRecording };
    });
    expect(state).toEqual({ playing: false, recording: false });
});

test("the format select sets a static scene's screenshot type", async ({ page }) => {
    await page.goto(STATIC_URL);
    await page.waitForSelector("#loading-splash", { state: "detached", timeout: 20_000 });
    await page.locator(".sv-playback .sv-format").selectOption("jpeg");
    const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByTitle("Screenshot (S)").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.jpg$/);
});

test("hiding the recording panel hides a static scene's bar entirely", async ({ page }) => {
    await page.goto(`${STATIC_URL}#hide=recording`);
    await page.waitForSelector("#loading-splash", { state: "detached", timeout: 20_000 });
    await expect(page.locator(".sv-playback")).toBeHidden();
});
