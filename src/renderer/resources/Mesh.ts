import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { MeshData } from '../../types/MeshData.type';
import { Engine } from '../../core/engine/Engine';
import { GPUUtils } from '../core/utils/GPUUtils';
import { AABB } from '../../types/AABB';

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
  private vertexBuffer!: GPUBuffer; // Buffer de vértices
  private normalBuffer!: GPUBuffer; // Buffer de normales
  private uvBuffer!: GPUBuffer; // Buffer de UVs
  private tangentBuffer!: GPUBuffer; // Buffer de tangentes
  private indexBuffer!: GPUBuffer; // Buffer de índices

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
    this.tangents = this.computeMeshTangents();
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

  private computeTangent(
    p0: number[],
    p1: number[],
    p2: number[],
    uv0: number[],
    uv1: number[],
    uv2: number[],
  ): { tangent: number[]; w: number } {
    // Verificar que todos los arrays tengan las dimensiones correctas
    if (
      p0.length < 3 ||
      p1.length < 3 ||
      p2.length < 3 ||
      uv0.length < 2 ||
      uv1.length < 2 ||
      uv2.length < 2
    ) {
      return { tangent: [1, 0, 0], w: 1 }; // Valor por defecto
    }

    const edge1 = [
      (p1[0] ?? 0) - (p0[0] ?? 0),
      (p1[1] ?? 0) - (p0[1] ?? 0),
      (p1[2] ?? 0) - (p0[2] ?? 0),
    ];
    const edge2 = [
      (p2[0] ?? 0) - (p0[0] ?? 0),
      (p2[1] ?? 0) - (p0[1] ?? 0),
      (p2[2] ?? 0) - (p0[2] ?? 0),
    ];

    const deltaUV1 = [(uv1[0] ?? 0) - (uv0[0] ?? 0), (uv1[1] ?? 0) - (uv0[1] ?? 0)];
    const deltaUV2 = [(uv2[0] ?? 0) - (uv0[0] ?? 0), (uv2[1] ?? 0) - (uv0[1] ?? 0)];

    const denominator =
      (deltaUV1[0] ?? 0) * (deltaUV2[1] ?? 0) - (deltaUV2[0] ?? 0) * (deltaUV1[1] ?? 0);
    const f = denominator !== 0 ? 1.0 / denominator : 1.0;

    const tangent = [
      f * ((deltaUV2[1] ?? 0) * (edge1[0] ?? 0) - (deltaUV1[1] ?? 0) * (edge2[0] ?? 0)),
      f * ((deltaUV2[1] ?? 0) * (edge1[1] ?? 0) - (deltaUV1[1] ?? 0) * (edge2[1] ?? 0)),
      f * ((deltaUV2[1] ?? 0) * (edge1[2] ?? 0) - (deltaUV1[1] ?? 0) * (edge2[2] ?? 0)),
    ];

    const uDirection =
      (deltaUV1[0] ?? 0) * (deltaUV2[1] ?? 0) - (deltaUV2[0] ?? 0) * (deltaUV1[1] ?? 0);
    const w = uDirection >= 0 ? 1 : -1; // 1 o -1 dependiendo de la dirección

    return { tangent, w };
  }

  private computeMeshTangents(): Float32Array {
    // Create tangent array initialized to zero
    const tangents = new Float32Array((this.vertices.length * 4) / 3); // 4 components (xyz + w) per vertex

    // Process each triangle
    for (let i = 0; i < this.indices.length - 2; i += 3) {
      const i0 = this.indices[i];
      const i1 = this.indices[i + 1];
      const i2 = this.indices[i + 2];

      if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

      // Get vertices of the triangle
      const p0 = [
        this.vertices[i0 * 3] ?? 0,
        this.vertices[i0 * 3 + 1] ?? 0,
        this.vertices[i0 * 3 + 2] ?? 0,
      ];
      const p1 = [
        this.vertices[i1 * 3] ?? 0,
        this.vertices[i1 * 3 + 1] ?? 0,
        this.vertices[i1 * 3 + 2] ?? 0,
      ];
      const p2 = [
        this.vertices[i2 * 3] ?? 0,
        this.vertices[i2 * 3 + 1] ?? 0,
        this.vertices[i2 * 3 + 2] ?? 0,
      ];

      // Get UVs of the triangle
      const uv0 = [this.uvs[i0 * 2] ?? 0, this.uvs[i0 * 2 + 1] ?? 0];
      const uv1 = [this.uvs[i1 * 2] ?? 0, this.uvs[i1 * 2 + 1] ?? 0];
      const uv2 = [this.uvs[i2 * 2] ?? 0, this.uvs[i2 * 2 + 1] ?? 0];

      // Compute tangent for this triangle
      const tangentData = this.computeTangent(p0, p1, p2, uv0, uv1, uv2);

      // Add computed tangent to each vertex of the triangle
      for (const idx of [i0, i1, i2]) {
        const baseIdx = idx * 4;
        const currentTangentX = tangents[baseIdx] ?? 0;
        const currentTangentY = tangents[baseIdx + 1] ?? 0;
        const currentTangentZ = tangents[baseIdx + 2] ?? 0;

        tangents[baseIdx] = currentTangentX + (tangentData.tangent[0] ?? 0);
        tangents[baseIdx + 1] = currentTangentY + (tangentData.tangent[1] ?? 0);
        tangents[baseIdx + 2] = currentTangentZ + (tangentData.tangent[2] ?? 0);
        tangents[baseIdx + 3] = tangentData.w; // w component (handedness)
      }
    }

    // Normalize the tangents
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
    // Crear buffer de vértices en GPU
    this.vertexBuffer = GPUUtils.createBuffer(
      `${this.label}_vertexBuffer`,
      this.vertices.byteLength,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      this.vertices,
    );

    // Crear buffer de normales en GPU
    this.normalBuffer = GPUUtils.createBuffer(
      `${this.label}_normalBuffer`,
      this.normals.byteLength,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      this.normals,
    );

    // Crear buffer de UVs en GPU
    this.uvBuffer = GPUUtils.createBuffer(
      `${this.label}_uvBuffer`,
      this.uvs.byteLength,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      this.uvs,
    );

    // Crear buffer de tangentes en GPU
    this.tangentBuffer = GPUUtils.createBuffer(
      `${this.label}_tangentBuffer`,
      this.tangents.byteLength,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      this.tangents,
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

  public static getVertexBufferLayout(isInstanced: boolean = false): GPUVertexBufferLayout[] {
    const layouts: GPUVertexBufferLayout[] = [
      {
        // Position attribute
        arrayStride: 3 * 4, // 3 floats * 4 bytes
        attributes: [
          {
            shaderLocation: 0,
            offset: 0,
            format: 'float32x3',
          },
        ],
        stepMode: 'vertex',
      },
      {
        // Normal attribute
        arrayStride: 3 * 4,
        attributes: [
          {
            shaderLocation: 1,
            offset: 0,
            format: 'float32x3',
          },
        ],
        stepMode: 'vertex',
      },
      {
        // UV attribute
        arrayStride: 2 * 4,
        attributes: [
          {
            shaderLocation: 2,
            offset: 0,
            format: 'float32x2',
          },
        ],
        stepMode: 'vertex',
      },
      {
        // Tangent attribute
        arrayStride: 4 * 4,
        attributes: [
          {
            shaderLocation: 3,
            offset: 0,
            format: 'float32x4',
          },
        ],
        stepMode: 'vertex',
      },
    ];

    if (isInstanced) {
      // Add instance position attribute
      layouts.push({
        arrayStride: 3 * 4, // vec3 position
        attributes: [
          {
            shaderLocation: 4, // Instance position
            offset: 0,
            format: 'float32x3',
          },
        ],
        stepMode: 'instance',
      });
    }

    return layouts;
  }

  public activate(pass: GPURenderPassEncoder, instanceBuffer?: GPUBuffer): void {
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setVertexBuffer(1, this.normalBuffer);
    pass.setVertexBuffer(2, this.uvBuffer);
    pass.setVertexBuffer(3, this.tangentBuffer);
    if (instanceBuffer) {
      pass.setVertexBuffer(4, instanceBuffer);
    }
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
  }

  public renderGroup(pass: GPURenderPassEncoder): void {
    pass.drawIndexed(this.indexCount);
  }

  public renderGroupInstanced(pass: GPURenderPassEncoder, instanceCount: number): void {
    pass.drawIndexed(this.indexCount, instanceCount);
  }

  public getName(): string {
    return this.path;
  }
}
