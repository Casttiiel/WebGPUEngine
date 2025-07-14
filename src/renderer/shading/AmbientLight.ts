import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Cubemap } from '../resources/Cubemap';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { Texture } from '../resources/Texture';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';

export class AmbientLight {
  private fullscreenQuadMesh!: Mesh;
  private environmentTexture!: Cubemap;
  private irradianceTexture!: Cubemap;
  private brdfLUTTexture!: Texture;
  private brdfLUTSampler!: GPUSampler;

  private ambientTechnique!: Technique;
  private environmentBindGroup!: GPUBindGroup;
  private uniformBindGroup!: GPUBindGroup;
  private ambientUniformBuffer!: GPUBuffer;

  private reflectionIntensity = 0.8;
  private ambientLightIntensity = 0.8;
  private globalAmbientBoost = 0.02;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.ambientTechnique = await Technique.get('ambient.tech');
    this.environmentTexture = await Cubemap.get('skybox.png');
    this.irradianceTexture = await Cubemap.get('irradiance.png');
    this.brdfLUTTexture = await Texture.get('brdfLUT.png');

    // Create specific sampler for BRDF LUT (clamp-to-edge, linear filtering)
    this.brdfLUTSampler = GPUUtils.createSampler({
      label: 'BRDF LUT Sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.environmentBindGroup = BindGroupFactory.createBindGroup(
      'environment_with_brdf_bindgroup',
      this.ambientTechnique.getPipeline().getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: this.environmentTexture.getTextureView()!,
        },
        {
          binding: 1,
          resource: this.environmentTexture.getSampler()!,
        },
        {
          binding: 2,
          resource: this.brdfLUTTexture.getTextureView()!,
        },
        {
          binding: 3,
          resource: this.brdfLUTSampler,
        },
        {
          binding: 4,
          resource: this.irradianceTexture.getTextureView()!,
        },
        {
          binding: 5,
          resource: this.irradianceTexture.getSampler()!,
        },
      ],
    );

    this.ambientUniformBuffer = GPUUtils.createBuffer(
      'ambient uniform buffer',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.uniformBindGroup = BindGroupFactory.createBindGroup(
      'ambient light uniform bind group',
      this.ambientTechnique.getPipeline().getBindGroupLayout(3),
      [
        {
          binding: 0,
          resource: { buffer: this.ambientUniformBuffer },
        },
      ],
    );

    GPUUtils.writeBuffer(
      this.ambientUniformBuffer,
      0,
      new Float32Array([
        this.reflectionIntensity,
        this.ambientLightIntensity,
        this.globalAmbientBoost,
        0.0,
      ]),
    );
  }

  public render(rtAccLight: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();

    // Use GPUUtils for consistent render pass descriptor creation
    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'clear', 'store', {
      r: 0,
      g: 0,
      b: 0,
      a: 1,
    });

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor('ambient light render pass', [colorAttachment]),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.ambientTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup()); // Camera uniforms
    pass.setBindGroup(1, gBufferBindGroup); // GBuffer textures
    pass.setBindGroup(2, this.environmentBindGroup); // Environment texture
    pass.setBindGroup(3, this.uniformBindGroup); // ambient parameters

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public update(_dt: number): void {}
}
