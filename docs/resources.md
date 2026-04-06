# WebGPU Engine Resource System

## Overview

The WebGPU Engine implements a robust resource management system that handles loading, caching, referencing, and automatic cleanup of all game assets. This system is designed to optimize memory usage, avoid duplications, and provide efficient access to GPU resources.

---

## 🏗️ Resource System Architecture

### **Class Hierarchy**

```
IResource (Interface)
├── BaseResource (Abstract)
    ├── GPUResource (Abstract)
        ├── Mesh
        ├── Texture
        ├── Material
        ├── Technique
        ├── Cubemap
        └── HDRTexture
```

### **ResourceManager - Central Manager**

The `ResourceManager` acts as the central registry and factory for all resources:

#### **Main Features:**

- **Global Cache**: Prevents resource duplication
- **Reference Counting**: Automatic memory management
- **Async Loading**: Asynchronous loading of all assets
- **Dependency Tracking**: Tracks dependencies between resources

#### **Main API:**

```typescript
export class ResourceManager {
  // Get existing resource or throw error
  public static getResource<T extends IResource>(path: string): T;

  // Register new resource in cache
  public static registerResource<T extends IResource>(resource: T): void;

  // Clean up resource when refCount reaches 0
  public static unregisterResource(path: string): void;

  // Loading utilities by type
  public static async loadMeshData(meshPath: string): Promise<string>;
  public static async loadMaterialData(materialPath: string): Promise<MaterialDataType>;
  public static async loadTechniqueData(techniquePath: string): Promise<TechniqueDataType>;
  public static async loadShader(shaderPath: string): Promise<string>;
}
```

---

## 🔧 Interfaces and Base Classes

### **IResource - Main Interface**

```typescript
export interface IResource {
  readonly path: string; // Unique resource path
  readonly type: ResourceType; // Resource type (MESH, TEXTURE, etc.)
  readonly hasData: boolean; // Whether data is loaded
  readonly dependencies: Set<string>; // Dependencies on other resources
  refCount: number; // Reference counter

  load(): Promise<void>; // Asynchronous resource loading
  addRef(): void; // Increment reference
  release(): void; // Decrement reference
}
```

### **BaseResource - Base Implementation**

```typescript
export abstract class BaseResource implements IResource {
  public readonly path: string;
  public readonly type: ResourceType;
  public readonly dependencies: Set<string>;
  private _hasData: boolean = false;
  private _refCount: number = 0;

  // Reference management for garbage collection
  public addRef(): void {
    this._refCount++;
  }

  // Dependency management
  public addDependency(path: string): void;
  public removeDependency(path: string): void;
}
```

### **GPUResource - Base for WebGPU Resources**

```typescript
export abstract class GPUResource extends BaseResource {
  protected device: GPUDevice; // Reference to WebGPU device
  protected label: string; // Label for debugging

  constructor(options: IGPUResourceOptions) {
    super(options);
    this.device = GPUUtils.getDevice();
    this.label = options.label || options.path;
  }
}
```

---

## 🎨 Graphics Resources

### **1. Mesh - 3D Geometry**

#### **Purpose:**

Manages 3D geometry with vertices, normals, UVs, tangents, and indices for rendering.

#### **Features:**

- **Multiple Formats**: OBJ, GLTF (through MeshData)
- **GPU Buffers**: Automatic buffers for vertices, normals, UVs, tangents, indices
- **Bounding Box**: Automatically calculated AABB for frustum culling
- **Tangent Generation**: Automatic tangent calculation for normal mapping

#### **Data Structure:**

```typescript
export class Mesh extends GPUResource {
  // CPU Data
  private vertices: Float32Array; // XYZ positions
  private normals: Float32Array; // XYZ normals
  private uvs: Float32Array; // UV coordinates
  private tangents: Float32Array; // XYZW tangents
  private indices: Uint16Array; // Triangle indices
  private aabb: AABB; // Bounding box

  // GPU Buffers
  private vertexBuffer: GPUBuffer;
  private normalBuffer: GPUBuffer;
  private uvBuffer: GPUBuffer;
  private tangentBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
}
```

#### **Usage API:**

