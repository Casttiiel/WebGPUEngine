import { vec3 } from "gl-matrix";
import { Transform } from "../../core/math/Transform";
import { Component } from "../../core/ecs/Component";
import { TransformComponentDataType } from "../../types/TransformComponentData.type";

export class TransformComponent extends Component {
    private transform: Transform;

    constructor() {
        super();
        this.transform = new Transform();
    }

    public async load(data: TransformComponentDataType): Promise<void> {
        if (data.position) {
            this.transform.setPosition(data.position);
        }

        if (data.rotation) {
            this.transform.setAngles(data.rotation[1], data.rotation[0], data.rotation[2]);
        }

        if (data.scale) {
            const scale = vec3.fromValues(
                data.scale[0] ?? 1,
                data.scale[1] ?? 1,
                data.scale[2] ?? 1
            );
            this.transform.setScale(scale);
        }
    }

    public update(dt: number): void {
        // Transform components don't need update logic by default
    }

    public renderInMenu(): void {
        
    }

    public renderDebug(): void {
        // Transform debug visualization could be implemented here
        // For example, showing axis gizmos
    }

    public getTransform(): Transform {
        return this.transform;
    }
}