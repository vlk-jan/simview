import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
    FREQ_CONFIG,
    RENDERER_CONFIG,
    CAMERA_CONFIG,
    CONTROLS_CONFIG,
    LIGHTING_CONFIG,
} from "../config.js";
import { cameraRangeForBounds } from "../utils/cameraRange.js";

export class Scene {
    constructor(app) {
        this.app = app;
        this.scene = new THREE.Scene();
        this.initScene();
        this.minRenderDelay = 1000 / FREQ_CONFIG.scene;
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
        this.setupInvalidation();
    }

    // The canvas only needs redrawing when something may have changed.
    // Mutations are scattered (GUI toggles, panels, data landing), so rather
    // than hooking each one, any user input or camera move marks the scene
    // dirty, playback/recording/new frames always render, and an idle
    // heartbeat repaints anything else (e.g. a Range window landing while
    // paused) within IDLE_RENDER_MS.
    static IDLE_RENDER_MS = 250;
    invalidate() {
        this.needsRender = true;
    }

    setupInvalidation() {
        this.needsRender = true;
        this._lastFrameIndex = null;
        const mark = () => this.invalidate();
        // pointermove only while a button is held: drags orbit/pan the camera.
        this._onInput = (e) => {
            if (e.type !== "pointermove" || e.buttons) this.invalidate();
        };
        this._inputEvents = [
            "pointerdown", "pointermove", "pointerup", "wheel",
            "keydown", "keyup", "input", "change", "click",
        ];
        this._inputEvents.forEach((t) =>
            window.addEventListener(t, this._onInput, { capture: true, passive: true })
        );
        this.controls.addEventListener("change", mark);
    }

