import { ResourceManager } from "../../core/engine/ResourceManager";
import { Render } from "../core/render";


export class Mesh {
    private name: string;
    private vertices!: Float32Array;
    private normals!: Float32Array;
    private uvs!: Float32Array;
    private indices!: Uint16Array;
    private tangents!: Float32Array;
    private indexCount!: number;

    // WebGPU buffers
    private vertexBuffer!: GPUBuffer;
    private normalBuffer!: GPUBuffer;
    private uvBuffer!: GPUBuffer;
    private tangentBuffer!: GPUBuffer;
    private indexBuffer!: GPUBuffer;

    constructor(name: string) {
        this.name = name;
    }

    static async get(meshPath: string): Promise<Mesh> {
        if (ResourceManager.hasResource(meshPath)) {
            return ResourceManager.getResource<Mesh>(meshPath);
        }

        const mesh = new Mesh(meshPath);
        await mesh.load();
        ResourceManager.setResource(meshPath, mesh);
        return mesh;
    }

    public async load(): Promise<void> {
        const data = await ResourceManager.loadMeshData(this.name);
        this.loadObj(data);
        this.initBuffers();
    }

    private loadObj(data: string): void {
        // Arrays temporales para acumular datos
        const verticesArray: number[] = [];
        const normalsArray: number[] = [];
        const uvsArray: number[] = [];
        const indicesArray: number[] = [];
        const tangentsArray: number[] = [];

        const tempVertices: number[] = [];
        const tempNormals: number[] = [];
        const tempUVs: number[] = [];
        const tempIndices: { [key: string]: number } = {};
        const tangentAccum: { [key: number]: number[] } = {};
        let indexCount = 0;

        const lines = data.split('\n');
        for (let line of lines) {
            line = line.trim();

            if (line.startsWith('#') || line === '') {
                continue;
            }

            const parts = line.split(/\s+/);
            const keyword = parts[0];

            switch (keyword) {
                case 'v': // Vértices
                    tempVertices.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2]),
                        parseFloat(parts[3])
                    );
                    break;

                case 'vn': // Normales
                    tempNormals.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2]),
                        parseFloat(parts[3])
                    );
                    break;

                case 'vt': // Coordenadas de textura
                    tempUVs.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2])
                    );
                    break;

                case 'f': // Caras
                    const faceVertices = [];
                    const faceUVs = [];
                    const faceIndices = [];
                    let v;
                    let vt;
                    let vn;

                    for (let i = 1; i < parts.length; i++) {
                        const vertex = parts[i];
                        if (!(vertex in tempIndices)) {
                            const indices = vertex.split('/').map(index => parseInt(index) - 1);
                            v = indices[0];
                            vt = indices[1];
                            vn = indices[2];

                            // Agregar atributos a los arrays temporales
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

                        if (vertex.includes('/') && vt !== undefined && !isNaN(vt)) {
                            faceUVs.push([tempUVs[vt * 2], tempUVs[vt * 2 + 1]]);
                        }

                        faceIndices.push(idx);
                    }

                    // Calcular tangentes para la cara
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

                        const tangentData = this.computeTangent(p0, p1, p2, uv0, uv1, uv2);

                        const tangent = tangentData.tangent;
                        const w = tangentData.w;

                        faceIndices.forEach(idx => {
                            if (!tangentAccum[idx]) tangentAccum[idx] = [0, 0, 0];
                            tangentAccum[idx][0] += tangent[0];
                            tangentAccum[idx][1] += tangent[1];
                            tangentAccum[idx][2] += tangent[2];

                            // Almacenar la componente W en la misma posición del array de tangentes
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

                default:
                    break;
            }
        }

        // Crear los TypedArrays finales con los datos acumulados
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
        // Create vertex buffer
        this.vertexBuffer = Render.getInstance().getDevice().createBuffer({
            size: this.vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.vertexBuffer.getMappedRange()).set(this.vertices);
        this.vertexBuffer.unmap();

        // Create normal buffer
        this.normalBuffer = Render.getInstance().getDevice().createBuffer({
            size: this.normals.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.normalBuffer.getMappedRange()).set(this.normals);
        this.normalBuffer.unmap();

        // Create UV buffer
        this.uvBuffer = Render.getInstance().getDevice().createBuffer({
            size: this.uvs.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.uvBuffer.getMappedRange()).set(this.uvs);
        this.uvBuffer.unmap();

        // Create tangent buffer
        this.tangentBuffer = Render.getInstance().getDevice().createBuffer({
            size: this.tangents.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(this.tangentBuffer.getMappedRange()).set(this.tangents);
        this.tangentBuffer.unmap();

        // Create index buffer
        this.indexBuffer = Render.getInstance().getDevice().createBuffer({
            size: this.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Uint16Array(this.indexBuffer.getMappedRange()).set(this.indices);
        this.indexBuffer.unmap();
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

    public activate(passEncoder: GPURenderPassEncoder): void {
        passEncoder.setVertexBuffer(0, this.vertexBuffer);
        passEncoder.setVertexBuffer(1, this.normalBuffer);
        passEncoder.setVertexBuffer(2, this.uvBuffer);
        passEncoder.setVertexBuffer(3, this.tangentBuffer);
        passEncoder.setIndexBuffer(this.indexBuffer, 'uint16');
    }

    public renderInstanced(a: unknown, b: unknown): void {
        // Logic to render the mesh with instancing
    }

    public renderGroup(): void {
        const pass = Render.getInstance().getPass();
        pass?.drawIndexed(this.indexCount, 1, 0, 0, 0);
    }

    public getName(): string {
        return this.name;
    }
}