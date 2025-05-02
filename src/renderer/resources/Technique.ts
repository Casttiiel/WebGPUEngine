import { ResourceManager } from "../../core/engine/ResourceManager";
import { Render } from "../core/render";

export class Technique {
  private name!: string;
  private module!: GPUShaderModule;
  private pipeline!: GPURenderPipeline;
  private blendMode!: string;
  private rasterizationMode!: string;
  private depthMode!: string;
  private uniformBuffers: Map<number, { buffer: GPUBuffer, bindGroup: GPUBindGroup }> = new Map();
  private bindGroupLayout!: GPUBindGroupLayout;
  private static nextId = 0;

  constructor(name: string) {
    this.name = name;
  }

  public static async get(techniquePath: string): Promise<Technique> {
    if (ResourceManager.hasResource(techniquePath)) {
      return ResourceManager.getResource<Technique>(techniquePath);
    }

    const technique = new Technique(techniquePath);
    await technique.load();
    ResourceManager.setResource(techniquePath, technique);
    return technique;
  }

  public async load(): Promise<void> {
    const techniqueData = await ResourceManager.loadTechniqueData(this.name);

    this.blendMode = techniqueData.blend || "default";
    this.rasterizationMode = techniqueData.rs || "default";
    this.depthMode = techniqueData.z || "default";

    const vsData = await ResourceManager.loadShader(techniqueData.vs);
    const fsData = await ResourceManager.loadShader(techniqueData.fs);

    const device = Render.getInstance().getDevice();

    // Create bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' }
      }]
    });

    // Create pipeline layout
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout]
    });

    this.module = device.createShaderModule({
      label: this.name,
      code: `${vsData}\n${fsData}`,
    });

    this.pipeline = device.createRenderPipeline({
      label: this.name,
      layout: pipelineLayout,
      vertex: {
        module: this.module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 3 * 4, // position (vec3f)
            attributes: [{
              shaderLocation: 0,
              offset: 0,
              format: 'float32x3'
            }]
          },
          {
            arrayStride: 3 * 4, // normal (vec3f)
            attributes: [{
              shaderLocation: 1,
              offset: 0,
              format: 'float32x3'
            }]
          },
          {
            arrayStride: 2 * 4, // uv (vec2f)
            attributes: [{
              shaderLocation: 2,
              offset: 0,
              format: 'float32x2'
            }]
          },
          {
            arrayStride: 4 * 4, // tangent (vec4f)
            attributes: [{
              shaderLocation: 3,
              offset: 0,
              format: 'float32x4'
            }]
          }
        ]
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: [{ format: Render.getInstance().getFormat() }]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back'
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth24plus-stencil8'
      }
    });
  }

  private createUniformBufferForObject(): number {
    const device = Render.getInstance().getDevice();
    const id = Technique.nextId++;

    // Create uniform buffer
    const uniformBuffer = device.createBuffer({
      size: 4 * 16, // size of mat4x4f
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group
    const bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: uniformBuffer }
      }]
    });

    this.uniformBuffers.set(id, { buffer: uniformBuffer, bindGroup });
    return id;
  }

  public activate(objectId?: number): number {
    const pass = Render.getInstance().getPass();
    if (!pass) return -1;

    pass.setPipeline(this.pipeline);

    // If no ID is provided, create a new buffer
    if (objectId === undefined) {
      objectId = this.createUniformBufferForObject();
    }

    const bufferData = this.uniformBuffers.get(objectId);
    if (!bufferData) {
      throw new Error(`No uniform buffer found for object ID ${objectId}`);
    }

    pass.setBindGroup(0, bufferData.bindGroup);
    return objectId;
  }

  public updateUniforms(objectId: number, mvp: Float32Array): void {
    const bufferData = this.uniformBuffers.get(objectId);
    if (!bufferData) {
      throw new Error(`No uniform buffer found for object ID ${objectId}`);
    }

    Render.getInstance().getDevice().queue.writeBuffer(
      bufferData.buffer,
      0,
      mvp.buffer,
      mvp.byteOffset,
      mvp.byteLength
    );
  }
}