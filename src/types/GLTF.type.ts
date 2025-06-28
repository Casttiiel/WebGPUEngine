// GLTF 2.0 Type Definitions
export interface GLTFAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  max?: number[];
  min?: number[];
  normalized?: boolean;
  type: string;
}

export interface GLTFBufferView {
  buffer: number;
  byteLength: number;
  byteOffset?: number;
  byteStride?: number;
  target?: number;
}

export interface GLTFBuffer {
  byteLength: number;
  uri?: string;
}

export interface GLTFImage {
  uri?: string;
  mimeType?: string;
  bufferView?: number;
  name?: string;
}

export interface GLTFTexture {
  sampler?: number;
  source?: number;
  name?: string;
}

export interface GLTFTextureInfo {
  index: number;
  texCoord?: number;
}

export interface GLTFNormalTextureInfo extends GLTFTextureInfo {
  scale?: number;
}

export interface GLTFOcclusionTextureInfo extends GLTFTextureInfo {
  strength?: number;
}

export interface GLTFPbrMetallicRoughness {
  baseColorFactor?: number[];
  baseColorTexture?: GLTFTextureInfo;
  metallicFactor?: number;
  roughnessFactor?: number;
  metallicRoughnessTexture?: GLTFTextureInfo;
}

export interface GLTFMaterial {
  name?: string;
  pbrMetallicRoughness?: GLTFPbrMetallicRoughness;
  normalTexture?: GLTFNormalTextureInfo;
  occlusionTexture?: GLTFOcclusionTextureInfo;
  emissiveTexture?: GLTFTextureInfo;
  emissiveFactor?: number[];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided?: boolean;
}

export interface GLTFMeshPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
}

export interface GLTFMesh {
  name?: string;
  primitives: GLTFMeshPrimitive[];
  weights?: number[];
}

export interface GLTFNode {
  name?: string;
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  weights?: number[];
}

export interface GLTFScene {
  name?: string;
  nodes?: number[];
}

export interface GLTF {
  accessors?: GLTFAccessor[];
  buffers?: GLTFBuffer[];
  bufferViews?: GLTFBufferView[];
  images?: GLTFImage[];
  materials?: GLTFMaterial[];
  meshes?: GLTFMesh[];
  nodes?: GLTFNode[];
  scenes?: GLTFScene[];
  scene?: number;
  textures?: GLTFTexture[];
  asset: {
    version: string;
    generator?: string;
  };
}

// Helper types for mesh data
export interface GLTFAttributeData {
  data: number[];
  size: number;
}

export interface GLTFIndexData {
  data: number[];
  count: number;
  type: number;
}
