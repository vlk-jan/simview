import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CONTROLS_CONFIG } from "../config.js";

export function setupControls(camera, renderer) {
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.listenToKeyEvents(window);

    // Apply basic configuration
    Object.assign(controls, CONTROLS_CONFIG);

    // Add custom event handlers
    setupControlEvents(controls);

    return controls;
}

function setupControlEvents(controls) {
    // Update cursor during drag
    controls.addEventListener("start", () => {
        document.body.style.cursor = "grabbing";
    });

    controls.addEventListener("end", () => {
        document.body.style.cursor = "auto";
    });
}

// Helper functions for direct control manipulation
export function zoomToFit(controls, boundingSphere, offset = 1.5) {
    const fov = controls.object.fov * (Math.PI / 180);
    const distance = (boundingSphere.radius / Math.sin(fov / 2)) * offset;

    controls.object.position.copy(boundingSphere.center);
    controls.object.position.z += distance;
    controls.target.copy(boundingSphere.center);
    controls.update();
}

export function resetControls(controls) {
    controls.reset();
}

export function updateControlsConfig(controls, config) {
    Object.assign(controls, config);
    controls.update();
}

// Optional: Animation functions
export function enableAutoRotate(controls, speed = 2.0) {
    controls.autoRotate = true;
    controls.autoRotateSpeed = speed;
}

export function disableAutoRotate(controls) {
    controls.autoRotate = false;
}

// Cleanup function
export function disposeControls(controls) {
    if (controls) {
        controls.dispose();
    }
}
