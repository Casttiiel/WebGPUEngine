import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { Wind } from '../../core/engine/Wind';

export class Skybox {
  private fullscreenQuadMesh!: Mesh;
  private skyboxTechnique!: Technique;
  private skyboxBindGroup!: GPUBindGroup;
  private skyboxType!: string;

  // Procedural skybox resources
  private proceduralUniformBuffer!: GPUBuffer;

  // Cloud / wind animation state
  private windOffset: number = 0.0;
  private lastRenderTime: number = 0;

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
   * Uniform buffer layout (WGSL std layout, struct align = 16):
   *   vec3  sunDirection      offset  0, size 12
   *   f32   timeOfDay         offset 12, size  4  → 16 bytes
   *   vec2  windDirection     offset 16, size  8
   *   f32   cloudThickness    offset 24, size  4
   *   f32   cloudDistanceFade offset 28, size  4  → 32 bytes
   *   f32   windOffset        offset 32, size  4
   *   f32   cloudScale        offset 36, size  4
   *   f32   cloudCoverage     offset 40, size  4
   *   f32   cloudOpacity      offset 44, size  4  → 48 bytes
   *   f32   cloudLayers       offset 48, size  4
   *   f32   cloudColorR       offset 52, size  4
   *   f32   cloudColorG       offset 56, size  4
   *   f32   cloudColorB       offset 60, size  4  → 64 bytes
   */
  private createProceduralBindGroup(): void {
    // Create uniform buffer for procedural skybox parameters
    this.proceduralUniformBuffer = GPUUtils.createBuffer(
      'skybox_procedural_uniforms',
      64, // 16 floats × 4 bytes
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

    // Accumulate wind offset using a local timer (self-contained, no dt dependency)
    const now = performance.now() * 0.001; // seconds
    if (this.lastRenderTime > 0) {
      const dt = now - this.lastRenderTime;
      this.windOffset += Wind.speed * dt;
    }
    this.lastRenderTime = now;

    // Normalized wind direction from Wind singleton
    const windDirX = Wind.getDirX();
    const windDirZ = Wind.getDirZ();

    // WGSL struct layout (see createProceduralBindGroup for byte map):
    const uniformData = new Float32Array(16); // 64 bytes
    uniformData[0] = sunDir[0]; // sunDirection.x  | byte  0
    uniformData[1] = sunDir[1]; // sunDirection.y  | byte  4
    uniformData[2] = sunDir[2]; // sunDirection.z  | byte  8
    uniformData[3] = timeOfDay; // timeOfDay       | byte 12
    uniformData[4] = windDirX; // windDirection.x | byte 16
    uniformData[5] = windDirZ; // windDirection.y | byte 20
    uniformData[6] = envManager.cloudThickness; // cloudThickness  | byte 24
    uniformData[7] = envManager.cloudDistanceFade; // distanceFade  | byte 28
    uniformData[8] = this.windOffset; // windOffset      | byte 32
    uniformData[9] = envManager.cloudScale; // cloudScale      | byte 36
    uniformData[10] = envManager.cloudCoverage; // cloudCoverage  | byte 40
    uniformData[11] = envManager.cloudOpacity; // cloudOpacity    | byte 44
    uniformData[12] = envManager.cloudLayers; // cloudLayers     | byte 48
    uniformData[13] = envManager.cloudColor[0]; // cloudColorR | byte 52
    uniformData[14] = envManager.cloudColor[1]; // cloudColorG | byte 56
    uniformData[15] = envManager.cloudColor[2]; // cloudColorB | byte 60

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

    const skyboxDesc = GPUUtils.createRenderPassDescriptor(
      'skybox render pass',
      [colorAttachment],
      depthAttachment,
    );
    const skyboxTs = GPUProfiler.getInstance().getTimestampWrites('Skybox');
    if (skyboxTs) skyboxDesc.timestampWrites = skyboxTs;
    const pass = render.getCommandEncoder().beginRenderPass(skyboxDesc);

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