```typescript
// Load from OBJ file
const mesh = await Mesh.get('assets/meshes/cube.obj');

// Load from GLTF data
const meshData: MeshData = {
  /* GLTF data */
};
const dynamicMesh = await Mesh.get(meshData);

// Usage in rendering
mesh.activate(renderPass); // Bind buffers
mesh.renderGroup(renderPass); // Draw call
```

#### **Format Loading:**

**OBJ Loading:**

```typescript
private loadObj(data: string): void {
    // Parse OBJ format
    // Calculate tangents automatically
    // Generate bounding box
    this.calculateTangents();
    this.calculateAABB();
}
```

**GLTF Integration:**

```typescript
public setData(meshData: MeshData): void {
    this.vertices = new Float32Array(meshData.attributes.POSITION.data);
    this.normals = new Float32Array(meshData.attributes.NORMAL.data);
    this.uvs = new Float32Array(meshData.attributes.TEXCOORD_0.data);
    this.indices = new Uint16Array(meshData.indices.data);
}
```

### **2. Texture - 2D Textures**

#### **Purpose:**

Manages 2D textures with mipmaps, filtering, and sampling for materials.

#### **Features:**

- **Multiple Formats**: PNG, JPG with automatic support
- **Mipmap Generation**: Automatic GPU-based generation
- **Quality Settings**: Automatic format based on quality configuration
- **Filtering**: Linear/Nearest with anisotropic filtering
- **Address Modes**: Repeat, clamp, mirror

#### **Configuration:**

```typescript
export class Texture extends GPUResource {
  private texture: GPUTexture;
  private textureView: GPUTextureView;
  private sampler: GPUSampler;

  // Sampling configuration
  private genMipmaps: boolean; // Auto-generate mipmaps
  private format: GPUTextureFormat; // Format (rgba8unorm, etc.)
  private magFilter: GPUFilterMode; // Magnification filter
  private minFilter: GPUFilterMode; // Minification filter
  private mipmapFilter: GPUMipmapFilterMode; // Filter between mipmaps
  private addressModeU: GPUAddressMode; // Horizontal wrapping
  private addressModeV: GPUAddressMode; // Vertical wrapping
  private maxAnisotropy: number; // Anisotropic filtering
}
```

#### **Usage API:**

```typescript
// Basic loading
const texture = await Texture.get('assets/textures/diffuse.png');

// Loading with specific options
const normalMap = await Texture.get('normal.png');

// Access to GPU resources
const gpuTexture = texture.getTexture(); // GPUTexture
const textureView = texture.getTextureView(); // GPUTextureView
const sampler = texture.getSampler(); // GPUSampler
```

#### **Mipmap Generation:**

```typescript
public async load(): Promise<void> {
    // Load image
    const bitmap = await createImageBitmap(blob);

    // Create GPU texture
    this.createGPUTexture(bitmap.width, bitmap.height);

    // Upload data
    this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: this.texture },
        [bitmap.width, bitmap.height]
    );

    // Generate mipmaps if enabled
    if (this.genMipmaps) {
        await this.generateMipmaps();
    }
}
```

### **3. Material - Surface Definition**

#### **Purpose:**

Defines visual properties of surfaces by combining techniques (shaders) and textures.

#### **Features:**

- **PBR Workflow**: Albedo, Normal, Metallic, Roughness, Emissive
- **Render Categories**: SOLIDS, TRANSPARENT, DISTORTION, DECALS
- **Shadow Support**: Shadow casting and receiving
- **Bind Groups**: Automatic texture grouping for shaders
- **Dynamic Creation**: Support for runtime-generated materials

#### **Structure:**

```typescript
export class Material extends GPUResource {
  private technique: Technique; // Shader program
  private textures: Map<string, Texture>; // Texture map
  private category: RenderCategory; // Rendering category
  private castsShadows: boolean; // If it casts shadows
  private shadows: boolean; // If it receives shadows
  private textureBindGroup: GPUBindGroup; // Bind group for GPU
  private baseColorFactor: number[]; // Base color factor
}
```

#### **PBR Texture Workflow:**

```typescript
export interface MaterialTexturesOptions {
  albedo: string; // Base color / diffuse
  normal: string; // Normal map (tangent space)
  metallic: string; // Metallic map (grayscale)
  roughness: string; // Roughness map (grayscale)
  emissive: string; // Emissive map (HDR)
}
```

#### **Usage API:**

