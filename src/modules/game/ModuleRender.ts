import { AntialiasingComponent } from '../../components/render/AntialiasingComponent';
import { CameraComponent } from '../../components/render/CameraComponent';
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
import { Engine } from '../../core/engine/Engine';
import { Camera } from '../../core/math/Camera';
import { DeferredRenderer } from '../../renderer/core/DeferredRenderer';
import { Render } from '../../renderer/core/Render';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Module } from '../core/Module';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';

export class ModuleRender extends Module {
  private deferred: DeferredRenderer;
  private debugControlsAdded: boolean = false;

  // Buffer global para datos de cámara
  private globalUniformBuffer!: GPUBuffer;
  private globalBindGroup!: GPUBindGroup;

  //Presentation data
  private presentationTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private presentationBindGroup!: GPUBindGroup | null;

  // Debug values para Tweakpane
  private debugValues = {
    drawCallsSolids: { name: 'Draw Calls (Solids)', value: 0 },
    drawCallsTransparent: { name: 'Draw Calls (Transparent)', value: 0 },
    drawCallsDistorsions: { name: 'Draw Calls (Distorsions)', value: 0 },
    totalDrawCalls: { name: 'Total Draw Calls', value: 0 },
    resolution: { name: 'Resolution', value: '0x0' },
  };

  constructor(name: string) {
    super(name);
    this.deferred = new DeferredRenderer();
  }

  public async start(): Promise<boolean> {
    await this.deferred.load();
    this.onResolutionUpdated();
    this.initializeUniformBuffers();
    await this.initializePresentationData();

    // Initialize GPU Frustum Culling
    await RenderManager.getInstance().initialize();

    return true;
  }

  public onResolutionUpdated(): void {
    this.deferred.create(Render.width, Render.height);
    this.presentationBindGroup = null;
  }

  public async generateFrame(): Promise<void> {
    Render.getInstance().beginFrame();

    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();

    // Actualizar buffer uniforme global solo con view y projection
    this.updateGlobalUniforms(camera);
    RenderManager.getInstance().setCamera(camera);

    if (!mainCamera) {
      console.warn('No main camera found');
      return;
    }

    let result = await this.deferred.render(mainCamera);

    this.renderDistorsions(result);

    if (mainCamera?.hasComponent('tone_mapping')) {
      const toneMapping = mainCamera.getComponent('tone_mapping') as ToneMappingComponent;
      result = toneMapping.apply(result);
    }

    if (mainCamera?.hasComponent('antialiasing')) {
      const antialiasing = mainCamera.getComponent('antialiasing') as AntialiasingComponent;
      result = antialiasing.apply(result);
    }

    this.presentResult(result);

    Render.getInstance().endFrame();
  }
  public renderDistorsions(texture: GPUTextureView): void {
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(texture, 'load', 'store');
    const depthAttachment = GPUUtils.createDepthStencilAttachment(
      this.deferred.getDepthStencilView()!,
      'load',
      'discard'
    );

    const pass = render.getCommandEncoder().beginRenderPass(
      GPUUtils.createRenderPassDescriptor(
        'Distorsions Render pass',
        [colorAttachment],
        depthAttachment
      )
    );

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0,
      0, // Offset X,Y
      Render.width, // Width
      Render.height, // Height
      0.0,
      1.0, // Min/max depth
    );

    pass.setScissorRect(
      0,
      0, // Offset X,Y
      Render.width, // Width
      Render.height, // Height
    );

    RenderManager.getInstance().render(RenderCategory.DISTORSIONS, pass);

