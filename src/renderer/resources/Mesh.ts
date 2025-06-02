import { ResourceManager } from "../../core/engine/ResourceManager";
import { Render } from "../core/render";

export class Mesh {
    private name: string;
    // Datos de la geometría en CPU
    private vertices!: Float32Array;    // Posiciones de los vértices
    private normals!: Float32Array;     // Normales de los vértices
    private uvs!: Float32Array;         // Coordenadas de textura
    private indices!: Uint16Array;      // Índices para formar triángulos
    private tangents!: Float32Array;    // Vectores tangentes para normal mapping
    private indexCount!: number;        // Número total de índices

    // Buffers en GPU
    private vertexBuffer!: GPUBuffer;   // Buffer de vértices
    private normalBuffer!: GPUBuffer;   // Buffer de normales
    private uvBuffer!: GPUBuffer;       // Buffer de UVs
    private tangentBuffer!: GPUBuffer;  // Buffer de tangentes
    private indexBuffer!: GPUBuffer;    // Buffer de índices

    constructor(name: string) {
        this.name = name;
    }

    static async get(meshData: unknown): Promise<Mesh> {
        if (typeof meshData === 'string') {
            if (ResourceManager.hasResource(meshData)) {
                return ResourceManager.getResource<Mesh>(meshData);
            }

            const mesh = new Mesh(meshData);
            await mesh.load();
            ResourceManager.setResource(meshData, mesh);
            return mesh;
        } else {
            const mesh = new Mesh("unkown mesh name" + Mesh.id);
            mesh.setData(meshData);
            mesh.initBuffers();
            return mesh;
        }
    }

    public async load(): Promise<void> {
        const data = await ResourceManager.loadMeshData(this.name);
        this.loadObj(data);
        this.initBuffers();
    }

    public setData(meshData: unknown): void {
        this.vertices = new Float32Array(meshData.attributes.POSITION.data);
        this.normals = new Float32Array(meshData.attributes.NORMAL.data);
        this.uvs = new Float32Array(meshData.attributes.TEXCOORD_0.data);
        this.indices = new Uint16Array(meshData.indices.data);
        this.tangents = new Float32Array();//TODO
        this.indexCount = this.indices.length;
    }

