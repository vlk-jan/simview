import { defineConfig } from "@playwright/test";

// Time-boxed smoke test: does the viewer load a scene end-to-end in a real
// browser without console/page errors, and does the timeline respond to a
// click? Not a substitute for the vitest unit tests -- just a tripwire for
// wiring-level regressions (bad imports, server 500s, etc.).
//
// Two servers: the demo scene on 5599 (the default baseURL), and a generated
// episodic scene on 5598 for the episode-navigation test, which needs a scene
// that actually declares `episodes`.
export default defineConfig({
    testDir: "tests/e2e",
    timeout: 30_000,
    fullyParallel: false,
    workers: 1,
    webServer: [
        {
            command: "uv run simview example_sim.json --no-browser --port 5599",
            url: "http://127.0.0.1:5599/",
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
            cwd: ".",
        },
        {
            command:
                "uv run python tests/e2e/make_episodic_scene.py && " +
                "uv run simview tests/e2e/.episodic_sim.json --no-browser --port 5598",
            url: "http://127.0.0.1:5598/",
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
            cwd: ".",
        },
    ],
    use: {
        baseURL: "http://127.0.0.1:5599",
    },
});
