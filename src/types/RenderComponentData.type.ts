
export type RenderComponentDataType = Readonly<{
    meshes?: ReadonlyArray<RenderComponentMeshDataType>;
    gltf?: RenderComponentGLTFDataType;
}>;

export type RenderComponentMeshDataType = Readonly<{
    mesh: string;
    material: string;
    instances_group?: number;
    visible?: boolean;
    state?: number;
}>;

export type RenderComponentGLTFDataType = Readonly<{
    path: string;           // Ruta al archivo .gltf o .glb
    defaultMaterial?: string; // Material por defecto para meshes sin material
    scale?: number;        // Factor de escala para el modelo
    visible?: boolean;     // Visibilidad inicial
}>;