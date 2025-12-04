import { CameraComponent } from '../../components/render/CameraComponent';
import { AmbientOcclusionComponent } from '../../components/render/AmbientOcclusionComponent';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Module } from '../core/Module';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
import { BloomComponent } from '../../components/render/BloomComponent';
import { DeferredRenderer } from '../../renderer/core/pipeline/DeferredRenderer';
import { Render } from '../../renderer/core/pipeline/Render';
import { Camera } from '../../core/math/Camera';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Distorsions } from '../../renderer/shading/Distorsions';
import { DepthOfFieldComponent } from '../../components/render/DepthOfFieldComponent';
import { MotionBlurComponent } from '../../components/render/MotionBlurComponent';
import { FXAAComponent } from '../../components/render/FXAAComponent';
import { SMAAComponent } from '../../components/render/SMAAComponent';
import { VelocityBufferManager } from '../../renderer/core/managers/VelocityBufferManager';
import { SMAAT2xComponent } from '../../components/render/SMAAT2xComponent';

export class ModuleRender extends Module {
  private deferred: DeferredRenderer;
  private distorsions!: Distorsions;

  //Presentation data
  private presentationTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private presentationBindGroup!: GPUBindGroup | null;
  private mainCamera!: Camera;

  // Debug values para Tweakpane
  private debugValues = {
    drawCallsSolids: { name: 'Draw Calls (Solids)', value: 0 },
    drawCallsTransparent: { name: 'Draw Calls (Transparent)', value: 0 },
    drawCallsDistorsions: { name: 'Draw Calls (Distorsions)', value: 0 },
    drawCallsDecals: { name: 'Draw Calls (Decals)', value: 0 },
    totalDrawCalls: { name: 'Total Draw Calls', value: 0 },
    resolution: { name: 'Resolution', value: '0x0' },
  };

  constructor(name: string) {
    super(name);
    this.deferred = new DeferredRenderer();
    this.distorsions = new Distorsions();
  }

  public async start(): Promise<boolean> {
    await this.deferred.load();
    await this.distorsions.load();
    this.onResolutionUpdated();
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.presentationTechnique = await Technique.getAsync('presentation.tech');

    // Initialize GPU Frustum Culling
    await RenderManager.getInstance().initialize();

    // Inicializar VelocityBufferManager
    await VelocityBufferManager.getInstance().initialize(Render.width, Render.height);

    return true;
  }

  public onResolutionUpdated(): void {
    this.deferred.create(Render.width, Render.height);
    this.distorsions.resize();
    this.presentationBindGroup = null;

    // Redimensionar VelocityBufferManager
    VelocityBufferManager.getInstance().resize(Render.width, Render.height);

    const mainCameraEntity = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCameraEntity) {
      console.warn('No main camera found');
      return;
    }
    const cameraComponent = mainCameraEntity.getComponent('camera') as CameraComponent;
    if (cameraComponent) {
      cameraComponent.getCamera().setViewport(Render.width, Render.height);
    }

    for (const comp of Engine.getEntities().getObjectManagerByName('tone_mapping')?.getList() ??
      []) {
      (comp as ToneMappingComponent).resize();
    }
    for (const comp of Engine.getEntities().getObjectManagerByName('fxaa')?.getList() ?? []) {
      (comp as FXAAComponent).resize();
    }
    for (const comp of Engine.getEntities().getObjectManagerByName('smaa')?.getList() ?? []) {
      (comp as SMAAComponent).resize();
    }
    for (const comp of Engine.getEntities()
      .getObjectManagerByName('ambient_occlusion')
      ?.getList() ?? []) {
      (comp as AmbientOcclusionComponent).resize();
    }

    for (const comp of Engine.getEntities().getObjectManagerByName('bloom')?.getList() ?? []) {
      (comp as BloomComponent).resize();
    }

    for (const comp of Engine.getEntities().getObjectManagerByName('depth_of_field')?.getList() ??
      []) {
      (comp as DepthOfFieldComponent).resize();
    }

    for (const comp of Engine.getEntities().getObjectManagerByName('motion_blur')?.getList() ??
      []) {
      (comp as MotionBlurComponent).resize();
    }

