import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { MeshData } from '../../types/MeshData.type';
import { Engine } from '../../core/engine/Engine';
import { GPUUtils } from '../core/utils/GPUUtils';
import { AABB } from '../../types/AABB';
import { generateTangents } from 'mikktspace';

export interface MeshOptions extends IGPUResourceOptions {
  meshData?: MeshData;
}

export class Mesh extends GPUResource {
  private vertices!: Float32Array; // Posiciones de los vértices
  private normals!: Float32Array; // Normales de los vértices
  private uvs!: Float32Array; // Coordenadas de textura
  private indices!: Uint16Array; // Índices para formar triángulos
  private tangents!: Float32Array; // Vectores tangentes para normal mapping
  private indexCount!: number; // Número total de índices
  private aabb!: AABB; // Axis-Aligned Bounding Box for culling

  // Buffers en GPU
  // Layout por vértice (interleaved, 48 bytes = 12 floats):
  //   offset  0 : position  (float32x3, 12 bytes)
  //   offset 12 : normal    (float32x3, 12 bytes)
  //   offset 24 : uv        (float32x2,  8 bytes)
  //   offset 32 : tangent   (float32x4, 16 bytes)
  private interleavedBuffer!: GPUBuffer; // Buffer entrelazado único
  private indexBuffer!: GPUBuffer; // Buffer de índices

  private static readonly VERTEX_STRIDE = 12; // floats por vértice
  private static readonly VERTEX_STRIDE_BYTES = 12 * 4; // 48 bytes

  constructor(options: MeshOptions) {
    super({
      ...options,
      type: ResourceType.MESH,
    });

    if (options.meshData) {
      this.setData(options.meshData);
    }
  }

  static get(meshPath: string | MeshData): Mesh {
    let mesh = null;

    if (typeof meshPath === 'string') {
      try {
        return ResourceManager.getResource<Mesh>(meshPath);
      } catch {
        mesh = new Mesh({
          path: meshPath,
          type: ResourceType.MESH,
        });
      }
    } else {
      const dynamicId = Engine.generateDynamicId();
      mesh = new Mesh({
        path: `dynamic_mesh_${dynamicId}`,
        type: ResourceType.MESH,
        meshData: meshPath,
      });
    }

    // Register first to prevent race conditions
    ResourceManager.registerResource(mesh);

    // Start loading without await (non-blocking)
    mesh.load();

    return mesh;
  }

  static async getAsync(meshPath: string | MeshData): Promise<Mesh> {
    let mesh = null;

    if (typeof meshPath === 'string') {
      try {
        return ResourceManager.getResource<Mesh>(meshPath);
      } catch {
        mesh = new Mesh({
          path: meshPath,
          type: ResourceType.MESH,
        });
      }
    } else {
      const dynamicId = Engine.generateDynamicId();
      mesh = new Mesh({
        path: `dynamic_mesh_${dynamicId}`,
        type: ResourceType.MESH,
        meshData: meshPath,
      });
    }

    // Register first to prevent race conditions
    ResourceManager.registerResource(mesh);

    await mesh.loadAsync();
    return mesh;
  }

  public async loadAsync(): Promise<void> {
    try {
      if (!this.hasData) {
        const data = await ResourceManager.loadMeshData(this.path);
        this.loadObj(data);
      }
      this.initBuffers();
      this.setHasData();
    } catch (error) {
      throw new Error(`Failed to load mesh ${this.path}: ${error}`);
    }
  }

  public override load(): void {
    // Síncrono: inicia la carga sin await
    if (!this.hasData) {
      ResourceManager.loadMeshData(this.path)
        .then((data) => {
          this.loadObj(data);
          this.initBuffers();
          this.setHasData();
        })
        .catch((error) => {
          console.error(`Error loading mesh ${this.path}:`, error);
        });
    } else {
      this.initBuffers();
      this.setHasData();
    }
  }

