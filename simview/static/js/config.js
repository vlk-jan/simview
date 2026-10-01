// Catppuccin Mocha (https://catppuccin.com/palette) for everything drawn on a
// canvas or in WebGL, where the CSS tokens in controls.css can't reach --
// keep the two in sync.
export const THEME = {
    crust: "#11111b",
    mantle: "#181825",
    base: "#1e1e2e",
    surface0: "#313244",
    surface1: "#45475a",
    overlay0: "#6c7086",
    subtext0: "#a6adc8",
    text: "#cdd6f4",
    blue: "#89b4fa",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    peach: "#fab387",
    chartFont: "12px system-ui, sans-serif",
};

export const UI_DEFAULT_CONFIG = {
    bodyVisualizationMode: "points",
    // Point-cloud bodies sit outside Body Visualization Mode (a cloud isn't a
    // way of drawing a body, it's the whole object), so they get their own
    // visibility toggle -- see Body#pointsVisible.
    pointCloudsVisible: true,
    axesVisible: false,
    trailsVisible: false,
    smoothInterpolation: true,
    attributeVisible: {
        contacts: false,
        velocity: false,
        angularVelocity: false,
        force: false,
        torque: false,
    },
    terrainVisualizationModes: {
        surface: true,
        wireframe: true,
        normals: false,
    },
    terrainColorMap: "magma", // Default colormap
    terrainColorMode: "height", // "height", or any named terrain property (e.g. friction, stiffness)
    terrainProbe: false, // interactive terrain probe on click
};

export const FREQ_CONFIG = {
    scene: 60, // Scene update frequency in Hz
    scalarPlotter: 20,
    bodyStateWindow: 30,
    playbackControls: 20,
    errorMetrics: 20,
    terrainProfile: 20,
};

export const CONTROLS_CONFIG = {
    minDistance: 1,
    // Also a floor, widened alongside the far plane so the whole scene can
    // actually be framed on a large map (see Scene.applySceneExtent).
    maxDistance: 500,
    panSpeed: 2.0,
    rotateSpeed: 1.5,
    zoomSpeed: 1.2,
};

export const SCENE_CONFIG = {
    defaultUp: [0, 0, 1],
};

export const RENDERER_CONFIG = {
    antialias: true,
    preserveDrawingBuffer: true,
    pixelRatio: window.devicePixelRatio,
    clearColor: THEME.mantle, // matches --sv-bg in controls.css
    clearAlpha: 1.0,
};

export const CAMERA_CONFIG = {
    fov: 40,
    near: 0.1,
    // A floor, not the final value: widened at load to span the terrain
    // extent, so scenes hundreds of metres across don't clip their own
    // terrain and bodies away (see Scene.applySceneExtent).
    far: 500,
    position: [-15, -15, 10],
    up: [0, 0, 1],
};

export const LIGHTING_CONFIG = {
    ambient: {
        color: 0xffffff,
        intensity: 0.9,
    },
    directional: {
        color: 0xffffff,
        intensity: 0.8,
        position: [10, 10, 10],
    },
};

export const TERRAIN_CONFIG = {
    skipNormalCells: 10,
    normalLength: 0.2,
};

// Bodies and static objects render with identical shapes/materials except
// for point size (bodies are smaller markers than static-object points).
const SHAPE_CONFIG = {
    geometry: {
        box: {
            widthSegments: 4,
            heightSegments: 4,
            depthSegments: 4,
        },
        sphere: {
            widthSegments: 16,
            heightSegments: 16,
        },
        cylinder: {
            radialSegments: 32,
            heightSegments: 4,
        },
    },
    wireframe: {
        color: THEME.blue,
    },
    points: {
        opacity: 0.7,
        alphaTest: 0.5,
        transparent: false,
        texture: "static/textures/points/ball1.png",
    },
    contactPoints: {
        size: 0.7,
        opacity: 1.0,
        alphaTest: 0.5,
        transparent: false,
        texture: "static/textures/contacts/red-cross0.png",
    },
};

export const BODY_CONFIG = {
    ...SHAPE_CONFIG,
    points: { ...SHAPE_CONFIG.points, size: 0.1 },
};

export const SCALAR_PLOTTER_CONFIG = {
    stepsPerYAxis: 5,
    inactiveBatchOpacity: 0.3,
};

export const TRAIL_CONFIG = {
    opacity: 0.6,
};

export const BODY_VECTOR_CONFIG = {
    // Linear velocity
    velocity: {
        color: THEME.green,
        scale: 1.0,
    },
    // Angular velocity
    angularVelocity: {
        color: THEME.yellow,
        scale: 1.0,
    },
    // Force
    force: {
        color: THEME.peach,
        scale: 1.0,
    },
    // Torque
    torque: {
        color: THEME.red,
        scale: 1.0,
    },
};

export const RAYCAST_CONFIG = {
    // THREE.Raycaster's default Points.threshold is 1 world unit -- far too
    // generous at BODY_CONFIG.points.size (0.1), where it would make every
    // click ambiguous among many nearby points instead of picking the one
    // actually under the cursor.
    pointsThreshold: 0.15,
};

// Batch colors: the Mocha accents, ordered so neighbouring batches differ in
// hue. Used as-is up to their count; more batches interpolate between them.
export const BATCH_PALETTE = [
    "#89b4fa", // blue
    "#fab387", // peach
    "#a6e3a1", // green
    "#cba6f7", // mauve
    "#f38ba8", // red
    "#94e2d5", // teal
    "#f9e2af", // yellow
    "#f5c2e7", // pink
    "#74c7ec", // sapphire
    "#eba0ac", // maroon
    "#b4befe", // lavender
    "#89dceb", // sky
    "#f2cdcd", // flamingo
    "#f5e0dc", // rosewater
];

export const STATIC_OBJECT_CONFIG = {
    ...SHAPE_CONFIG,
    points: { ...SHAPE_CONFIG.points, size: 0.2 },
};