    for (const comp of Engine.getEntities()
      .getObjectManagerByName('ambient_occlusion')
      ?.getList() ?? []) {
      (comp as AmbientOcclusionComponent).resize();
    }
  }

  public generateFrame(): void {
    const mainCameraEntity = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCameraEntity) {
      return;
    }
    const cameraComponent = mainCameraEntity.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();

    // Enable camera jittering if temporal AA components are present
    const needsJitter = mainCameraEntity.hasComponent('smaa_t2x');

    if (needsJitter && !camera.isJitterEnabled()) {
      camera.enableJitter();
    } else if (!needsJitter && camera.isJitterEnabled()) {
      camera.disableJitter();
    }

    // Advance to next jitter offset if jittering is active
    if (needsJitter) {
      camera.nextJitter();
    }

    Render.getInstance().beginFrame();

    this.deferred.generateShadowMaps();
    RenderManager.getInstance().performCulling(camera);

    RenderManager.getInstance().setCamera(camera);

    this.mainCamera = camera;

    let result = this.deferred.render(mainCameraEntity);

    // Enable velocity buffer if any component needs it
    const velocityMgr = VelocityBufferManager.getInstance();
    const needsVelocity = mainCameraEntity.hasComponent('smaa_t2x');
    velocityMgr.setEnabled(needsVelocity);
    // Generar velocity buffer si está activo
    if (velocityMgr.isEnabled()) {
      velocityMgr.generate(camera, this.deferred.getGBufferBindGroup());
    }

    if (mainCameraEntity.hasComponent('bloom')) {
      const bloom = mainCameraEntity.getComponent('bloom') as BloomComponent;
      const enableBloom = QualitySettings.getInstance().getSettings().enableBloom;

      if (enableBloom && bloom.hasLoaded()) {
        result = bloom.apply(result, this.deferred.getGBufferBindGroup());
      }
    }

    if (mainCameraEntity.hasComponent('motion_blur')) {
      const motionBlur = mainCameraEntity.getComponent('motion_blur') as MotionBlurComponent;
      const enableMotionBlur = QualitySettings.getInstance().getSettings().enableMotionBlur;

      if (enableMotionBlur && motionBlur.hasLoaded()) {
        result = motionBlur.apply(result, this.deferred.getGBufferBindGroup());
      }
    }

    this.distorsions.render(result, this.deferred.getDepthStencilView()!);

    if (mainCameraEntity.hasComponent('depth_of_field')) {
      const depthOfField = mainCameraEntity.getComponent('depth_of_field') as DepthOfFieldComponent;
      if (depthOfField.hasLoaded()) {
        result = depthOfField.apply(result, this.deferred.getGBufferBindGroup());
      }
    }

    if (mainCameraEntity.hasComponent('tone_mapping')) {
      const toneMapping = mainCameraEntity.getComponent('tone_mapping') as ToneMappingComponent;
      if (toneMapping.hasLoaded()) {
        result = toneMapping.apply(result);
      }
    }

    if (mainCameraEntity.hasComponent('fxaa')) {
      const antialiasing = mainCameraEntity.getComponent('fxaa') as FXAAComponent;
      if (antialiasing.hasLoaded()) {
        result = antialiasing.apply(result);
      }
    }

    if (mainCameraEntity.hasComponent('smaa')) {
      const antialiasing = mainCameraEntity.getComponent('smaa') as SMAAComponent;
      if (antialiasing.hasLoaded()) {
        result = antialiasing.apply(result);
      }
    }

    if (mainCameraEntity.hasComponent('smaa_t2x')) {
      const antialiasing = mainCameraEntity.getComponent('smaa_t2x') as SMAAT2xComponent;
      if (antialiasing.hasLoaded()) {
        result = antialiasing.apply(result);
      }
    }

    this.presentResult(result);

    Render.getInstance().endFrame();
  }

  private presentResult(result: GPUTextureView): void {
    const render = Render.getInstance();
    if (!this.presentationBindGroup) {
      const sampler = SamplerLibrary.simpleSampler;

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
        ],
      );
    }
    const colorAttachment = GPUUtils.createColorAttachment(
      render.getContext().getCurrentTexture().createView(),
      'clear',
      'store',
      { r: 0, g: 0, b: 0, a: 1 },
    );
    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor('main presentation render pass', [colorAttachment]),
      );

    // Configure viewport and scissor for presentation (use full canvas size)
    const canvasSize = Render.canvasSize;
    GPUUtils.configureViewportAndScissor(pass, canvasSize.width, canvasSize.height);

    // 1. Activate pipeline
    this.presentationTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, this.presentationBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public stop(): void {
    console.log('Stopping ModuleRender...');

    try {
      // Clean up deferred renderer first
      if (this.deferred) {
        this.deferred.destroy();
        this.deferred = null as any;
      }

      if (this.distorsions) {
        this.distorsions.destroy();
        this.distorsions = null as any;
      }

      this.presentationBindGroup = null;

      RenderManager.getInstance().destroy();

      console.log('ModuleRender stopped and resources cleaned up.');
    } catch (error) {
      console.error('Error stopping ModuleRender:', error);
    }
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
    this.debugValues.drawCallsDecals.value = renderManager.getDrawCallsForCategory(
      RenderCategory.DECALS,
    );
    this.debugValues.totalDrawCalls.value =
      this.debugValues.drawCallsSolids.value +
      this.debugValues.drawCallsTransparent.value +
      this.debugValues.drawCallsDistorsions.value +
      this.debugValues.drawCallsDecals.value;
    this.debugValues.resolution.value = `${Render.width}x${Render.height}`;

    this.deferred.update(dt);
  }

  public override renderInMenu(): void {
    // Render Stats - llamados en cada frame para mantener los valores actualizados
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
      this.debugValues.drawCallsDecals,
      'value',
      this.debugValues.drawCallsDecals.name,
    );
    this.addDebugControl(
      this.debugValues.totalDrawCalls,
      'value',
      this.debugValues.totalDrawCalls.name,
    );
    this.addDebugControl(this.debugValues.resolution, 'value', this.debugValues.resolution.name);

    // Get main camera same way as in generateFrame()
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    if (mainCamera) {
      this.renderCameraComponentsInMenu(mainCamera);
    }
  }

  private renderCameraComponentsInMenu(mainCamera: Entity): void {
    const debugUI = Engine.getDebugUI();

    // Create a subfolder for camera components within the Render module
    const renderFolderName = this.getName(); // "render"
    const cameraSubfolderName = 'Camera Components';

    debugUI.addSubFolder(renderFolderName, cameraSubfolderName, 'Camera Components', true);

    // Render each component in its own subfolder

    if (mainCamera.hasComponent('smaa')) {
      const aoComponent = mainCamera.getComponent('smaa') as SMAAComponent;
      if (aoComponent && typeof aoComponent.renderInMenu === 'function') {
        aoComponent.renderInMenu();
      }
    }

    if (mainCamera.hasComponent('ambient_occlusion')) {
      const aoComponent = mainCamera.getComponent('ambient_occlusion') as AmbientOcclusionComponent;
      if (aoComponent && typeof aoComponent.renderInMenu === 'function') {
        aoComponent.renderInMenu();
      }
    }

    if (mainCamera.hasComponent('fxaa')) {
      const fxaaComponent = mainCamera.getComponent('fxaa') as FXAAComponent;
      if (fxaaComponent && typeof fxaaComponent.renderInMenu === 'function') {
        fxaaComponent.renderInMenu();
      }
    }

    if (mainCamera.hasComponent('tone_mapping')) {
      const toneMappingComponent = mainCamera.getComponent('tone_mapping') as ToneMappingComponent;
      if (toneMappingComponent && typeof toneMappingComponent.renderInMenu === 'function') {
        toneMappingComponent.renderInMenu();
      }
    }

    if (mainCamera.hasComponent('bloom')) {
      const bloomComponent = mainCamera.getComponent('bloom') as BloomComponent;
      if (bloomComponent && typeof bloomComponent.renderInMenu === 'function') {
        bloomComponent.renderInMenu();
      }
    }
  }

  public renderDebug(): void {
    throw new Error('Method not implemented.');
  }

  public getMainCameraBindGroup(): GPUBindGroup {
    return this.mainCamera.getBindGroup();
  }

  public getMainCamera(): Camera {
    return this.mainCamera;
  }
}
