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

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.skyboxTechnique = await Technique.getAsync('skybox.tech');

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

  public render(rtAccLight: GPUTextureView, depthStencilView: GPUTextureView): void {
    const render = Render.getInstance();

    // Use GPUUtils for consistent render pass descriptor creation
    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'clear', 'store');
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
