import * as THREE from "three";

// Blob-decoded fields (SimView.js::fetchBlobs) arrive as flat TypedArrays with
// no reshape metadata; hand-authored (non-tensor) data arrives as plain nested
// arrays. TypedArrays have no .flat(), so every consumer of "maybe-nested,
// maybe-flat" numeric data needs this branch before treating it as flat.
// Exported so Body.js can apply the same normalization to shape.color/
// shape.embedding without duplicating the branch.
export function toFlatFloat32Array(data) {
    return ArrayBuffer.isView(data) ? data : new Float32Array(data.flat());
}

// Default configurations
const DEFAULT_POINTS_CONFIG = {
    size: 1,
    opacity: 1,
    alphaTest: 0.5,
    transparent: true,
    sizeAttenuation: true,
};

const DEFAULT_WIREFRAME_CONFIG = {
    linewidth: 1,
    color: 0x000000,
};

const DEFAULT_MESH_CONFIG = {
    opacity: 1,
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0.5,
    envMapIntensity: 1,
    transparent: false,
};

const DEFAULT_ARROW_CONFIG = {
    lineWidth: 1,
    headWidth: 0.2,
    headLength: 0.2,
    color: 0xff0000,
};

/**
 * Creates a THREE.js geometry based on the shape type and configuration
 * @param {Object} shape - Object containing shape parameters (type, dimensions)
 * @param {GeometryConfig} [geometryConfig={}] - Configuration for geometry segments
 * @returns {THREE.BufferGeometry|null} The created geometry or null if shape type is invalid
 */
export function createGeometry(shape, geometryConfig) {
    if (!shape || !shape.type) return null;
    // No box/sphere/cylinder defaults here: every real caller (Body.js,
    // StaticObject.js) always passes a fully-populated geometry config
    // (BODY_CONFIG.geometry / STATIC_OBJECT_CONFIG.geometry).
    const config = geometryConfig || {};
    let geometry;

    switch (shape.type) {
        case "box":
            geometry = new THREE.BoxGeometry(
                shape.hx * 2,
                shape.hy * 2,
                shape.hz * 2,
                config.box.widthSegments,
                config.box.heightSegments,
                config.box.depthSegments
            );
            break;
        case "sphere":
            geometry = new THREE.SphereGeometry(
                shape.radius,
                config.sphere.widthSegments,
                config.sphere.heightSegments
            );
            break;
        case "cylinder":
            geometry = new THREE.CylinderGeometry(
                shape.radius,
                shape.radius,
                shape.height,
                config.cylinder.radialSegments,
                config.cylinder.heightSegments
            );
            geometry.rotateX(Math.PI / 2);
            break;
        case "mesh":
            geometry = new THREE.BufferGeometry();
            // Tensor-authored vertices/faces arrive blob-decoded as flat
            // Float32Arrays (which have no .flat()); hand-authored data as
            // nested lists -- same dual shape toFlatFloat32Array covers for
            // points. Faces additionally need an integer index buffer: Uint32,
            // not Uint16, so meshes past 65535 vertices don't silently wrap.
            const positions = toFlatFloat32Array(shape.vertices);
            geometry.setAttribute(
                "position",
                new THREE.BufferAttribute(positions, 3)
            );
            const faceSource = ArrayBuffer.isView(shape.faces)
                ? shape.faces
                : shape.faces.flat();
            const indices = new Uint32Array(faceSource);
            geometry.setIndex(new THREE.BufferAttribute(indices, 1));
            geometry.computeVertexNormals();
            break;
        case "pointcloud":
            geometry = null; // Handled separately in createVisualRepresentations
            break;
        default:
            console.error("Invalid shape type:", shape.type);
            return null;
    }
    return geometry;
}

/**
 * Creates a THREE.js Points object from a point cloud
 * @param {Array<Array<number>>|Float32Array} pointCloud - 3D points, nested or flat
 * @param {PointsConfig} [pointsConfig={}] - Configuration for points appearance
 * @param {boolean} [visible=false] - Initial visibility of the points
 * @param {Array<Array<number>>|Float32Array|null} [colors=null] - Optional
 *   per-point RGB in [0,1], nested or flat, same length as pointCloud. When
 *   present, enables per-vertex coloring (material.vertexColors = true).
 * @returns {THREE.Points|null} The created Points object or null if pointCloud is empty
 */
