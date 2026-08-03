import * as THREE from "three";
import { colorMapOptions, evaluate_cmap } from "../../lib/js-colormaps.js";

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
    switch (cmapName) {
        case "grayscale":
            return (value) => new THREE.Color(value, value, value);
        case "heatmap":
            return (value) => {
                if (value < 0.25) {
                    return new THREE.Color(0, value * 4, 1);
                } else if (value < 0.5) {
                    return new THREE.Color(0, 1, 1 - (value - 0.25) * 4);
                } else if (value < 0.75) {
                    return new THREE.Color((value - 0.5) * 4, 1, 0);
                } else {
                    return new THREE.Color(1, 1 - (value - 0.75) * 4, 0);
                }
            };
        case "terrain":
            return (value) => {
                if (value < 0.2) {
                    return new THREE.Color(0.0, 0.2, 0.5 + value);
                } else if (value < 0.4) {
                    const t = (value - 0.2) * 5;
                    return new THREE.Color(0.2 * t, 0.5 + 0.2 * t, 0.7 - 0.2 * t);
                } else if (value < 0.75) {
                    const t = (value - 0.4) / 0.35;
                    return new THREE.Color(0.2 + 0.3 * t, 0.7 - 0.2 * t, 0.5 - 0.4 * t);
                } else {
                    const t = (value - 0.75) * 4;
                    return new THREE.Color(0.5 + 0.5 * t, 0.5 + 0.5 * t, 0.1 + 0.9 * t);
                }
            };
        default:
            return (value) => new THREE.Color(value, 0.2, 1 - value);
    }
}