```typescript
// Load from .mat file
const material = await Material.get('assets/materials/metal.mat');

// Load from dynamic data
const matData: MaterialDataType = {
  technique: 'basic.tech',
  textures: {
    txAlbedo: 'diffuse.png',
    txNormal: 'normal.png',
    txMetallic: 'metallic.png',
    txRoughness: 'roughness.png',
    txEmissive: 'emissive.png',
  },
  category: RenderCategory.SOLIDS,
};
const dynamicMaterial = await Material.get(matData);

// Usage in rendering
material.setBindGroup(renderPass, 2); // Bind group 2 for textures
```

#### **.mat File (JSON) — full field reference:**

| Field | Type | Default | Description |
|---|---|---|---|
| `technique` | string | — | Path to `.tech` file |
| `textures` | object | `{}` | Map of texture slot name → image path |
| `category` | string | `"SOLIDS"` | Render category: `SOLIDS`, `TRANSPARENT`, `GLASS`, `DISTORTION`, `DECALS` |
| `castsShadows` | boolean | `true` | Whether the material casts a shadow |
| `baseColorFactor` | number[4] | `[1,1,1,1]` | RGBA multiplier applied to the albedo texture |

**Example — standard PBR solid:**
```json
{
  "technique": "pbr/pbr.tech",
  "textures": {
    "txAlbedo": "metal_albedo.png",
    "txNormal": "metal_normal.png",
    "txMetallic": "metal_metallic.png",
    "txRoughness": "metal_roughness.png",
    "txEmissive": "black.png"
  },
  "category": "SOLIDS",
  "castsShadows": true,
  "baseColorFactor": [1.0, 1.0, 1.0, 1.0]
}
```

**Example — water (TRANSPARENT category):**
```json
{
  "technique": "water/water.tech",
  "textures": {
    "txNoise": "textures/noiseRGBTileable.ktx2"
  },
  "category": "TRANSPARENT",
  "castsShadows": false,
  "baseColorFactor": [0.05, 0.3, 0.7, 0.45]
}
```

### **4. Technique - Rendering Pipeline**

#### **Purpose:**

Defines the complete rendering pipeline: shaders, blend modes, depth testing, etc.

#### **Features:**

- **Shader Management**: Vertex + Fragment shaders with preprocessing
- **Pipeline State**: Blend, depth, rasterization modes
- **Bind Group Layouts**: Resource definition for shaders
- **Multi-Target**: Support for multiple render targets
- **Quality Adaptation**: Configuration based on quality settings

#### **Configuration:**

```typescript
export class Technique extends GPUResource {
  // Pipeline resources
  private pipeline: GPURenderPipeline;
  private pipelineLayouts: GPUBindGroupLayout[];

  // Shader modules
  private vsModule: GPUShaderModule; // Vertex shader
  private fsModule: GPUShaderModule; // Fragment shader

  // Pipeline state
  private blendMode: BlendModes; // OPAQUE, ALPHA, ADDITIVE
  private rasterizationMode: RasterizationMode; // FILL, WIREFRAME
  private depthTest: DepthModes; // LESS, LESS_EQUAL, ALWAYS
  private writesOn: FragmentShaderTargets; // SCREEN, GBUFFER, DEPTH_ONLY
  private uniformsLayout: PipelineBindGroupLayouts[]; // Bind group layouts
}
```

#### **.tech File (JSON) — full field reference:**

| Field | Type | Description |
|---|---|---|
| `vs` | string | Vertex shader path relative to `assets/shaders/` |
| `fs` | string | Fragment shader path relative to `assets/shaders/` |
| `writesOn` | string | Output targets: `GBUFFER`, `SCREEN`, `DEPTH_ONLY`, `OIT_GBUFFER` |
| `z` | string | Depth mode: `LESS`, `LESS_EQUAL`, `ALWAYS`, `NONE`, `test_but_no_write` |
| `blend` | string | Blend mode: `OPAQUE`, `ALPHA`, `ADDITIVE`, `OIT`, `COMBINATIVE` |
| `rs` | string | Rasterizer: `FILL`, `WIREFRAME`; add `double_sided: true` for no back-face cull |
| `uniforms` | string[] | Bind group layout names (e.g. `CAMERA_UNIFORMS`, `MATERIAL_TEXTURES`, `WATER_SCENE`) |
| `double_sided` | boolean? | If true, disables back-face culling |