  public setData(meshData: MeshData): void {
    if (Array.isArray(meshData.attributes.POSITION)) {
      this.vertices = new Float32Array(meshData.attributes.POSITION);
    } else {
      this.vertices = meshData.attributes.POSITION;
    }

    if (Array.isArray(meshData.attributes.NORMAL)) {
      this.normals = new Float32Array(meshData.attributes.NORMAL);
    } else {
      this.normals = meshData.attributes.NORMAL;
    }

    if (Array.isArray(meshData.attributes.TEXCOORD_0)) {
      this.uvs = new Float32Array(meshData.attributes.TEXCOORD_0);
    } else {
      this.uvs = meshData.attributes.TEXCOORD_0;
    }

    if (Array.isArray(meshData.indices)) {
      this.indices = new Uint16Array(meshData.indices);
    } else {
      this.indices = meshData.indices as Uint16Array;
    }

    if (Array.isArray(meshData.attributes.TANGENT)) {
      this.tangents = new Float32Array(meshData.attributes.TANGENT);
    } else {
      this.tangents = meshData.attributes.TANGENT;
      if (!this.tangents) {
        this.tangents = this.computeMeshTangents();
      }
    }

    this.indexCount = meshData.indices.length;
    this.aabb = this.calculateAABB();

    this.setHasData();
  }

  public loadObj(data: string): void {
    // Arrays temporales para acumular datos
    const verticesArray: number[] = [];
    const normalsArray: number[] = [];
    const uvsArray: number[] = [];
    const indicesArray: number[] = [];

    // Arrays temporales para datos del archivo OBJ
    const tempVertices: number[] = []; // Posiciones del archivo
    const tempNormals: number[] = []; // Normales del archivo
    const tempUVs: number[] = []; // UVs del archivo
    const tempIndices: { [key: string]: number } = {}; // Mapa de índices únicos
    let indexCount = 0;

    // Procesar el archivo OBJ línea por línea
    const lines = data.split('\n');
    for (let line of lines) {
      line = line.trim();

      if (line.startsWith('#') || line === '') {
        continue;
      }

      const parts = line.split(/\s+/);
      const keyword = parts[0];

      switch (keyword) {
        case 'v': // Vértice
          if (parts[1] && parts[2] && parts[3]) {
            tempVertices.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
          }
          break;

        case 'vn': // Normal
          if (parts[1] && parts[2] && parts[3]) {
            tempNormals.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
          }
          break;

        case 'vt': // Coordenada de textura
          if (parts[1] && parts[2]) {
            tempUVs.push(parseFloat(parts[1]), parseFloat(parts[2]));
          }
          break;

        case 'f': // Cara (triángulo)
          const faceVertices = [];
          const faceUVs = [];
          const faceIndices = [];

          // Procesar cada vértice de la cara
          for (let i = 1; i < parts.length; i++) {
            const vertex = parts[i];
            if (!vertex) continue;

            if (!(vertex in tempIndices)) {
              // Formato del OBJ: v/vt/vn
              const indices = vertex.split('/').map((index) => parseInt(index) - 1);
              const v = indices[0]; // índice de vértice
              const vt = indices[1]; // índice de UV
              const vn = indices[2]; // índice de normal

              // Verificar que v esté definido y sea válido
              if (v !== undefined && !isNaN(v) && v >= 0) {
                // Añadir atributos a los arrays finales
                const x = tempVertices[v * 3];
                const y = tempVertices[v * 3 + 1];
                const z = tempVertices[v * 3 + 2];

                if (x !== undefined && y !== undefined && z !== undefined) {
                  verticesArray.push(x, y, z);
                }

                if (vt !== undefined && !isNaN(vt) && vt >= 0) {
                  const u = tempUVs[vt * 2];
                  const v_uv = tempUVs[vt * 2 + 1];
                  if (u !== undefined && v_uv !== undefined) {
                    uvsArray.push(u, v_uv);
                  }
                }

                if (vn !== undefined && !isNaN(vn) && vn >= 0) {
                  const nx = tempNormals[vn * 3];
                  const ny = tempNormals[vn * 3 + 1];
                  const nz = tempNormals[vn * 3 + 2];
                  if (nx !== undefined && ny !== undefined && nz !== undefined) {
                    normalsArray.push(nx, ny, nz);
                  }
                }

                tempIndices[vertex] = indexCount++;
              }
            }

            const idx = tempIndices[vertex];
            if (idx !== undefined) {
              indicesArray.push(idx);
              faceVertices.push(idx);

              // Extraer índices de UV nuevamente para el cálculo de tangentes
              const indices = vertex.split('/').map((index) => parseInt(index) - 1);
              const vt = indices[1]; // índice de UV
              if (vertex.includes('/') && vt !== undefined && !isNaN(vt) && vt >= 0) {
                const u = tempUVs[vt * 2];
                const v_uv = tempUVs[vt * 2 + 1];
                if (u !== undefined && v_uv !== undefined) {
                  faceUVs.push([u, v_uv]);
                }
              }

              faceIndices.push(idx);
            }
          }
          break;
      }
    } // Crear los TypedArrays finales con los datos procesados
    this.vertices = new Float32Array(verticesArray);
    this.normals = new Float32Array(normalsArray);
    this.uvs = new Float32Array(uvsArray);
    this.indices = new Uint16Array(indicesArray);
    this.tangents = this.computeMeshTangents();
    this.indexCount = this.indices.length;
    this.aabb = this.calculateAABB();

    // Mark as loaded when loadObj completes
    this.setHasData();
  }

