import { Camera } from "../../core/math/Camera";
import { Component } from "../../core/ecs/Component";
import { CameraComponentDataType } from "../../types/CameraComponentData.type";

export class CameraComponent extends Component {
    private camera: Camera;

    constructor() {
        super();
        this.camera = new Camera();
    }

    public async load(data: CameraComponentDataType): Promise<void> {
        if (data.near) {
            this.camera.setNearPlane(data.near);
        }

        if (data.far) {
            this.camera.setFarPlane(data.far);
        }

        if (data.fov) {
            this.camera.setFov(data.fov);
        }

        if (data.viewport) {
            this.camera.setViewport(data.viewport.width, data.viewport.height);
        }

        const position = data.position || [0, 5, 10];
        const target = data.target || [0, 0, 0];
        const up = data.up || [0, 1, 0];
        this.camera.lookAt(position, target, up);
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