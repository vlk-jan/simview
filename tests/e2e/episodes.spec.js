import { expect, test } from "@playwright/test";

// Episode UI tripwire, against the generated episodic scene on port 5598 (see
// playwright.config.js and make_episodic_scene.py): the boundary ticks, the
// next/previous-episode buttons and their keyboard shortcuts only exist for a
// scene that declares `episodes`, so the demo scene on the default baseURL
// can't exercise them. The navigation math itself is unit-tested in
// tests/js/episodes.test.js -- this checks it's actually wired to the DOM.

const EPISODIC_URL = "http://127.0.0.1:5598/";
const FRAMES_PER_EPISODE = 30;

async function loadEpisodicScene(page) {
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(EPISODIC_URL);
    await page.waitForSelector("#loading-splash", {
        state: "detached",
        timeout: 20_000,
    });
    return { consoleErrors, pageErrors };
}

// Read playback state through the SimView instance the entry point already
// parks on window for debugging (see SimView.run) rather than adding a
// test-only hook.
function currentFrame(page) {
    return page.evaluate(
        () => window.__debugSimView.animationController.getCurrentStateIndex()
    );
}

test("an episodic scene shows episode controls and boundary ticks", async ({ page }) => {
    const { consoleErrors, pageErrors } = await loadEpisodicScene(page);

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);

    await expect(page.getByTitle("Next episode (])")).toBeVisible();
    await expect(page.getByTitle("Previous episode ([)")).toBeVisible();

    // One tick per episode boundary; the first episode starts at frame 0,
    // which is the timeline's own start and deliberately isn't drawn.
    const tickCount = await page.evaluate(
        () =>
            window.__debugSimView.animationController.playbackControls
                .episodeTicks.childElementCount
    );
    expect(tickCount).toBe(3);

    await expect(page.locator("body")).toContainText("episode 1");
});

test("next/previous episode buttons jump between episode starts", async ({ page }) => {
    await loadEpisodicScene(page);

    expect(await currentFrame(page)).toBe(0);

    await page.getByTitle("Next episode (])").click();
    expect(await currentFrame(page)).toBe(FRAMES_PER_EPISODE);
    await expect(page.locator("body")).toContainText("episode 2");

    await page.getByTitle("Next episode (])").click();
    expect(await currentFrame(page)).toBe(2 * FRAMES_PER_EPISODE);

    // Already sitting on episode 3's start, so "previous" steps back a whole
    // episode rather than rewinding within the current one.
    await page.getByTitle("Previous episode ([)").click();
    expect(await currentFrame(page)).toBe(FRAMES_PER_EPISODE);
    await expect(page.locator("body")).toContainText("episode 2");
});

test("the [ and ] keys navigate episodes too", async ({ page }) => {
    await loadEpisodicScene(page);

    await page.keyboard.press("]");
    expect(await currentFrame(page)).toBe(FRAMES_PER_EPISODE);

    await page.keyboard.press("[");
    expect(await currentFrame(page)).toBe(0);
});

test("a non-episodic scene hides the episode controls entirely", async ({ page }) => {
    // The demo scene on the default baseURL declares no episodes.
    await page.goto("/");
    await page.waitForSelector("#loading-splash", {
        state: "detached",
        timeout: 20_000,
    });

    await expect(page.getByTitle("Next episode (])")).toBeHidden();
    await expect(page.getByTitle("Previous episode ([)")).toBeHidden();
});