  /**
   * Generates tangents using MikkTSpace algorithm
   * MikkTSpace ensures consistent tangent space generation across different tools/engines
   *
   * IMPORTANT: MikkTSpace requires UNINDEXED geometry (duplicated vertices per triangle)
   * This method temporarily converts indexed geometry to unindexed for tangent generation
   */
  private computeMeshTangents(): Float32Array {
    const numVertices = this.vertices.length / 3;

    try {
      // MikkTSpace requires unindexed geometry - expand indexed data
      const numTriangles = this.indices.length / 3;
      const unindexedPositions = new Float32Array(numTriangles * 9); // 3 verts * 3 components
      const unindexedNormals = new Float32Array(numTriangles * 9);
      const unindexedUVs = new Float32Array(numTriangles * 6); // 3 verts * 2 components

      // Expand indexed geometry to unindexed for MikkTSpace
      for (let i = 0; i < this.indices.length; i++) {
        const idx = this.indices[i];
        if (idx === undefined) continue;

        const vertIdx = Math.floor(i / 3) * 9 + (i % 3) * 3;
        const uvIdx = Math.floor(i / 3) * 6 + (i % 3) * 2;

        // Copy position
        unindexedPositions[vertIdx] = this.vertices[idx * 3] ?? 0;
        unindexedPositions[vertIdx + 1] = this.vertices[idx * 3 + 1] ?? 0;
        unindexedPositions[vertIdx + 2] = this.vertices[idx * 3 + 2] ?? 0;

        // Copy normal
        unindexedNormals[vertIdx] = this.normals[idx * 3] ?? 0;
        unindexedNormals[vertIdx + 1] = this.normals[idx * 3 + 1] ?? 0;
        unindexedNormals[vertIdx + 2] = this.normals[idx * 3 + 2] ?? 0;

        // Copy UV
        unindexedUVs[uvIdx] = this.uvs[idx * 2] ?? 0;
        unindexedUVs[uvIdx + 1] = this.uvs[idx * 2 + 1] ?? 0;
      }

      // Generate tangents using MikkTSpace algorithm
      const unindexedTangents = generateTangents(
        unindexedPositions,
        unindexedNormals,
        unindexedUVs,
      );

      if (!unindexedTangents || unindexedTangents.length !== numTriangles * 12) {
        console.warn(`MikkTSpace generation failed, falling back to simple tangent generation`);
        return this.computeSimpleTangents();
      }

      // Convert back to indexed format by averaging tangents for shared vertices
      const tangents = new Float32Array(numVertices * 4);
      const tangentCounts = new Int32Array(numVertices);

      for (let i = 0; i < this.indices.length; i++) {
        const idx = this.indices[i];
        if (idx === undefined) continue;

        const unindexedIdx = i * 4;
        const tangentIdx = idx * 4;

        // Accumulate tangents for this vertex
        tangents[tangentIdx] = (tangents[tangentIdx] ?? 0) + (unindexedTangents[unindexedIdx] ?? 0);
        tangents[tangentIdx + 1] =
          (tangents[tangentIdx + 1] ?? 0) + (unindexedTangents[unindexedIdx + 1] ?? 0);
        tangents[tangentIdx + 2] =
          (tangents[tangentIdx + 2] ?? 0) + (unindexedTangents[unindexedIdx + 2] ?? 0);
        tangents[tangentIdx + 3] = unindexedTangents[unindexedIdx + 3] ?? 1; // w component (handedness)
        tangentCounts[idx] = (tangentCounts[idx] ?? 0) + 1;
      }

      // Average accumulated tangents and normalize
      for (let i = 0; i < numVertices; i++) {
        const count = tangentCounts[i] ?? 0;
        if (count > 0) {
          const idx = i * 4;
          const tx = (tangents[idx] ?? 0) / count;
          const ty = (tangents[idx + 1] ?? 0) / count;
          const tz = (tangents[idx + 2] ?? 0) / count;

          // Normalize XYZ components
          const len = Math.sqrt(tx * tx + ty * ty + tz * tz);

          if (len > 0) {
            tangents[idx] = tx / len;
            tangents[idx + 1] = ty / len;
            tangents[idx + 2] = tz / len;
          }
        }
      }

      return tangents;
    } catch (error) {
      console.error('Error generating MikkTSpace tangents:', error);
      return this.computeSimpleTangents();
    }
  }

