import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { Cubemap } from '../resources/Cubemap';

export class AmbientLight {
  private fullscreenQuadMesh!: Mesh;
  private irradianceTexture!: Cubemap;

  private ambientTechnique!: Technique;
  private ambientBindGroup!: GPUBindGroup;
  private ambientUniformBuffer!: GPUBuffer;

  private reflectionIntensity = 1.0;
  private ambientLightIntensity = 1.0;
  private globalAmbientBoost = 1.0;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.ambientTechnique = await Technique.get('ambient.tech');
    this.irradianceTexture = await Cubemap.getAsync('irradiance_cubemap.png');

    this.ambientUniformBuffer = GPUUtils.createBuffer(
      'ambient uniform buffer',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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

  public render(
    rtAccLight: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    aoResult: GPUTextureView,
  ): void {
    if (!this.ambientBindGroup) {
      this.createAmbientBindGroup(aoResult);
    }
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
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.ambientBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  private createAmbientBindGroup(aoResult: GPUTextureView): void {
    this.ambientBindGroup = BindGroupFactory.createBindGroup(
      'ambient_bindgroup',
      this.ambientTechnique.getPipeline().getBindGroupLayout(2),
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
          resource: { buffer: this.ambientUniformBuffer },
        },
        {
          binding: 3,
          resource: this.irradianceTexture.getTextureView()!,
        },
        {
          binding: 4,
          resource: this.irradianceTexture.getSampler()!,
        },
      ],
    );
  }

  public update(_dt: number): void {}

  public destroy(): void {
    this.ambientBindGroup = null!;
  }
}
