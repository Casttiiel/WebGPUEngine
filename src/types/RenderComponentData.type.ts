
export type RenderComponentDataType = Readonly<{
    meshes: ReadonlyArray<RenderComponentMeshDataType>;
}>;

export type RenderComponentMeshDataType = Readonly<{
    mesh: string;
    material: string;
    instances_group?: number;
    visible?: boolean;
    state?: number;
}>;