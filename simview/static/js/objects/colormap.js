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

export const NO_DATA_COLOR = new THREE.Color(0.5, 0.5, 0.5);

/**
 * Resolves a colormap name (matplotlib-style, from js-colormaps.js, or one of
 * a few hand-rolled fallbacks) to a callable `(value in [0,1]) => THREE.Color`.
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
            // A non-finite value (NaN cell in a property blob, NaN embedding)
            // is "no data": neutral grey rather than a colormap end. Finite
            // values are clamped because js-colormaps alert()s on anything
            // outside [0, 1] -- including float rounding past 1.
            if (!Number.isFinite(value)) return NO_DATA_COLOR.clone();
            const [r, g, b] = evaluate_cmap(
                Math.min(1, Math.max(0, value)),
                cmapName,
                reversed
            );
            return new THREE.Color(r / 255, g / 255, b / 255);
        };
    console.log(
        `Colormap ${cmapName} not found in colorMapOptions. Using default colormap instead.`
    );
    return (value) => new THREE.Color(value, 0.2, 1 - value);
}
