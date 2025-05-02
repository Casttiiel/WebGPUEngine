import { Camera } from "../../core/math/Camera";
import { Component } from "../../core/ecs/Component";

export class CameraComponent extends Component {
    private camera: Camera;

    constructor() {
        super();
        this.camera = new Camera();
    }

    public async load(data: unknown): Promise<void> {
        if (data.fov) {
            this.camera.setFov(data.fov);
        }

        if (data.aspect) {
            this.camera.setAspectRatio(data.aspect);
        }

        if (data.near) {
            this.camera.setNearPlane(data.near);
        }

        if (data.far) {
            this.camera.setFarPlane(data.far);
        }

        if (data.position && data.target) {
            const up = data.up || [0, 1, 0];
            this.camera.lookAt(data.position, data.target, up);
        }
    }

    public setCamera(camera: Camera): void {
        this.camera = camera;
    }

    public update(): void {
        // Camera update logic here
    }

    public renderInMenu(): void {
    }

    public renderDebug(): void {
        // Camera debug visualization logic here
    }

    public getCamera(): Camera {
        return this.camera;
    }
}