export function createPoints(pointCloud, pointsConfig, visible = true, colors = null) {
    if (!pointCloud || pointCloud.length === 0) return null;
    const config = { ...DEFAULT_POINTS_CONFIG, ...pointsConfig };
    const geometry = new THREE.BufferGeometry();
    const positions = toFlatFloat32Array(pointCloud);
    geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3)
    );

    const material = new THREE.PointsMaterial({
        size: config.size,
        opacity: config.opacity,
        alphaTest: config.alphaTest,
        transparent: config.transparent,
        sizeAttenuation: config.sizeAttenuation,
    });

    if (colors) {
        geometry.setAttribute(
            "color",
            new THREE.Float32BufferAttribute(toFlatFloat32Array(colors), 3)
        );
        material.vertexColors = true;
    }

    if (config.texture) {
        const texture = new THREE.TextureLoader().load(config.texture);
        texture.colorSpace = THREE.SRGBColorSpace;
        material.map = texture;
    }

    if (config.color) {
        material.color = new THREE.Color(config.color);
    }
    // Create points object
    const points = new THREE.Points(geometry, material);
    points.isPoints = true;
    points.visible = visible;
    return points;
}

/**
 * Creates a THREE.js Points object from a point cloud
 * @param {Array<Array<number>>} pointCloud - Array of 3D points
 * @param {PointsConfig} [pointsConfig={}] - Configuration for points appearance
 * @param {boolean} [visible=false] - Initial visibility of the points
 * @returns {THREE.Points|null} The created Points object or null if pointCloud is empty
 */
export function createContactPoints(pointCloud, pointsConfig) {
    if (!pointCloud || pointCloud.length === 0) return null;

    const config = { ...DEFAULT_POINTS_CONFIG, ...pointsConfig };

    const geometry = new THREE.BufferGeometry();
    const positions = toFlatFloat32Array(pointCloud);
    geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3)
    );

    const material = new THREE.ShaderMaterial({
        uniforms: {
            color: { value: new THREE.Color(config.color) },
            opacity: { value: config.opacity },
            sizeAttenuation: { value: config.sizeAttenuation !== false },
            useTexture: { value: false },
            pointTexture: { value: null },
            alphaTest: { value: 0.5 }, // Add alphaTest uniform
        },
        vertexShader: `
      attribute float size;
      uniform bool sizeAttenuation;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        // Handle size attenuation
        if (sizeAttenuation) {
          gl_PointSize = size * (300.0 / -mvPosition.z);
        } else {
          gl_PointSize = size;
        }
      }
    `,
        fragmentShader: `
      uniform vec3 color;
      uniform float opacity;
      uniform bool useTexture;
      uniform sampler2D pointTexture;
      uniform float alphaTest;

      void main() {
        // Create a circular point with smooth edges
        vec2 center = gl_PointCoord - vec2(0.5);
        float dist = length(center) * 2.0;

        // Smooth circle with anti-aliasing
        float alpha = 1.0 - smoothstep(0.8, 1.0, dist);

        // Apply alpha test
        if (alpha < alphaTest) discard;

        vec4 outputColor = vec4(color, alpha * opacity);
        if (useTexture) {
          vec4 texColor = texture2D(pointTexture, gl_PointCoord);
          outputColor *= texColor;
        }

        gl_FragColor = outputColor;
      }
    `,
        transparent: true,
        depthWrite: false, // Important for proper transparency
        depthTest: true,
    });

    // If texture is provided, load and set it
    if (config.texture) {
        const texture = new THREE.TextureLoader().load(config.texture);
        material.uniforms.pointTexture.value = texture;
        material.uniforms.useTexture.value = true;
    }

    const points = new THREE.Points(geometry, material);
    points.visible = config.visible !== false;

    return points;
}

/**
 * Creates a wireframe representation of a geometry
 * @param {THREE.BufferGeometry} geometry - The geometry to create wireframe from
 * @param {WireframeConfig} [wireframeConfig={}] - Configuration for wireframe appearance
 * @param {boolean} [visible=false] - Initial visibility of the wireframe
 * @returns {THREE.LineSegments} The created wireframe object
 */
export function createWireframe(geometry, wireframeConfig, visible = true) {
    if (!geometry) return null;

    const config = { ...DEFAULT_WIREFRAME_CONFIG, ...wireframeConfig };

    const wireframe = new THREE.LineSegments(
        new THREE.WireframeGeometry(geometry),
        new THREE.LineBasicMaterial(config)
    );
    wireframe.visible = visible;
    wireframe.isWireframe = true;
    return wireframe;
}

/**
 * Creates a THREE.js mesh with standard material and environment mapping
 * @param {THREE.BufferGeometry} geometry - The geometry for the mesh
 * @param {MeshConfig} [meshConfig={}] - Configuration for mesh appearance
 * @param {boolean} [visible=true] - Initial visibility of the mesh
 * @returns {THREE.Mesh} The created mesh object
 */
