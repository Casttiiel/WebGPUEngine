import { Entity } from "../ecs/Entity";
import { Engine } from "../engine/Engine";
import { RenderComponent } from "../../components/render/RenderComponent";
import { TransformComponent } from "../../components/core/TransformComponent";
import { NameComponent } from "../../components/core/NameComponent";
import { vec3 } from "gl-matrix";

export class GLTFLoader {
    private static async loadBinaryFile(url: string): Promise<ArrayBuffer> {
        const response = await fetch(url);
        return response.arrayBuffer();
    }

    public static async loadGLTF(path: string, parentEntity: Entity, defaultMaterial: string = "default.mat", scale: number = 1.0): Promise<void> {
        try {
            // 1. Cargar el archivo GLTF
            const gltfResponse = await fetch(`/assets/meshes/${path}`);
            const gltf = await gltfResponse.json();

            // 2. Cargar el archivo .bin asociado si existe
            let binData: ArrayBuffer | null = null;
            if (gltf.buffers && gltf.buffers[0]) {
                const binPath = gltf.buffers[0].uri;
                const fullBinPath = `/assets/meshes/${binPath}`;
                binData = await this.loadBinaryFile(fullBinPath);
            }

            // 3. Procesar cada nodo del GLTF y crear entidades
            if (gltf.nodes) {
                for (const node of gltf.nodes) {
                    await this.processNode(node, parentEntity, gltf, binData, defaultMaterial, scale);
                }
            }

        } catch (error) {
            console.error("Error loading GLTF:", error);
        }
    }

    private static async processNode(
        node: any,
        parentEntity: Entity,
        gltf: any,
        binData: ArrayBuffer | null,
        defaultMaterial: string,
        scale: number
    ): Promise<Entity> {
        // Crear una nueva entidad para este nodo
        const entity = new Entity();
        Engine.getEntities().addEntity(entity);
        parentEntity.addChildren(entity);

        // Añadir componente de nombre
        const nameComp = new NameComponent();
        await nameComp.load(node.name || "GLTFNode");
        entity.addComponent("name", nameComp);
        Engine.getEntities().addComponentToManager(nameComp, "name");

        // Añadir componente de transformación
        const transformComp = new TransformComponent();
        const transformData = {
            position: node.translation ? vec3.fromValues(
                node.translation[0] * scale,
                node.translation[1] * scale,
                node.translation[2] * scale
            ) : vec3.create(),
            rotation: node.rotation ? vec3.fromValues(
                node.rotation[0],
                node.rotation[1],
                node.rotation[2]
            ) : vec3.create(),
            scale: node.scale ? vec3.fromValues(
                node.scale[0] * scale,
                node.scale[1] * scale,
                node.scale[2] * scale
            ) : vec3.fromValues(scale, scale, scale)
        };
        await transformComp.load(transformData);
        entity.addComponent("transform", transformComp);
        Engine.getEntities().addComponentToManager(transformComp, "transform");

        // Si el nodo tiene una mesh, añadir componente de render
        if (node.mesh !== undefined) {
            const renderComp = new RenderComponent();
            // TODO: Procesar la mesh y sus materiales
            // Por ahora usamos un material por defecto
            const renderData = {
                meshes: [{
                    mesh: `${gltf.meshes[node.mesh].name}.obj`, // Asumiendo que tenemos la mesh convertida
                    material: defaultMaterial,
                    visible: true
                }]
            };
            await renderComp.load(renderData);
            entity.addComponent("render", renderComp);
            Engine.getEntities().addComponentToManager(renderComp, "render");
        }

        // Procesar nodos hijos recursivamente
        if (node.children) {
            for (const childIndex of node.children) {
                const childNode = gltf.nodes[childIndex];
                await this.processNode(childNode, entity, gltf, binData, defaultMaterial, scale);
            }
        }

        return entity;
    }
}
