import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { Texture } from '../resources/Texture';

export class AmbientLight {
  private fullscreenQuadMesh!: Mesh;

  private ambientDiffuseTechnique!: Technique;
  private ambientDiffuseBindGroup!: GPUBindGroup;
  private ambientDiffuseUniformBuffer!: GPUBuffer;

  private ambientSpecularTechnique!: Technique;
  private ambientSpecularBindGroup!: GPUBindGroup;
  private ambientSpecularUniformBuffer!: GPUBuffer;

  private brdfLUT!: Texture;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.ambientDiffuseTechnique = await Technique.getAsync('ambient.tech');

    this.ambientDiffuseUniformBuffer = GPUUtils.createBuffer(
      'ambient diffuse uniform buffer',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.ambientSpecularTechnique = await Technique.getAsync('ambient_specular.tech');

    this.brdfLUT = await Texture.getAsync('brdfLUT.png');

    this.ambientSpecularUniformBuffer = GPUUtils.createBuffer(
      'ambient specular uniform buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
  }

  public renderDiffuse(
    rtAccLight: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    aoResult: GPUTextureView,
  ): void {
    if (!this.ambientDiffuseBindGroup) {
      this.createAmbientDiffuseBindGroup(aoResult);
    }
    const render = Render.getInstance();

    // Use GPUUtils for consistent render pass descriptor creation
    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'clear', 'store');

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor('ambient light render pass', [colorAttachment]),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.ambientDiffuseTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.ambientDiffuseBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public renderSpecular(
    accLights: GPUTextureView,
    ssr: GPUTextureView,
    ao: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
  ): void {
    if (!this.ambientSpecularBindGroup) {
      this.createAmbientSpecularBindGroup(ssr, ao);
    }
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(accLights, 'load', 'store');

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor('ambient specular render pass', [colorAttachment]),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);

    // 1. Activate pipeline
    this.ambientSpecularTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.ambientSpecularBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  private createAmbientDiffuseBindGroup(aoResult: GPUTextureView): void {
    this.ambientDiffuseBindGroup = BindGroupFactory.createBindGroup(
      'ambient_bindgroup',
      this.ambientDiffuseTechnique.getPipeline().getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: aoResult,
        },
        {
          binding: 1,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 2,
          resource: { buffer: this.ambientDiffuseUniformBuffer },
        },
        {
          binding: 3,
          resource: Engine.getEnvironmentManager()
            .getAmbientLightData()
            .irradianceCubemap.getTextureView()!,
        },
        {
          binding: 4,
          resource: Engine.getEnvironmentManager()
            .getAmbientLightData()
            .irradianceCubemap.getSampler()!,
        },
      ],
    );
  }

  private createAmbientSpecularBindGroup(ssr: GPUTextureView, ao: GPUTextureView) {
    this.ambientSpecularBindGroup = BindGroupFactory.createBindGroup(
      'ambient_specular_bindgroup',
      this.ambientSpecularTechnique.getPipeline().getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: ssr,
        },
        {
          binding: 1,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 2,
          resource: ao,
        },
        {
          binding: 3,
          resource: this.brdfLUT.getTextureView()!,
        },
        {
          binding: 4,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 5,
          resource: Engine.getEnvironmentManager().getSSREnvironmentTexture().getTextureView()!,
        },
        {
          binding: 6,
          resource: Engine.getEnvironmentManager().getSSREnvironmentTexture().getSampler()!,
        },
        {
          binding: 7,
          resource: { buffer: this.ambientSpecularUniformBuffer },
        },
      ],
    );
  }

  public update(_dt: number): void {
    GPUUtils.writeBuffer(
      this.ambientDiffuseUniformBuffer,
      0,
      new Float32Array([
        Engine.getEnvironmentManager().getAmbientLightData().globalFactor,
        Engine.getEnvironmentManager().getAmbientLightData().diffuseFactor,
        0.0,
        0.0,
      ]),
    );

    GPUUtils.writeBuffer(
      this.ambientSpecularUniformBuffer,
      0,
      new Float32Array([
        Engine.getEnvironmentManager().getAmbientLightData().globalFactor,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        Engine.getEnvironmentManager().getAmbientLightData().reflectionFactor,
        Engine.getEnvironmentManager().getAmbientLightData().diffuseFactor,
      ]),
    );
  }

  public destroy(): void {
    this.ambientDiffuseBindGroup = null!;
    this.ambientSpecularBindGroup = null!;
  }
}
