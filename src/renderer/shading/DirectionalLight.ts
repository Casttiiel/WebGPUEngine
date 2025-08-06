import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { RenderTarget } from '../resources/RenderTarget';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Camera } from '../../core/math/Camera';

export class DirectionalLight {
  private fullscreenQuadMesh!: Mesh;
  private directionalLightTechnique!: Technique;
  private directionalLightBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;
  public shadowMap!: RenderTarget;
  private depthStencil!: GPUTexture;
  private depthStencilView!: GPUTextureView;
  private camera!: Camera;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.directionalLightTechnique = await Technique.get('directional_light.tech');

    this.uniformBuffer = GPUUtils.createBuffer(
      'directional light uniform buffer',
      36 * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    GPUUtils.writeBuffer(this.uniformBuffer, 0, new Float32Array([1.0, 0.956, 0.878, 1.0])); // color
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      16,
      new Float32Array(
        [-0.5, 1.0, 0.0, 10.0], // direction and intensity
      ),
    );

    this.directionalLightBindGroup = BindGroupFactory.createBindGroup(
      `directional_light_bindgroup`,
      this.directionalLightTechnique.getPipeline().getBindGroupLayout(2)!,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    );

    this.shadowMap = new RenderTarget();
    this.shadowMap.createRT(
      'directional_light_shadow_map.dds',
      Render.width,
      Render.height,
      'r16float',
    );

    this.depthStencil = GPUUtils.createTexture(
      'directional light depth stencil',
      Render.width,
      Render.height,
      'depth32float',
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );

    this.depthStencilView = this.depthStencil.createView({
      aspect: 'depth-only',
    });

    this.camera = new Camera();
    this.camera.setNearPlane(0.1);
    this.camera.setFarPlane(200.0);
    this.camera.setOrthoParams(true, 0, 50, 0, 50);
    //this.camera.setProjectionParams(60, 0.1, 200.0);
    //this.camera.lookAt([3.5, 20.0, 0.0], [-0.5, -0.8, 0.0]);
    this.camera.lookAt([0.0, 2.0, 0.0], [0.0, 2.0, 1.0]);
    this.camera.updateUniforms();
  }

  public renderShadowMap(): void {
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(this.shadowMap.getView()!);

    const depthStencilAttachment = GPUUtils.createDepthStencilAttachment(this.depthStencilView!);

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor(
          'directional light shadow map render pass',
          [colorAttachment],
          depthStencilAttachment,
        ),
      );
    GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);

    RenderManager.getInstance().setCamera(this.camera);

    RenderManager.getInstance().render(RenderCategory.SHADOWS, pass);

    pass.end();
  }

  public render(rtAccLight: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();

    // Use GPUUtils for consistent render pass descriptor creation
    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'load', 'store');

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor('directional light render pass', [colorAttachment]),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.directionalLightTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.directionalLightBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }
}
