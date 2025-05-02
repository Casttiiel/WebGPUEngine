import { ResourceManager } from "../../core/engine/ResourceManager";
import { Render } from "../core/render";

export class Technique {
  private name!: string;
  private module!: GPUShaderModule;
  private pipeline!: GPURenderPipeline;
  private blendMode!: string;
  private rasterizationMode!: string;
  private depthMode!: string;
  private uniformBuffer!: GPUBuffer;
  private uniformBindGroup!: GPUBindGroup;

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

    this.blendMode = techniqueData.blendMode || "default";
    this.rasterizationMode = techniqueData.rs || "default";
    this.depthMode = techniqueData.z || "default";

    const vsData = await ResourceManager.loadShader(techniqueData.vs);
    const fsData = await ResourceManager.loadShader(techniqueData.fs);

    const device = Render.getInstance().getDevice();

    // Create uniform buffer
    this.uniformBuffer = device.createBuffer({
      size: 4 * 16, // size of mat4x4f
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group layout
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' }
      }]
    });

    // Create pipeline layout
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout]
    });

    // Create bind group
    this.uniformBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: this.uniformBuffer }
      }]
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

  public activate(): void {
    const pass = Render.getInstance().getPass();
    if (!pass) return;

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.uniformBindGroup);
  }

  public updateUniforms(mvp: Float32Array): void {
    Render.getInstance().getDevice().queue.writeBuffer(
      this.uniformBuffer,
      0,
      mvp.buffer,
      mvp.byteOffset,
      mvp.byteLength
    );
  }
}