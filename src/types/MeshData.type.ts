export interface MeshAttributeData {
    data: Float32Array | number[];
    componentType: number;
    normalized?: boolean;
    count: number;
    byteOffset?: number;
    byteStride?: number;
}

export interface MeshAttributes {
    POSITION: MeshAttributeData;
    NORMAL: MeshAttributeData;
    TEXCOORD_0: MeshAttributeData;
    TANGENT?: MeshAttributeData;
}

export interface MeshIndexData {
    data: Uint16Array | Uint32Array | number[];
    componentType: number;
    count: number;
    byteOffset?: number;
}

export interface MeshData {
    attributes: MeshAttributes;
    indices: MeshIndexData;
}