    pass.end();
  }
  private presentResult(result: GPUTextureView): void {
    const render = Render.getInstance();
    if (!this.presentationBindGroup) {
      const sampler = GPUUtils.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
      });

      this.presentationBindGroup = BindGroupFactory.createBindGroup(
        `presentation_bindgroup`,
        this.presentationTechnique.getPipeline().getBindGroupLayout(0),
        [
          {
            binding: 0,
            resource: result,
          },
          {
            binding: 1,
            resource: sampler,
          },
        ]
      );
    }
    const colorAttachment = GPUUtils.createColorAttachment(
      render.getContext().getCurrentTexture().createView(),
      'clear',
      'store',
      { r: 0, g: 0, b: 0, a: 1 }
    );

    const pass = render.getCommandEncoder().beginRenderPass(
      GPUUtils.createRenderPassDescriptor(
        'main presentation render pass',
        [colorAttachment]
      )
    );    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activar el pipeline
    this.presentationTechnique.activatePipeline(pass);

    // 2. Activar mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Activar bind groups
    pass.setBindGroup(0, this.presentationBindGroup);

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public stop(): void {
    throw new Error('Method not implemented.');
  }

  public update(dt: number): void {
    // Actualizar valores de debug
    const renderManager = RenderManager.getInstance();
    this.debugValues.drawCallsSolids.value = renderManager.getDrawCallsForCategory(
      RenderCategory.SOLIDS,
    );
    this.debugValues.drawCallsTransparent.value = renderManager.getDrawCallsForCategory(
      RenderCategory.TRANSPARENT,
    );
    this.debugValues.drawCallsDistorsions.value = renderManager.getDrawCallsForCategory(
      RenderCategory.DISTORSIONS,
    );
    this.debugValues.totalDrawCalls.value =
      this.debugValues.drawCallsSolids.value +
      this.debugValues.drawCallsTransparent.value +
      this.debugValues.drawCallsDistorsions.value;
    this.debugValues.resolution.value = `${Render.width}x${Render.height}`;

    this.deferred.update(dt);
  }

  public override renderInMenu(): void {
    if (this.debugControlsAdded) return;

    // Render Stats
    this.addDebugControl(
      this.debugValues.drawCallsSolids,
      'value',
      this.debugValues.drawCallsSolids.name,
    );
    this.addDebugControl(
      this.debugValues.drawCallsTransparent,
      'value',
      this.debugValues.drawCallsTransparent.name,
    );
    this.addDebugControl(
      this.debugValues.drawCallsDistorsions,
      'value',
      this.debugValues.drawCallsDistorsions.name,
    );
    this.addDebugControl(
      this.debugValues.totalDrawCalls,
      'value',
      this.debugValues.totalDrawCalls.name,
    );
    this.addDebugControl(this.debugValues.resolution, 'value', this.debugValues.resolution.name);

    this.debugControlsAdded = true;
  }

  public renderDebug(): void {
    throw new Error('Method not implemented.');
  }
  private initializeUniformBuffers(): void {
    // Crear buffer uniforme global para las matrices de la cámara
    this.globalUniformBuffer = GPUUtils.createBuffer(
      'global uniform buffer',
      256,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

    // Crear el bind group global usando la factory
    const globalBindGroupLayout = BindGroupFactory.getCameraUniformsLayout();
    this.globalBindGroup = BindGroupFactory.createBindGroup(
      'global uniform bind group',
      globalBindGroupLayout,
      [
        {
          binding: 0,
          resource: { buffer: this.globalUniformBuffer },
        },
      ],
    );
  }

  private async initializePresentationData(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');

    this.presentationTechnique = await Technique.get('presentation.tech');
  }
  public updateGlobalUniforms(camera: Camera): void {

    const viewMatrix = new Float32Array(camera.getView());
    const projectionMatrix = new Float32Array(camera.getProjection());
    const invViewProjectionMatrix = new Float32Array(camera.getInvViewProjectionMatrix());
    const cameraPosition = new Float32Array(camera.getPosition());    // viewMatrix (offset 0)
    GPUUtils.writeBuffer(this.globalUniformBuffer, 0, viewMatrix);

    // projectionMatrix (offset 64)
    GPUUtils.writeBuffer(this.globalUniformBuffer, 64, projectionMatrix);

    // invViewProjectionMatrix (offset 128)
    GPUUtils.writeBuffer(this.globalUniformBuffer, 128, invViewProjectionMatrix);

    // cameraPosition (offset 192)
    GPUUtils.writeBuffer(this.globalUniformBuffer, 192, cameraPosition);

    // screenSize (offset 208)
    GPUUtils.writeBuffer(
      this.globalUniformBuffer,
      208,
      new Float32Array([Render.width, Render.height]),
    );

    // cameraFront + cameraZFar (offset 224)
    GPUUtils.writeBuffer(
      this.globalUniformBuffer,
      224,
      new Float32Array([
        camera.getFront()[0],
        camera.getFront()[1],
        camera.getFront()[2],
        camera.getFar(),
      ]),
    );
  }

  public getGlobalBindGroup(): GPUBindGroup {
    if (!this.globalBindGroup) {
      throw new Error('Global bind group is not initialized');
    }
    return this.globalBindGroup;
  }
}
