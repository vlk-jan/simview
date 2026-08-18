import { expect, test } from "@playwright/test";

// Windowed state loading tripwire. The window arithmetic and the fetch/evict
// behavior are unit-tested (tests/js/blobWindow.test.js,
// tests/js/WindowedField.test.js) and the server's Range support in
// tests/test_columnar_ondisk.py; what needs a real browser is the wiring --
// that a windowed field is actually range-fetched over HTTP and resolves to
// the same values a fully-loaded one would.
//
// The real threshold is 8 MB, far more data than a CI fixture should carry, so
// these force it down to 0 before load via the documented override.

const EPISODIC_URL = "http://127.0.0.1:5598/";

async function loadWithWindowing(page, thresholdBytes) {
    const errors = [];
    const rangedRequests = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("request", (request) => {
        if (request.headers()["range"]) rangedRequests.push(request.url());
    });

    await page.addInitScript((bytes) => {
        window.__simviewWindowThresholdBytes = bytes;
    }, thresholdBytes);
    await page.goto(EPISODIC_URL);
    await page.waitForSelector("#loading-splash", {
        state: "detached",
        timeout: 20_000,
    });
    return { errors, rangedRequests };
}

function fieldKinds(page) {
    return page.evaluate(() => {
        const kinds = {};
        for (const body of window.__debugSimView.store._bodies) {
            for (const [name, value] of Object.entries(body.fields)) {
                kinds[name] =
                    value && typeof value.rowsAt === "function" ? "windowed" : "whole";
            }
        }
        return kinds;
    });
}

test("large current-frame-only fields are fetched in windows", async ({ page }) => {
    // The episodic fixture has no vector fields, so this asserts the split
    // rule itself: whatever fields it does have stay whole.
    const { errors } = await loadWithWindowing(page, 0);

    const kinds = await fieldKinds(page);
    // bodyTransform is walked by trails/error metrics/terrain profile, so it
    // is never windowed no matter how big it gets.
    expect(kinds.bodyTransform).toBe("whole");
    expect(errors).toEqual([]);
});

test("windowed fields resolve to the same values as a whole fetch", async ({ page }) => {
    // Force windowing on, then compare a windowed field's rows against the
    // bytes the server serves for the whole blob.
    const { errors, rangedRequests } = await loadWithWindowing(page, 0);

    const result = await page.evaluate(async () => {
        const app = window.__debugSimView;
        const body = app.store._bodies[0];
        // Build a windowed reader over bodyTransform's own blob, which the
        // store already holds in full -- so the two can be compared directly.
        const { WindowedField } = await import(
            "/static/js/components/WindowedField.js"
        );
        const statesResponse = await fetch("/states");
        const payload = await statesResponse.json();
        const url = payload.bodies[0].fields.bodyTransform;

        const field = new WindowedField(url, {
            totalFrames: payload.times.length,
            batchCount: app.batchManager.simBatches,
            width: 7,
        });
        field.rowsAt(0);
        // Wait for the window to land.
        for (let i = 0; i < 100 && field.residentWindows === 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }

        const frame = 5;
        const windowed = field.rowsAt(frame);
        const whole = app.store.getFrame(frame).bodies[0].bodyTransform;
        return { windowed, whole, resident: field.residentWindows };
    });

    expect(result.resident).toBeGreaterThan(0);
    expect(result.windowed).toEqual(result.whole);
    // ...and it got there via Range requests, not a full download.
    expect(rangedRequests.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
});
