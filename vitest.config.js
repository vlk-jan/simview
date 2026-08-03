import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Source uses bare `import * as THREE from "three"` (matching the browser
// importmap, which points "three" at the jsdelivr CDN build). Node/Vitest
// resolves that the same way once the npm "three" package is installed --
// no alias needed, this config exists mainly to pin the test environment.
export default defineConfig({
    resolve: {
        alias: {
            // "chroma" has no npm equivalent -- the browser importmap points
            // it at this vendored file (simview/templates/index.html), so
            // alias it the same way for Vitest/Node instead of installing a
            // separate package that could drift from what actually ships.
            chroma: fileURLToPath(
                new URL(
                    "./simview/static/lib/chroma-js-3.1.2/index.min.js",
                    import.meta.url
                )
            ),
        },
    },
    test: {
        environment: "node",
        include: ["tests/js/**/*.test.js"],
    },
});
