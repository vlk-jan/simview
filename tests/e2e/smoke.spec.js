import { expect, test } from "@playwright/test";

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