  /**
   * Fallback simple tangent generation (not MikkTSpace)
   * Used only if MikkTSpace generation fails
   */
  private computeSimpleTangents(): Float32Array {
    const tangents = new Float32Array((this.vertices.length * 4) / 3);

    // Process each triangle
    for (let i = 0; i < this.indices.length - 2; i += 3) {
      const i0 = this.indices[i];
      const i1 = this.indices[i + 1];
      const i2 = this.indices[i + 2];

      if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

      // Get vertices
      const p0x = this.vertices[i0 * 3] ?? 0;
      const p0y = this.vertices[i0 * 3 + 1] ?? 0;
      const p0z = this.vertices[i0 * 3 + 2] ?? 0;

      const p1x = this.vertices[i1 * 3] ?? 0;
      const p1y = this.vertices[i1 * 3 + 1] ?? 0;
      const p1z = this.vertices[i1 * 3 + 2] ?? 0;

      const p2x = this.vertices[i2 * 3] ?? 0;
      const p2y = this.vertices[i2 * 3 + 1] ?? 0;
      const p2z = this.vertices[i2 * 3 + 2] ?? 0;

      // Get UVs
      const uv0x = this.uvs[i0 * 2] ?? 0;
      const uv0y = this.uvs[i0 * 2 + 1] ?? 0;

      const uv1x = this.uvs[i1 * 2] ?? 0;
      const uv1y = this.uvs[i1 * 2 + 1] ?? 0;

      const uv2x = this.uvs[i2 * 2] ?? 0;
      const uv2y = this.uvs[i2 * 2 + 1] ?? 0;

      // Calculate edges
      const edge1x = p1x - p0x;
      const edge1y = p1y - p0y;
      const edge1z = p1z - p0z;

      const edge2x = p2x - p0x;
      const edge2y = p2y - p0y;
      const edge2z = p2z - p0z;

      const deltaUV1x = uv1x - uv0x;
      const deltaUV1y = uv1y - uv0y;

      const deltaUV2x = uv2x - uv0x;
      const deltaUV2y = uv2y - uv0y;

      const denominator = deltaUV1x * deltaUV2y - deltaUV2x * deltaUV1y;
      const f = denominator !== 0 ? 1.0 / denominator : 1.0;

      const tangentX = f * (deltaUV2y * edge1x - deltaUV1y * edge2x);
      const tangentY = f * (deltaUV2y * edge1y - deltaUV1y * edge2y);
      const tangentZ = f * (deltaUV2y * edge1z - deltaUV1y * edge2z);

      const w = denominator >= 0 ? 1 : -1;

      // Accumulate tangents for each vertex of triangle
      for (const idx of [i0, i1, i2]) {
        const baseIdx = idx * 4;
        tangents[baseIdx] = (tangents[baseIdx] ?? 0) + tangentX;
        tangents[baseIdx + 1] = (tangents[baseIdx + 1] ?? 0) + tangentY;
        tangents[baseIdx + 2] = (tangents[baseIdx + 2] ?? 0) + tangentZ;
        tangents[baseIdx + 3] = w;
      }
    }

    // Normalize
    for (let i = 0; i < tangents.length - 3; i += 4) {
      const x = tangents[i] ?? 0;
      const y = tangents[i + 1] ?? 0;
      const z = tangents[i + 2] ?? 0;
      const len = Math.sqrt(x * x + y * y + z * z);

      if (len > 0) {
        tangents[i] = x / len;
        tangents[i + 1] = y / len;
        tangents[i + 2] = z / len;
      }
    }

    return tangents;
  }
  private initBuffers(): void {
    const vertexCount = this.vertices.length / 3;
    const stride = Mesh.VERTEX_STRIDE; // 12 floats per vertex

    // Pack all attributes into a single interleaved Float32Array
    // Layout per vertex: [px py pz | nx ny nz | u v | tx ty tz tw]
    const interleaved = new Float32Array(vertexCount * stride);

    for (let i = 0; i < vertexCount; i++) {
      const base = i * stride;
      // position (3 floats, offset 0)
      interleaved[base] = this.vertices[i * 3] ?? 0;
      interleaved[base + 1] = this.vertices[i * 3 + 1] ?? 0;
      interleaved[base + 2] = this.vertices[i * 3 + 2] ?? 0;
      // normal (3 floats, offset 3)
      interleaved[base + 3] = this.normals[i * 3] ?? 0;
      interleaved[base + 4] = this.normals[i * 3 + 1] ?? 0;
      interleaved[base + 5] = this.normals[i * 3 + 2] ?? 0;
      // uv (2 floats, offset 6)
      interleaved[base + 6] = this.uvs[i * 2] ?? 0;
      interleaved[base + 7] = this.uvs[i * 2 + 1] ?? 0;
      // tangent (4 floats, offset 8)
      interleaved[base + 8] = this.tangents[i * 4] ?? 0;
      interleaved[base + 9] = this.tangents[i * 4 + 1] ?? 0;
      interleaved[base + 10] = this.tangents[i * 4 + 2] ?? 0;
      interleaved[base + 11] = this.tangents[i * 4 + 3] ?? 1;
    }

    this.interleavedBuffer = GPUUtils.createBuffer(
      `${this.label}_interleavedBuffer`,
      interleaved.byteLength,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      interleaved,
    );

    // Crear buffer de índices en GPU
    const paddedIndexCount = Math.ceil((this.indices.length * 2) / 4) * 2;
    const paddedArray = new Uint16Array(paddedIndexCount);
    paddedArray.set(this.indices);

    this.indexBuffer = GPUUtils.createBuffer(
      `${this.label}_indexBuffer`,
      paddedArray.byteLength,
      GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    );

    GPUUtils.writeBuffer(this.indexBuffer, 0, paddedArray);
  }

