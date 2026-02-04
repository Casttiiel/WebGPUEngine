import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';

export class Skybox {
  private fullscreenQuadMesh!: Mesh;
  private skyboxTechnique!: Technique;
  private skyboxBindGroup!: GPUBindGroup;
  private skyboxType!: string;

  // Procedural skybox resources
  private proceduralUniformBuffer!: GPUBuffer;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Load technique based on skybox type
    this.skyboxType = Engine.getEnvironmentManager().getSkyboxType();
    let techniquePath = 'lighting/skybox.tech'; // Default HDR

    if (this.skyboxType === 'cubemap') {
      techniquePath = 'lighting/skybox.tech';
    } else if (this.skyboxType === 'procedural') {
      techniquePath = 'lighting/skybox_scattering.tech';
    }

    this.skyboxTechnique = await Technique.getAsync(techniquePath);

    // Create bind group based on skybox type
    if (this.skyboxType === 'procedural') {
      this.createProceduralBindGroup();
    } else {
      this.createTextureBindGroup();
    }
  }

  /**
   * Creates bind group for texture-based skybox (HDR or cubemap)
   */
  private createTextureBindGroup(): void {
    this.skyboxBindGroup = BindGroupFactory.createBindGroup(
      `skybox_bindgroup`,
      this.skyboxTechnique.getPipeline().getBindGroupLayout(1)!,
      [
        {
          binding: 0,
          resource: Engine.getEnvironmentManager().getSkyboxTexture().getTextureView()!,
        },
        {
          binding: 1,
          resource: Engine.getEnvironmentManager().getSkyboxTexture().getSampler()!,
        },
      ],
    );
  }

  /**
   * Creates bind group for procedural skybox with uniform buffer
   * Uniform buffer layout:
   * - vec3 sunDirection (12 bytes + 4 padding = 16 bytes)
   * - float timeOfDay (4 bytes + 12 padding = 16 bytes)
   * Total: 32 bytes
   */
  private createProceduralBindGroup(): void {
    // Create uniform buffer for procedural skybox parameters
    this.proceduralUniformBuffer = GPUUtils.createBuffer(
      'skybox_procedural_uniforms',
      32, // vec3 (16 bytes aligned) + float (16 bytes aligned)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.skyboxBindGroup = BindGroupFactory.createBindGroup(
      `skybox_procedural_bindgroup`,
      this.skyboxTechnique.getPipeline().getBindGroupLayout(1)!,
      [
        {
          binding: 0,
          resource: {
            buffer: this.proceduralUniformBuffer,
          },
        },
      ],
    );
  }

  /**
   * Updates procedural skybox uniforms (called before render if procedural)
   */
  private updateProceduralUniforms(): void {
    const device = GPUUtils.getDevice();
    const envManager = Engine.getEnvironmentManager();

    const sunDir = envManager.getSunDirection();
    const timeOfDay = envManager.getTimeOfDay();

    // Pack data: vec3 sunDirection (16 bytes) + float timeOfDay (16 bytes)
    const uniformData = new Float32Array(8); // 32 bytes / 4 = 8 floats
    uniformData[0] = sunDir[0];
    uniformData[1] = sunDir[1];
    uniformData[2] = sunDir[2];
    // uniformData[3] = padding
    uniformData[4] = timeOfDay;
    // uniformData[5-7] = padding

    device.queue.writeBuffer(this.proceduralUniformBuffer, 0, uniformData);
  }

  public render(rtAccLight: GPUTextureView, depthStencilView: GPUTextureView): void {
    // Update procedural uniforms if using procedural skybox
    if (this.skyboxType === 'procedural') {
      this.updateProceduralUniforms();
    }

    const render = Render.getInstance();

    // Use GPUUtils for consistent render pass descriptor creation
    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'load', 'store');
    const depthAttachment = GPUUtils.createDepthStencilAttachment(
      depthStencilView,
      'load',
      'store',
    );

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor(
          'skybox render pass',
          [colorAttachment],
          depthAttachment,
        ),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.skyboxTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, this.skyboxBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }
}