    private loadObj(data: string): void {
        // Arrays temporales para acumular datos
        const verticesArray: number[] = [];
        const normalsArray: number[] = [];
        const uvsArray: number[] = [];
        const indicesArray: number[] = [];
        const tangentsArray: number[] = [];

        // Arrays temporales para datos del archivo OBJ
        const tempVertices: number[] = [];    // Posiciones del archivo
        const tempNormals: number[] = [];     // Normales del archivo
        const tempUVs: number[] = [];         // UVs del archivo
        const tempIndices: { [key: string]: number } = {};  // Mapa de índices únicos
        const tangentAccum: { [key: number]: number[] } = {};  // Acumulador de tangentes
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
                case 'v':  // Vértice
                    tempVertices.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2]),
                        parseFloat(parts[3])
                    );
                    break;

                case 'vn': // Normal
                    tempNormals.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2]),
                        parseFloat(parts[3])
                    );
                    break;

                case 'vt': // Coordenada de textura
                    tempUVs.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2])
                    );
                    break;

                case 'f': // Cara (triángulo)
                    const faceVertices = [];
                    const faceUVs = [];
                    const faceIndices = [];

                    // Procesar cada vértice de la cara
                    for (let i = 1; i < parts.length; i++) {
                        const vertex = parts[i];
                        if (!(vertex in tempIndices)) {
                            // Formato del OBJ: v/vt/vn
                            const indices = vertex.split('/').map(index => parseInt(index) - 1);
                            const v = indices[0];  // índice de vértice
                            const vt = indices[1]; // índice de UV
                            const vn = indices[2]; // índice de normal

                            // Añadir atributos a los arrays finales
                            verticesArray.push(
                                tempVertices[v * 3],
                                tempVertices[v * 3 + 1],
                                tempVertices[v * 3 + 2]
                            );

                            if (vt !== undefined && !isNaN(vt)) {
                                uvsArray.push(
                                    tempUVs[vt * 2],
                                    tempUVs[vt * 2 + 1]
                                );
                            }

                            if (vn !== undefined && !isNaN(vn)) {
                                normalsArray.push(
                                    tempNormals[vn * 3],
                                    tempNormals[vn * 3 + 1],
                                    tempNormals[vn * 3 + 2]
                                );
                            }

                            tempIndices[vertex] = indexCount++;
                        }

                        const idx = tempIndices[vertex];
                        indicesArray.push(idx);
                        faceVertices.push(idx);

                        // Extraer índices de UV nuevamente para el cálculo de tangentes
                        const indices = vertex.split('/').map(index => parseInt(index) - 1);
                        const vt = indices[1]; // índice de UV
                        if (vertex.includes('/') && vt !== undefined && !isNaN(vt)) {
                            faceUVs.push([tempUVs[vt * 2], tempUVs[vt * 2 + 1]]);
                        }

                        faceIndices.push(idx);
                    }

                    // Calcular tangentes para normal mapping
                    if (faceVertices.length === 3 && faceUVs.length === 3) {
                        const idx0 = faceIndices[0];
                        const idx1 = faceIndices[1];
                        const idx2 = faceIndices[2];

                        const p0 = tempVertices.slice(idx0 * 3, idx0 * 3 + 3);
                        const p1 = tempVertices.slice(idx1 * 3, idx1 * 3 + 3);
                        const p2 = tempVertices.slice(idx2 * 3, idx2 * 3 + 3);

                        const uv0 = faceUVs[0];
                        const uv1 = faceUVs[1];
                        const uv2 = faceUVs[2];

                        // Calcular tangente para este triángulo
                        const tangentData = this.computeTangent(p0, p1, p2, uv0, uv1, uv2);

                        const tangent = tangentData.tangent;
                        const w = tangentData.w;

                        // Almacenar tangente para cada vértice del triángulo
                        faceIndices.forEach(idx => {
                            if (!tangentAccum[idx]) tangentAccum[idx] = [0, 0, 0];
                            tangentAccum[idx][0] += tangent[0];
                            tangentAccum[idx][1] += tangent[1];
                            tangentAccum[idx][2] += tangent[2];

                            while (tangentsArray.length < idx * 4 + 4) {
                                tangentsArray.push(0);
                            }
                            tangentsArray[idx * 4] = tangent[0];
                            tangentsArray[idx * 4 + 1] = tangent[1];
                            tangentsArray[idx * 4 + 2] = tangent[2];
                            tangentsArray[idx * 4 + 3] = w;
                        });
                    }
                    break;
            }
        }

        // Crear los TypedArrays finales con los datos procesados
        this.vertices = new Float32Array(verticesArray);
        this.normals = new Float32Array(normalsArray);
        this.uvs = new Float32Array(uvsArray);
        this.indices = new Uint16Array(indicesArray);
        this.tangents = new Float32Array(tangentsArray);
        this.indexCount = this.indices.length;
    }

    private computeTangent(
        p0: number[], p1: number[], p2: number[],
        uv0: number[], uv1: number[], uv2: number[]
    ): { tangent: number[], w: number } {
        const edge1 = [
            p1[0] - p0[0],
            p1[1] - p0[1],
            p1[2] - p0[2]
        ];
        const edge2 = [
            p2[0] - p0[0],
            p2[1] - p0[1],
            p2[2] - p0[2]
        ];

        const deltaUV1 = [
            uv1[0] - uv0[0],
            uv1[1] - uv0[1]
        ];
        const deltaUV2 = [
            uv2[0] - uv0[0],
            uv2[1] - uv0[1]
        ];

        const f = 1.0 / (deltaUV1[0] * deltaUV2[1] - deltaUV2[0] * deltaUV1[1]);
        const tangent = [
            f * (deltaUV2[1] * edge1[0] - deltaUV1[1] * edge2[0]),
            f * (deltaUV2[1] * edge1[1] - deltaUV1[1] * edge2[1]),
            f * (deltaUV2[1] * edge1[2] - deltaUV1[1] * edge2[2])
        ];

        const uDirection = deltaUV1[0] * deltaUV2[1] - deltaUV2[0] * deltaUV1[1];
        const w = uDirection >= 0 ? 1 : -1; // 1 o -1 dependiendo de la dirección

        return { tangent, w };
    }

    private initBuffers(): void {
        // Crear buffer de vértices en GPU
        this.vertexBuffer = Render.getInstance().getDevice().createBuffer({
            label: `${this.name}_vertexBuffer`,
            size: this.vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true  // Permitir escribir datos durante la creación
        });
        new Float32Array(this.vertexBuffer.getMappedRange()).set(this.vertices);
        this.vertexBuffer.unmap();

        // Crear buffer de normales en GPU
        this.normalBuffer = Render.getInstance().getDevice().createBuffer({
            label: `${this.name}_normalBuffer`,
            size: this.normals.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.normalBuffer.getMappedRange()).set(this.normals);
        this.normalBuffer.unmap();

        // Crear buffer de UVs en GPU
        this.uvBuffer = Render.getInstance().getDevice().createBuffer({
            label: `${this.name}_uvBuffer`,
            size: this.uvs.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.uvBuffer.getMappedRange()).set(this.uvs);
        this.uvBuffer.unmap();

        // Crear buffer de tangentes en GPU
        this.tangentBuffer = Render.getInstance().getDevice().createBuffer({
            label: `${this.name}_tangentBuffer`,
            size: this.tangents.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.tangentBuffer.getMappedRange()).set(this.tangents);
        this.tangentBuffer.unmap();

        // Crear buffer de índices en GPU
        const paddedIndexCount = Math.ceil(this.indices.length * 2 / 4) * 2;
        const paddedArray = new Uint16Array(paddedIndexCount);
        paddedArray.set(this.indices);

        this.indexBuffer = Render.getInstance().getDevice().createBuffer({
            label: `${this.name}_indexBuffer`,
            size: paddedArray.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
        });

        Render.getInstance().getDevice().queue.writeBuffer(this.indexBuffer, 0, paddedArray);
    }

    public getVertexBufferLayout(): GPUVertexBufferLayout[] {
        return [
            {
                // Position attribute
                arrayStride: 3 * 4, // 3 floats * 4 bytes
                attributes: [{
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x3'
                }]
            },
            {
                // Normal attribute
                arrayStride: 3 * 4,
                attributes: [{
                    shaderLocation: 1,
                    offset: 0,
                    format: 'float32x3'
                }]
            },
            {
                // UV attribute
                arrayStride: 2 * 4,
                attributes: [{
                    shaderLocation: 2,
                    offset: 0,
                    format: 'float32x2'
                }]
            },
            {
                // Tangent attribute
                arrayStride: 4 * 4,
                attributes: [{
                    shaderLocation: 3,
                    offset: 0,
                    format: 'float32x4'
                }]
            }
        ];
    }

    // Activar esta malla para renderizado
    public activate(pass: GPURenderPassEncoder): void {
        pass.setVertexBuffer(0, this.vertexBuffer);
        pass.setVertexBuffer(1, this.normalBuffer);
        pass.setVertexBuffer(2, this.uvBuffer);
        pass.setVertexBuffer(3, this.tangentBuffer);
        pass.setIndexBuffer(this.indexBuffer, 'uint16');
    }

    // Renderizar la malla completa
    public renderGroup(pass: GPURenderPassEncoder): void {
        pass.drawIndexed(this.indexCount);
    }

    public getName(): string {
        return this.name;
    }
}