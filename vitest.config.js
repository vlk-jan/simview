import { defineConfig } from "vitest/config";

// Source uses bare `import * as THREE from "three"` (matching the browser
// importmap, which points "three" at the jsdelivr CDN build). Node/Vitest
// resolves that the same way once the npm "three" package is installed --
// no alias needed, this config exists mainly to pin the test environment.
export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/js/**/*.test.js"],
    },
});