**Example — standard PBR opaque:**
```json
{
  "vs": "pbr.vs",
  "fs": "pbr.fs",
  "blend": "OPAQUE",
  "z": "LESS_EQUAL",
  "rs": "FILL",
  "writesOn": "GBUFFER",
  "uniforms": ["CAMERA_UNIFORMS", "OBJECT_UNIFORMS", "MATERIAL_TEXTURES"]
}
```

**Example — water (transparent, double-sided, depth test but no write):**
```json
{
  "vs": "water/water.vs",
  "fs": "water/water.fs",
  "blend": "COMBINATIVE",
  "z": "test_but_no_write",
  "rs": "FILL",
  "double_sided": true,
  "writesOn": "SCREEN",
  "uniforms": ["CAMERA_UNIFORMS", "OBJECT_UNIFORMS", "MATERIAL_TEXTURES", "WATER_SCENE"]
}
```

#### **Usage:**

```typescript
// Async load (preferred — returns cached instance on repeat calls)
const tech = await Technique.getAsync('pbr/pbr.tech');

// Sync get from cache (throws if not yet loaded)
const tech = Technique.get('pbr/pbr.tech');
```

#### **Shader Preprocessing:**

```typescript
public async loadShaders(): Promise<void> {
    // Load with automatic preprocessing (includes, defines)
    const vsSource = await ResourceManager.loadShader(`assets/shaders/${this.vsFile}`);
    const fsSource = await ResourceManager.loadShader(`assets/shaders/${this.fsFile}`);

    this.vsModule = this.device.createShaderModule({
        label: `${this.label}_vs`,
        code: vsSource
    });

    this.fsModule = this.device.createShaderModule({
        label: `${this.label}_fs`,
        code: fsSource
    });
}
```

#### **Pipeline Creation:**

```typescript
public createPipeline(vertexLayout: GPUVertexBufferLayout[]): void {
    const pipelineConfig: PipelineConfig = {
        label: this.label,
        vertex: this.vsModule,
        fragment: this.fsModule,
        vertexLayouts: vertexLayout,
        blendMode: this.blendMode,
        depthMode: this.depthTest,
        rasterizerMode: this.rasterizationMode,
        targets: this.getTargetFormats(),
        bindGroupLayouts: this.pipelineLayouts
    };

    this.pipeline = PipelineFactory.createRenderPipeline(pipelineConfig);
}
```

### **5. Cubemap - Environmental Textures**

#### **Purpose:**

Manages cubic textures for skyboxes, reflections, and Image-Based Lighting (IBL).

#### **Features:**

- **6 Faces**: +X, -X, +Y, -Y, +Z, -Z
- **Cross Layout**: Support for standard 4x3 format
- **HDR Support**: High dynamic range formats
- **Mipmap Generation**: For reflection filtering
- **Seamless Sampling**: Filtering between faces

#### **Structure:**

```typescript
export class Cubemap extends GPUResource {
  private gpuTexture: GPUTexture; // GPU texture (dimension: '2d-array')
  private gpuTextureView: GPUTextureView; // Cubemap view
  private gpuSampler: GPUSampler; // Sampler with clamp-to-edge

  // Sampling configuration (typically clamp-to-edge)
  private addressModeU: GPUAddressMode = 'clamp-to-edge';
  private addressModeV: GPUAddressMode = 'clamp-to-edge';
  private addressModeW: GPUAddressMode = 'clamp-to-edge';
}
```

#### **Cross Layout Loading:**

```typescript
public async load(): Promise<void> {
    const image = await createImageBitmap(await fetch(`/assets/textures/${this.path}`).then(r => r.blob()));

    const faceSize = image.width / 4; // 4x3 format
    const faceCoords: Record<number, [number, number]> = {
        0: [2, 1], // +X (right)
        1: [0, 1], // -X (left)
        2: [1, 0], // +Y (top)
        3: [1, 2], // -Y (bottom)
        4: [1, 1], // +Z (front)
        5: [3, 1], // -Z (back)
    };

    // Extract each face and upload as layer of texture array
    for (let face = 0; face < 6; face++) {
        const [x, y] = faceCoords[face];
        // ... extract region and upload ...
    }
}
```

### **6. RenderTarget - Rendering Buffers**

#### **Purpose:**

