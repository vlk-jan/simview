import { expect, test } from "@playwright/test";

// Focused-batch rendering tripwire. The policy itself (which batches are
// visible for a given mode/focus, and the auto-threshold for large batch
// counts) is unit-tested in tests/js/batchVisibility.test.js; what needs a
// real browser is the wiring: that switching modes actually hides the other
// batches' scene objects, and that a batch's per-batch objects are built the
// first time it becomes visible rather than up front.
//
// Runs against the 2-batch episodic scene on 5598 (see playwright.config.js),
// forcing focused mode rather than needing a hundred-env fixture.

const EPISODIC_URL = "http://127.0.0.1:5598/";

async function load(page) {
    const errors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    await page.goto(EPISODIC_URL);
    await page.waitForSelector("#loading-splash", {
        state: "detached",
        timeout: 20_000,
    });
    return errors;
}

// Per-batch scene state, read off the live objects.
function batchState(page) {
    return page.evaluate(() => {
        const app = window.__debugSimView;
        const body = [...app.bodies.values()][0];
        return {
            renderMode: app.batchManager.renderMode,
            visible: [...app.batchManager.visibleBatches].sort(),
            builtBatchGroups: body.batchGroups.filter(Boolean).length,
            visibleBatchGroups: body.batchGroups.filter((g) => g && g.visible).length,
            visibleTerrainGroups: app.terrain.group.children.filter((c) => c.visible)
                .length,
        };
    });
}

test("a small scene renders every batch by default", async ({ page }) => {
    const errors = await load(page);

    const state = await batchState(page);
    expect(state.renderMode).toBe("all");
    expect(state.visible).toEqual([0, 1]);
    expect(state.builtBatchGroups).toBe(2);
    expect(state.visibleTerrainGroups).toBe(2);
    expect(errors).toEqual([]);
});

test("focused mode hides the other batches and follows the active one", async ({
    page,
}) => {
    const errors = await load(page);

    await page.evaluate(() => window.__debugSimView.batchManager.setRenderMode("focused"));
    let state = await batchState(page);
    expect(state.visible).toEqual([0]);
    expect(state.visibleBatchGroups).toBe(1);
    expect(state.visibleTerrainGroups).toBe(1);

    // Focusing another batch moves what's drawn rather than adding to it.
    await page.evaluate(() => window.__debugSimView.batchManager.setActiveBatch(1));
    state = await batchState(page);
    expect(state.visible).toEqual([1]);
    expect(state.visibleBatchGroups).toBe(1);
    expect(state.visibleTerrainGroups).toBe(1);

    // ...and switching back to "all" restores everything.
    await page.evaluate(() => window.__debugSimView.batchManager.setRenderMode("all"));
    state = await batchState(page);
    expect(state.visible).toEqual([0, 1]);
    expect(state.visibleBatchGroups).toBe(2);
    expect(state.visibleTerrainGroups).toBe(2);

    expect(errors).toEqual([]);
});

test("a batch's per-batch objects are built only once it is rendered", async ({
    page,
}) => {
    const errors = await load(page);

    // Start focused on batch 0 with a fresh set of bodies, so batch 1's group
    // has never been needed.
    const built = await page.evaluate(() => {
        const app = window.__debugSimView;
        const body = [...app.bodies.values()][0];
        // Drop batch 1's group to simulate never having built it, the state a
        // scene with hundreds of batches loads in.
        const group = body.batchGroups[1];
        if (group) body.group.remove(group);
        body.batchGroups[1] = undefined;

        app.batchManager.setRenderMode("focused");
        const before = body.batchGroups.filter(Boolean).length;
        app.batchManager.setActiveBatch(1);
        const after = body.batchGroups.filter(Boolean).length;
        return { before, after };
    });

    expect(built.before).toBe(1);
    // Focusing batch 1 built it on demand.
    expect(built.after).toBe(2);
    expect(errors).toEqual([]);
});
