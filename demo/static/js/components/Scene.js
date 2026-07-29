import * as THREE from "three";
import { setupControls } from "./InteractionControls.js";
import {
    SCENE_CONFIG,
    RENDERER_CONFIG,
    CAMERA_CONFIG,
    LIGHTING_CONFIG,
} from "../config.js";

export class Scene {
    constructor(app) {
        this.app = app;
        this.scene = new THREE.Scene();
        this.initScene();
        this.minRenderDelay = 1000 / 60; // 60 FPS
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
    }

    initScene() {
        THREE.Object3D.DEFAULT_UP.set(...SCENE_CONFIG.defaultUp);
        const renderer = this.createRenderer();
        const camera = this.createCamera();
        const controls = setupControls(camera, renderer);
        this.setupLighting(this.scene);
        const light = new THREE.DirectionalLight(0xffffff, 1);
        light.position.set(10, 10, 10);
        this.scene.add(light);
        this.renderer = renderer;
        this.camera = camera;
        this.controls = controls;
        this.setupWindowHandlers();
    }

    setupWindowHandlers() {
        window.addEventListener("resize", () => this.#handleWindowResize());
        window.addEventListener("error", (event) => this.#handleError(event));
    }

    #handleWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    }

    #handleError(event) {
        console.error("Application Error:", {
            message: event.message,
            source: event.filename,
            lineNumber: event.lineno,
            columnNumber: event.colno,
            error: event.error,
        });
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

    animate(now) {
        if (now - this.lastRenderTime < this.minRenderDelay) return;
        
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