  private calculateAABB(): AABB {
    if (!this.vertices || this.vertices.length === 0) {
      return { min: [0, 0, 0], max: [0, 0, 0] };
    }

    // Initialize with first vertex
    let minX = this.vertices[0] || 0;
    let minY = this.vertices[1] || 0;
    let minZ = this.vertices[2] || 0;
    let maxX = this.vertices[0] || 0;
    let maxY = this.vertices[1] || 0;
    let maxZ = this.vertices[2] || 0;

    // Iterate through all vertices (3 components per vertex)
    for (let i = 3; i < this.vertices.length; i += 3) {
      const x = this.vertices[i] || 0;
      const y = this.vertices[i + 1] || 0;
      const z = this.vertices[i + 2] || 0;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }

    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    };
  }

  public getAABB(): AABB {
    return this.aabb;
  }

  public isGPUReady(): boolean {
    return this.hasData && this.interleavedBuffer !== undefined && this.indexBuffer !== undefined;
  }

  public static getVertexBufferLayout(): GPUVertexBufferLayout[] {
    // Single interleaved buffer, stride = 48 bytes (12 floats)
    // offset  0 : position  (float32x3, 12 bytes)
    // offset 12 : normal    (float32x3, 12 bytes)
    // offset 24 : uv        (float32x2,  8 bytes)
    // offset 32 : tangent   (float32x4, 16 bytes)
    return [
      {
        arrayStride: Mesh.VERTEX_STRIDE_BYTES, // 48 bytes
        stepMode: 'vertex',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
          { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
          { shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv
          { shaderLocation: 3, offset: 32, format: 'float32x4' }, // tangent
        ],
      },
    ];
  }

  public activate(pass: GPURenderPassEncoder): void {
    if (!this.isGPUReady()) {
      console.warn(`Mesh ${this.path} is not ready for rendering. Buffers not initialized.`);
      return;
    }

    pass.setVertexBuffer(0, this.interleavedBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
  }

  public renderGroup(pass: GPURenderPassEncoder): void {
    if (!this.isGPUReady()) {
      return;
    }
    pass.drawIndexed(this.indexCount);
  }

  public renderInstance(pass: GPURenderPassEncoder, particleCount: number): void {
    if (!this.isGPUReady()) {
      return;
    }
    pass.drawIndexed(this.indexCount, particleCount);
  }

  public override getName(): string {
    return this.path;
  }

  public getVertexCount(): number {
    return this.vertices ? this.vertices.length / 3 : 0;
  }

  public getIndices(): Uint16Array {
    return this.indices;
  }

  public getIndexCount(): number {
    return this.indexCount;
  }
}
