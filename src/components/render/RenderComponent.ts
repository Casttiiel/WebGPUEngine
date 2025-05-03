import { Component } from "../../core/ecs/Component";
import { Mesh } from "../../renderer/resources/Mesh";
import { Material } from "../../renderer/resources/material";
import { TransformComponent } from "../core/TransformComponent";
import { RenderComponentDataType, RenderComponentMeshDataType } from "../../types/RenderComponentData.type";
import { MeshPartType } from "../../types/MeshPart.type";
import { RenderManager } from "../../renderer/core/RenderManager";
import { Transform } from "../../core/math/Transform";

export class RenderComponent extends Component {
    private isVisible: boolean = true;
    private parts: MeshPartType[] = [];
    private currentState: number = 0;

    constructor() {
        super();
    }

    public async load(data: RenderComponentDataType): Promise<void> {
        for (const meshData of data.meshes) {
            await this.readMesh(meshData);
        }

        this.updateRenderManager();
    }

    private async readMesh(data: RenderComponentMeshDataType): Promise<void> {
        if (!data.mesh) {
            throw new Error(`Missing attribute 'mesh' in input JSON: ${JSON.stringify(data)}`);
        }

        const mesh = await Mesh.get(data.mesh);

        const materialName = data.material || "default_material";
        const material = await Material.get(materialName);
        material.getTechnique().createRenderPipeline(mesh);

        const meshPart: MeshPartType = {
            mesh,
            material,
            meshGroup: 0,
            meshInstancesGroup: data.instances_group || 0,
            isVisible: data.visible !== undefined ? data.visible : true,
            state: data.state || 0,
        };

        this.parts.push(meshPart);
    }

    public showMeshesWithState(newState: number): void {
        this.currentState = newState;
        for (const part of this.parts) {
            part.isVisible = part.state === newState;
        }
        this.updateRenderManager();
    }

    private getWorldTransform(): Transform {
        const entity = this.getOwner();
        const transformComponent = entity.getComponent("transform") as TransformComponent;
        if (!transformComponent) {
            throw new Error("Transform component not found");
        }

        let worldTransform = transformComponent.getTransform();
        let parent = entity.getParent();
        
        // Combinar con las transformaciones de los padres en orden desde el más cercano al más lejano
        while (parent) {
            const parentTransform = parent.getComponent("transform") as TransformComponent;
            if (parentTransform) {
                worldTransform = parentTransform.getTransform().combineWith(worldTransform);
            }
            parent = parent.getParent();
        }

        return worldTransform;
    }

    private updateRenderManager(): void {
        const renderManager = RenderManager.getInstance();
        const worldTransform = this.getWorldTransform();

        renderManager.delKeys(this);

        for (const part of this.parts) {
            if (!part.isVisible || !this.isVisible) continue;
            renderManager.addKey(
                this,
                part.mesh,
                part.material,
                worldTransform,
                part.meshGroup,
                part.meshInstancesGroup
            );
        }
    }

    public update(dt: number): void {
        throw new Error("Method not implemented.");
    }

    public renderInMenu(): void {
    }

    public renderDebug(): void {
        throw new Error("Method not implemented.");
    }
}