Manages rendering textures with MSAA support for G-Buffer, post-processing, etc.

#### **Features:**

- **MSAA Support**: Dual-texture approach (MSAA + resolve target)
- **Quality Integration**: MSAA level based on quality settings
- **Multiple Usage**: RENDER_ATTACHMENT + TEXTURE_BINDING + STORAGE_BINDING
- **Auto Resolution**: Automatic MSAA resolving
- **Flexible Formats**: Support for any texture format

#### **MSAA Architecture:**

```typescript
export class RenderTarget {
  private texture: GPUTexture; // Single-sample (for sampling)
  private textureView: GPUTextureView; // View for shaders

  // MSAA support
  private msaaTexture: GPUTexture; // Multi-sample (for rendering)
  private msaaTextureView: GPUTextureView; // View for render pass
  private isMultisample: boolean;
}
```

#### **Main API:**

```typescript
// Create render target
renderTarget.createRT(
  'albedo', // name
  1920,
  1080, // resolution
  'rgba8unorm', // format
  true, // MSAA enabled
  GPUTextureUsage.STORAGE_BINDING, // additional usage
);

// Usage in render passes
const renderView = renderTarget.getRenderView(); // For rendering (MSAA)
const samplerView = renderTarget.getView(); // For sampling (single-sample)
const storageView = renderTarget.getStorageView(); // For compute shaders
```

---

## 🔄 Loading and Management Flows

### **Unified Loading Pattern**

All resources follow the same loading pattern:

```typescript
public static async get(pathOrData: string | DataType): Promise<ResourceType> {
    // 1. Check existing cache
    try {
        return ResourceManager.getResource<ResourceType>(path);
    } catch {
        // 2. Create new resource
        const resource = new ResourceType(options);

        // 3. Register in cache BEFORE loading (avoids race conditions)
        ResourceManager.registerResource(resource);

        // 4. Load data
        await resource.load();

        return resource;
    }
}
```

### **Reference Counting**

```typescript
// Automatic when obtaining a resource
const mesh = await Mesh.get('cube.obj'); // refCount++

// Automatic when releasing
mesh.release(); // refCount--

// Automatic cleanup when refCount === 0
ResourceManager.unregisterResource(path);
```

### **Dependency Tracking**

```typescript
// Material has dependencies on Technique and Textures
material.addDependency('pbr.tech');
material.addDependency('diffuse.png');
material.addDependency('normal.png');

// When releasing material, dependencies are automatically released
material.release();
```

---

## 🎯 Quality Settings Integration

### **Adaptive Formats**

```typescript
// Textures use formats based on quality
const qualitySettings = QualitySettings.getInstance();
const formats = qualitySettings.getPostProcessingFormats();

// RenderTargets adapt MSAA level
const msaaLevel = qualitySettings.getMSAALevel();

// Techniques adapt pipeline based on targets
const targets = this.getTargetFormats(); // Based on quality
```

### **Configuration by Preset**

- **LOW**: Basic formats, MSAA 2x
- **MEDIUM**: Intermediate formats, MSAA 4x
- **HIGH**: Quality formats, MSAA 4x
- **ULTRA**: Premium formats, MSAA 8x

---

## 🚀 Optimizations and Best Practices

### **Memory Management**

- **Reference Counting**: Automatic memory release
- **Resource Sharing**: One mesh used by multiple entities
- **Dependency Tracking**: Cascade release
- **Cache Invalidation**: Cleanup when refCount reaches 0

### **GPU Resource Optimization**

- **Buffer Reuse**: Buffers are reused between frames
- **Bind Group Caching**: Bind groups are automatically cached
- **MSAA Resolution**: Only when necessary
- **Mipmap Generation**: GPU-based for better performance

### **Loading Performance**

- **Async Loading**: All loads are asynchronous
- **Preprocessing**: Shaders are processed once
- **Format Detection**: Automatic format detection
- **Error Handling**: Automatic fallbacks for missing resources

### **Debug Support**

- **Resource Labeling**: All GPU resources have labels
- **Dependency Visualization**: Dependency tracking
- **Memory Tracking**: Reference counters
- **Quality Reporting**: Information on formats and settings used

This resource system provides a solid foundation for the WebGPU Engine, ensuring efficiency, flexibility, and ease of use in all aspects of graphics asset management.