    #shouldRender(now) {
        const ac = this.app.animationController;
        if (
            this.needsRender ||
            ac?.isPlaying ||
            ac?.isRecording ||
            ac?.currentStateIndex !== this._lastFrameIndex ||
            now - this.lastRenderTime >= Scene.IDLE_RENDER_MS
        ) {
            this._lastFrameIndex = ac?.currentStateIndex;
            return true;
        }
        return false;
    }

    initScene() {
        THREE.Object3D.DEFAULT_UP.set(...CAMERA_CONFIG.up);
        const renderer = this.createRenderer();
        const camera = this.createCamera();
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.listenToKeyEvents(window);
        Object.assign(controls, CONTROLS_CONFIG);
        controls.addEventListener("start", () => {
            document.body.style.cursor = "grabbing";
        });
        controls.addEventListener("end", () => {
            document.body.style.cursor = "auto";
        });
        this.setupLighting(this.scene);
        this.renderer = renderer;
        this.camera = camera;
        this.controls = controls;
        this.setupWindowHandlers();
    }

    // Sizes the camera's far plane and the orbit distance limit to the scene
    // actually being viewed. Called once the terrain is known (see
    // SimView.initFromModel) -- the config defaults are floors chosen for
    // small scenes, and a several-hundred-metre recording clips against them.
    applySceneExtent(bounds) {
        const { far, maxDistance } = cameraRangeForBounds(bounds, {
            far: CAMERA_CONFIG.far,
            maxDistance: CONTROLS_CONFIG.maxDistance,
        });
        if (this.camera && this.camera.far !== far) {
            this.camera.far = far;
            this.camera.updateProjectionMatrix();
        }
        if (this.controls) this.controls.maxDistance = maxDistance;
    }

    setupWindowHandlers() {
        this._onResize = () => this.#handleWindowResize();
        window.addEventListener("resize", this._onResize);
    }

    // Drops the window listeners (resize here, keydown inside OrbitControls)
    // and the GL context, so an embedded viewer's destroy() doesn't keep the
    // whole Scene reachable from window.
    dispose() {
        if (this._onResize) {
            window.removeEventListener("resize", this._onResize);
            this._onResize = null;
        }
        this._inputEvents?.forEach((t) =>
            window.removeEventListener(t, this._onInput, { capture: true })
        );
        this._inputEvents = null;
        this.controls?.dispose();
        this.renderer?.dispose();
        this.renderer?.domElement?.remove();
    }

    #handleWindowResize() {
        this.invalidate(); // resizing clears the canvas
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    createRenderer() {
        const renderer = new THREE.WebGLRenderer({
            antialias: RENDERER_CONFIG.antialias,
            preserveDrawingBuffer: RENDERER_CONFIG.preserveDrawingBuffer,
        });

        renderer.setPixelRatio(RENDERER_CONFIG.pixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setClearColor(
            RENDERER_CONFIG.clearColor,
            RENDERER_CONFIG.clearAlpha
        );

        document.body.appendChild(renderer.domElement);
        return renderer;
    }

    createCamera() {
        const camera = new THREE.PerspectiveCamera(
            CAMERA_CONFIG.fov,
            window.innerWidth / window.innerHeight,
            CAMERA_CONFIG.near,
            CAMERA_CONFIG.far
        );

        camera.position.set(...CAMERA_CONFIG.position);
        camera.up.set(...CAMERA_CONFIG.up);

        return camera;
    }

    setupLighting(scene) {
        // Ambient light
        const ambientLight = new THREE.AmbientLight(
            LIGHTING_CONFIG.ambient.color,
            LIGHTING_CONFIG.ambient.intensity
        );
        scene.add(ambientLight);

        // Directional light
        const directionalLight = new THREE.DirectionalLight(
            LIGHTING_CONFIG.directional.color,
            LIGHTING_CONFIG.directional.intensity
        );
        directionalLight.position.set(...LIGHTING_CONFIG.directional.position);
        scene.add(directionalLight);
    }

    addObject3D(object) {
        this.scene.add(object);
    }

    removeObject3D(object) {
        this.scene.remove(object);
    }

    // Throttled to FREQ_CONFIG.scene. In split-screen mode, renders batches A
    // and B side by side, shifting the camera by each batch's offset from the
    // active one for its half of the viewport.
    animate(now) {
        // The -1 absorbs rAF timestamp jitter: at 60 Hz the deltas hover
        // around 16.67 ms and would otherwise drop every other frame.
        if (now - this.lastRenderTime < this.minRenderDelay - 1) return;
        if (!this.#shouldRender(now)) return;
        this.needsRender = false;

        if (this.app.uiState && this.app.uiState.splitScreen && this.app.batchManager && this.app.batchManager.simBatches >= 2) {
            const batchA = this.app.uiState.splitBatchA !== undefined ? this.app.uiState.splitBatchA : 0;
            const batchB = this.app.uiState.splitBatchB !== undefined ? this.app.uiState.splitBatchB : 1;

            const activeBatch = this.app.batchManager.currentlyActiveBatch;
            const activeOffset = this.app.batchManager.getBatchOffset(activeBatch);
            const offsetA = this.app.batchManager.getBatchOffset(batchA);
            const offsetB = this.app.batchManager.getBatchOffset(batchB);

            const deltaA = new THREE.Vector3(offsetA.x - activeOffset.x, offsetA.y - activeOffset.y, offsetA.z - activeOffset.z);
            const deltaB = new THREE.Vector3(offsetB.x - activeOffset.x, offsetB.y - activeOffset.y, offsetB.z - activeOffset.z);

            const width = window.innerWidth;
            const height = window.innerHeight;
            const aspectFull = width / height;
            const aspectSplit = (width / 2) / height;

            this.renderer.setScissorTest(true);
            this.camera.aspect = aspectSplit;
            this.camera.updateProjectionMatrix();

            // Render Left (Batch A)
            this.renderer.setViewport(0, 0, width / 2, height);
            this.renderer.setScissor(0, 0, width / 2, height);
            this.camera.position.add(deltaA);
            this.camera.updateMatrixWorld();
            this.renderer.render(this.scene, this.camera);
            this.camera.position.sub(deltaA);

            // Render Right (Batch B)
            this.renderer.setViewport(width / 2, 0, width / 2, height);
            this.renderer.setScissor(width / 2, 0, width / 2, height);
            this.camera.position.add(deltaB);
            this.camera.updateMatrixWorld();
            this.renderer.render(this.scene, this.camera);
            this.camera.position.sub(deltaB);

            // Restore
            this.camera.aspect = aspectFull;
            this.camera.updateProjectionMatrix();
            this.renderer.setScissorTest(false);
            this.renderer.setViewport(0, 0, width, height);
            this.renderer.setScissor(0, 0, width, height);
        } else {
            this.renderer.setScissorTest(false);
            this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
            this.renderer.render(this.scene, this.camera);
        }

        this.lastRenderTime = now;
    }
}
