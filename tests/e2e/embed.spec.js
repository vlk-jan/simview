import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Embedding tripwire: the contract an embedding page relies on -- a static
// bundle served from an arbitrary base (`#data=`), chrome hidden (`#ui=0`),
// `simview:ready`/`simview:frame` events, and live hash control of the view.
// Breaking any of these breaks every downstream embedder silently, so this is
// checked in a real browser rather than only in the vitest unit tests.

let bundleDir;

test.beforeAll(() => {
    // The stdlib-only bundle writer the authoring API's `save_static` wraps,
    // fed the same file the e2e server serves.
    bundleDir = mkdtempSync(join(tmpdir(), "simview-bundle-"));
    execFileSync("uv", [
        "run",
        "python",
        "-c",
        "import json,sys; from simview.columnar import write_static_bundle; " +
            "write_static_bundle(json.load(open('example_sim.json')), sys.argv[1])",
        bundleDir,
    ]);
});

test("loads a static bundle from #data= with #ui=0 and follows hash changes", async ({ page }) => {
    // Serve the bundle from an origin path the server itself has no route for.
    await page.route("**/bundle/**", (route) => {
        const rel = new URL(route.request().url()).pathname.replace(/^.*\/bundle\//, "");
        route.fulfill({ path: join(bundleDir, rel) });
    });
    const warnings = [];
    page.on("console", (msg) => {
        if (msg.type() === "warning" || msg.type() === "error") warnings.push(msg.text());
    });
    await page.addInitScript(() => {
        window.__events = [];
        for (const name of ["simview:ready", "simview:frame"]) {
            window.addEventListener(name, (e) => window.__events.push([name, e.detail.index]));
        }
    });

    await page.goto("/#v=1&t=2&data=/bundle&ui=0");
    await page.waitForSelector("#loading-splash", { state: "detached", timeout: 20_000 });

    // Data came from the bundle, not the server API.
    expect(await page.evaluate(() => window.simview.staticBase)).toBe("/bundle");
    // Chrome hidden; the canvas still there.
    await expect(page.locator(".sv-playback")).toBeHidden();
    await expect(page.locator(".lil-gui.root")).toBeHidden();
    expect(await page.evaluate(() => window.simview.scene.renderer.domElement.isConnected)).toBe(true);

    // `t=2` was applied at load, and `ready` + a `frame` event followed.
    const indexAt = (t) => page.evaluate((t) => window.simview.animationController.getStateIndexForTime(t), t);
    const current = () => page.evaluate(() => window.simview.animationController.getCurrentStateIndex());
    expect(await current()).toBe(await indexAt(2));
    expect(await current()).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.__events.map(([n]) => n))).toContain("simview:ready");
    await expect.poll(() => page.evaluate(() => window.__events.map(([n]) => n))).toContain("simview:frame");

    // Editing the hash after load re-applies the view.
    await page.evaluate(() => {
        location.hash = "#v=1&t=0";
    });
    await expect.poll(current).toBe(0);
    await expect.poll(() => page.evaluate(() => window.__events.at(-1))).toEqual(["simview:frame", 0]);

    // The carry-over keys apply through the controls, so widgets and uiState agree.
    const body = await page.evaluate(() => [...window.simview.bodies.keys()][0]);
    await page.evaluate((h) => {
        location.hash = h;
    }, `#v=1&speed=2&cmap=viridis&track=${encodeURIComponent(body)}`);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const s = window.simview;
                return [
                    s.animationController.playbackSpeed,
                    s.animationController.playbackControls.speedSelect.value,
                    s.uiState.terrainColorMap,
                    s.uiState.trackBody,
                    s.uiControls.findController("colorMap").getValue(),
                ];
            })
        )
        .toEqual([2, "2", "viridis", body, "viridis"]);
    expect(await page.evaluate(() => window.simview.getViewState())).toMatchObject({
        playbackSpeed: 2,
        terrainColorMap: "viridis",
        trackBody: body,
    });

    // No "Invalid end index" (scalar plotter before the store) or other warnings.
    expect(warnings).toEqual([]);
});

test("play=1 starts playback after the view state is applied", async ({ page }) => {
    await page.route("**/bundle/**", (route) => {
        const rel = new URL(route.request().url()).pathname.replace(/^.*\/bundle\//, "");
        route.fulfill({ path: join(bundleDir, rel) });
    });
    await page.goto("/#v=1&t=2&play=1&data=/bundle&ui=0");
    await page.waitForSelector("#loading-splash", { state: "detached", timeout: 20_000 });

    const ac = () => page.evaluate(() => window.simview.animationController.isPlaying);
    expect(await ac()).toBe(true);
    // `t=2` was honoured before play started: the index advances from there, not from 0.
    const indexAt2 = await page.evaluate(() => window.simview.animationController.getStateIndexForTime(2));
    await expect
        .poll(() => page.evaluate(() => window.simview.animationController.getCurrentStateIndex()))
        .toBeGreaterThan(indexAt2);
});
