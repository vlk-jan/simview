import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";

// End-to-end tripwire: loads a real simulation through the real server and
// checks the page reaches a usable state with no console/page errors, then
// exercises basic timeline interaction. Deliberately shallow -- the vitest
// unit tests own correctness of the underlying math/decoding.
test("loads example_sim.json with no console/page errors and responds to a timeline click", async ({ page }) => {
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");
    await page.waitForSelector("#loading-splash", { state: "detached", timeout: 20_000 });

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);

    // The playback progress bar is an unstyled-class div centered at the
    // bottom of the viewport (see PlaybackControls.js) -- click its
    // approximate screen position rather than relying on a CSS selector
    // that doesn't exist in the markup.
    const viewport = page.viewportSize();
    await page.mouse.click(viewport.width / 2, viewport.height - 30);
});

// Recording tripwire: exercises the native MediaRecorder-based WEBM path
// (see AnimationController.js#startRecording/captureFrame/stopRecording) end
// to end -- click Record, let it auto-stop after one full loop, and confirm a
// real browser download event fires with the expected filename. example_sim.json's
// loop is 4.9s; the playback-speed dropdown is bumped to 5x first (a stable,
// value-based selector -- see PlaybackControls.js's speedSelect) so the test
// doesn't have to wait out the whole loop in realtime.
test("recording a WEBM clip downloads a .webm file after one loop", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#loading-splash", { state: "detached", timeout: 20_000 });

    // formatSelect defaults to "webm" already; only the playback speed needs
    // changing. Both dropdowns are page-wide <select> elements (the scene also
    // has several lil-gui <select>s), so target by the option value that's
    // unique to PlaybackControls' speed dropdown rather than DOM order.
    const speedSelect = page.locator('select:has(option[value="5"])');
    await speedSelect.selectOption("5");

    const recordButton = page.getByRole("button", { name: /REC/ });
    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await recordButton.click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.webm$/);
});

// Screenshot tripwire: exercises AnimationController.captureScreenshot()
// (see PlaybackControls.js's camera button, next to Record) end to end --
// click it and confirm a real browser download event fires with a .png
// filename and a plausible (non-trivial) file size.
test("screenshot button downloads a .png file", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#loading-splash", { state: "detached", timeout: 20_000 });

    const screenshotButton = page.getByTitle("Screenshot (S)");
    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await screenshotButton.click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.png$/);

    const downloadPath = await download.path();
    const stats = await fs.stat(downloadPath);
    expect(stats.size).toBeGreaterThan(10 * 1024);
});
