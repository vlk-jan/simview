import * as THREE from "three";
import { colorMapOptions, evaluate_cmap } from "../../lib/js-colormaps.js";

// Aliases for old hand-rolled fallback names, now served by js-colormaps.js.
// "Greys" runs white(0)->black(1); the old hand-rolled grayscale ran
// black(0)->white(1), so it maps to the reversed variant to match.
const LEGACY_ALIASES = {
    grayscale: "Greys_r",
    heatmap: "jet",
    terrain: "terrain",
};

/**
 * Resolves a colormap name (matplotlib-style, from js-colormaps.js, or one of
 * a few hand-rolled fallbacks) to a callable `(value in [0,1]) => THREE.Color`.
 *
 * Deliberately its own module (not part of utils.js, which imports the
 * `chroma` package -- a browser-only import-map alias with no npm
 * equivalent, unresolvable under vitest/Node): this file only depends on
 * `three` and `js-colormaps.js`, both real npm-resolvable packages, so any
 * consumer (Terrain.js, Body.js) stays unit-testable.
 * @param {string} cmapName
 * @returns {(value: number) => THREE.Color}
 */
export function getCallableFromColorMapName(cmapName) {
    cmapName = LEGACY_ALIASES[cmapName] || cmapName;
    let reversed = false;
    if (cmapName.endsWith("_r")) {
        cmapName = cmapName.substring(0, cmapName.length - 2);
        reversed = true;
    }
    if (colorMapOptions.includes(cmapName))
        return (value) => {
            const [r, g, b] = evaluate_cmap(value, cmapName, reversed);
            return new THREE.Color(r / 255, g / 255, b / 255);
        };
    console.log(
        `Colormap ${cmapName} not found in colorMapOptions. Using default colormap instead.`
    );
    return (value) => new THREE.Color(value, 0.2, 1 - value);
}