export function createMesh(geometry, meshConfig, visible = true) {
    if (!geometry) return null;

    const config = { ...DEFAULT_MESH_CONFIG, ...meshConfig };

    let envMap = null;
    if (config.envMapPath) {
        const format = ".jpg";
        const urls = [
            config.envMapPath + "nx" + format,
            config.envMapPath + "px" + format,
            config.envMapPath + "pz" + format,
            config.envMapPath + "nz" + format,
            config.envMapPath + "py" + format,
            config.envMapPath + "ny" + format,
        ];
        envMap = new THREE.CubeTextureLoader().load(urls);
    }

    const material = new THREE.MeshStandardMaterial({
        color: config.color,
        roughness: config.roughness,
        metalness: config.metalness,
        opacity: config.opacity,
        envMapIntensity: config.envMapIntensity,
        transparent: config.transparent,
        envMap: envMap,
        side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.isMesh = true;
    mesh.visible = visible;
    return mesh;
}

/**
 * Creates a single arrow
 * @param {THREE.Vector3} start - Starting point of the arrow
 * @param {THREE.Vector3} end - End point of the arrow
 * @param {ArrowConfig} [arrowConfig={}] - Arrow configuration
 * @returns {THREE.ArrowHelper} The created arrow object
 */
export function createArrow(start, end, arrowConfig = {}) {
    const config = { ...DEFAULT_ARROW_CONFIG, ...arrowConfig };
    const dir = end.clone().sub(start);
    const length = dir.length();

    const arrow = new THREE.ArrowHelper(
        dir.normalize(),
        start,
        length,
        config.color,
        config.headLength,
        config.headWidth
    );

    arrow.line.material.linewidth = config.lineWidth;
    return arrow;
}

// sRGB hex <-> CIE LCh (D65), the same math chroma-js's "lch" mode uses.
const SRGB_TO_XYZ = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.072175],
    [0.0193339, 0.119192, 0.9503041],
];
const XYZ_TO_SRGB = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.969266, 1.8760108, 0.041556],
    [0.0556434, -0.2040259, 1.0572252],
];
const D65 = [0.95047, 1, 1.08883];
const LAB_E = 216 / 24389;
const LAB_K = 24389 / 27;
const mul = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

function hexToLch(hex) {
    const n = parseInt(hex.slice(1), 16);
    const linear = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
        c /= 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const [fx, fy, fz] = mul(SRGB_TO_XYZ, linear).map((v, i) => {
        v /= D65[i];
        return v > LAB_E ? Math.cbrt(v) : (LAB_K * v + 16) / 116;
    });
    const a = 500 * (fx - fy);
    const b = 200 * (fy - fz);
    const c = Math.hypot(a, b);
    // Greys have no hue: NaN, so interpolation borrows the other end's.
    const h = Math.round(c * 1e4) === 0 ? NaN : (Math.atan2(b, a) * 180) / Math.PI;
    return [116 * fy - 16, c, h];
}

function lchToHex([L, c, h]) {
    const rad = ((Number.isNaN(h) ? 0 : h) * Math.PI) / 180;
    const fy = (L + 16) / 116;
    const fx = fy + (c * Math.cos(rad)) / 500;
    const fz = fy - (c * Math.sin(rad)) / 200;
    const xyz = [
        fx ** 3 > LAB_E ? fx ** 3 : (116 * fx - 16) / LAB_K,
        L > 8 ? fy ** 3 : L / LAB_K,
        fz ** 3 > LAB_E ? fz ** 3 : (116 * fz - 16) / LAB_K,
    ].map((v, i) => v * D65[i]);
    const rgb = mul(XYZ_TO_SRGB, xyz).map((v) => {
        const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
        return Math.round(Math.min(255, Math.max(0, s * 255)));
    });
    return "#" + ((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]).toString(16).padStart(6, "0");
}

function mixLch([l0, c0, h0], [l1, c1, h1], f) {
    let h = Number.isNaN(h0) ? h1 : h0;
    if (!Number.isNaN(h0) && !Number.isNaN(h1)) {
        const dh = ((((h1 - h0) % 360) + 540) % 360) - 180; // shortest arc
        h = h0 + f * dh;
    }
    return [l0 + f * (l1 - l0), c0 + f * (c1 - c0), h];
}

// `numColors` hex colors: the given ones as-is while they last, otherwise an
// LCH interpolation through them (neighbours then get closer in hue).
export function categoricalPalette(colors, numColors) {
    if (numColors <= colors.length) return colors.slice(0, numColors);
    const lch = colors.map(hexToLch);
    const segments = lch.length - 1;
    return Array.from({ length: numColors }, (_, i) => {
        const t = (i / (numColors - 1)) * segments;
        const k = Math.min(Math.floor(t), segments - 1);
        return lchToHex(mixLch(lch[k], lch[k + 1], t - k));
    });
}
