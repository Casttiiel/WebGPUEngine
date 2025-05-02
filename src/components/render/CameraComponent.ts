import { Camera } from "../../core/math/Camera";
import { Component } from "../../core/ecs/Component";
import { CameraComponentDataType } from "../../types/CameraComponentData.type";
import { Engine } from "../../core/engine/Engine";
import { KeyCode } from "../../types/KeyCode.enum";
import { MouseButton } from "../../types/MouseButton.enum";
import { mat4, vec3 } from "gl-matrix";

export class CameraComponent extends Component {
    private camera: Camera;
    private isControllable: boolean = false;
    private rotationSpeed: number = 0.005;

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
        
        if(data.controllable){
            this.isControllable = data.controllable;
        }

        const position = data.position || [0, 5, 10];
        const target = data.target || [0, 0, 0];
        const up = data.up || [0, 1, 0];
        this.camera.lookAt(position, target, up);
    }

    public setCamera(camera: Camera): void {
        this.camera = camera;
    }

    public update(dt: number): void {
        if(!this.isControllable) return;

        const input = Engine.getInput();
        const multiplier = input.isKeyPressed(KeyCode.SHIFT) ? 10.0 : 1.0;

        // Movimiento de la cámara
        if (input.isKeyPressed(KeyCode.A))
            this.camera.move(Array.from(this.camera.getLocalVector([4.0 * multiplier * dt, 0, 0])));
        if (input.isKeyPressed(KeyCode.D))
            this.camera.move(Array.from(this.camera.getLocalVector([-4.0 * multiplier * dt, 0, 0])));
        if (input.isKeyPressed(KeyCode.W))
            this.camera.move(Array.from(this.camera.getLocalVector([0, 0, 4.0 * multiplier * dt])));
        if (input.isKeyPressed(KeyCode.S))
            this.camera.move(Array.from(this.camera.getLocalVector([0, 0, -4.0 * multiplier * dt])));

        // Rotación de la cámara con el ratón
        if (input.isMouseButtonPressed(MouseButton.RIGHT)) {
            const mouseDelta = input.getMouseDelta();
            this.camera.rotate(-mouseDelta.x * this.rotationSpeed, -mouseDelta.y * this.rotationSpeed);
        }
    }

    public renderInMenu(): void {

    }

    public renderDebug(): void {
        // Implementar visualización de debug de la cámara si es necesario
    }

    public getCamera(): Camera {
        return this.camera;
    }
}