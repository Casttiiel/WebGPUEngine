import { CameraComponent } from '../../components/render/CameraComponent';
import { AmbientOcclusionComponent } from '../../components/render/AmbientOcclusionComponent';
import { Engine } from '../../core/engine/Engine';
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
import { SpeedLinesVFXComponent } from '../../components/vfx/SpeedLinesVFXComponent';
import { HeightFogComponent } from '../../components/vfx/HeightFogComponent';
import { LoadingStatus } from '../../core/engine/LoadingStatus';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';
import { UIRenderUtils } from '../../renderer/core/UIRenderUtils';
import { ModuleUI } from './ModuleUI';

export class ModuleRender extends Module {
  private deferred: DeferredRenderer;
  private distorsions!: Distorsions;
  public pauseRendering: boolean = false; // Flag para pausar rendering durante probe capture

  //Presentation data
  private presentationTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private presentationBindGroup!: GPUBindGroup | null;
  private mainCamera!: Camera;
  private defaultCamera!: Camera; // Cámara por defecto cuando no hay MainCamera

  // Black texture for UI-only rendering (when no 3D camera exists)
  private blackTexture!: GPUTexture;
  private blackTextureView!: GPUTextureView;

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
    LoadingStatus.updateStatus('Initializing deferred renderer...', 45);
    await this.deferred.load();

    LoadingStatus.updateStatus('Loading distortion system...', 50);
    await this.distorsions.load();

    this.onResolutionUpdated();

    LoadingStatus.updateStatus('Loading presentation resources...', 55);
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.presentationTechnique = await Technique.getAsync('utility/presentation.tech');

    LoadingStatus.updateStatus('Initializing render manager...', 60);
    // Initialize GPU Frustum Culling
    await RenderManager.getInstance().initialize();

    // Initialize UI rendering system
    LoadingStatus.updateStatus('Initializing UI renderer...', 65);
    await UIRenderUtils.initialize();

    // Initialize UI screen dimensions immediately after UIRenderUtils
    const canvas = Render.getInstance().getCanvas();
    const physicalWidth = canvas.width;
    const physicalHeight = canvas.height;
    const dpr = window.devicePixelRatio || 1;

    UIRenderUtils.updateScreenSize(physicalWidth, physicalHeight, dpr);

    // Inicializar VelocityBufferManager
    await VelocityBufferManager.getInstance().initialize(Render.width, Render.height);

    // Create default camera for UI-only rendering (when no 3D scene camera exists)
    this.defaultCamera = new Camera();
    this.defaultCamera.setViewport(Render.width, Render.height);
    this.mainCamera = this.defaultCamera;

    // Create black texture for UI-only rendering mode
    this.createBlackTextureResource();

    return true;
  }

  /**
   * Create a black texture for UI-only rendering (when no 3D camera)
   */
  private createBlackTextureResource(): void {
    const device = GPUUtils.getDevice();
    const format = QualitySettings.getInstance().getSettings().hdrTexture;

    this.blackTexture = device.createTexture({
      label: 'black_texture_ui_only',
      size: [Render.width, Render.height, 1],
      format: format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.blackTextureView = this.blackTexture.createView({
      label: 'black_texture_view',
    });

    // Clear texture to black once
    const encoder = device.createCommandEncoder({ label: 'clear_black_texture' });
    const pass = encoder.beginRenderPass({
      label: 'clear_black_pass',
      colorAttachments: [
        {
          view: this.blackTextureView,
          loadOp: 'clear',
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          storeOp: 'store',
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Get black texture view for UI-only rendering
   */
  private createBlackTexture(): GPUTextureView {
    return this.blackTextureView;
  }

  public onResolutionUpdated(): void {
    this.deferred.create(Render.width, Render.height);
    this.distorsions.resize();
    this.presentationBindGroup = null;

    // Recreate black texture with new resolution
    if (this.blackTexture) {
      this.blackTexture.destroy();
    }
    this.createBlackTextureResource();

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

    for (const comp of Engine.getEntities().getObjectManagerByName('height_fog')?.getList() ?? []) {
      (comp as HeightFogComponent).resize();
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
    // ⏸️ Salir temprano si el rendering está pausado (e.g., capturando probes)
    if (this.pauseRendering) {
      return;
    }

    const mainCameraEntity = Engine.getEntities().getEntityByName('MainCamera');

    Render.getInstance().beginFrame();

    let result: GPUTextureView;

    // Si no hay MainCamera, usar textura negra en vez de intentar render 3D
    if (!mainCameraEntity) {
      result = this.createBlackTexture();
    } else {
      // Render 3D normal con cámara
      const cameraComponent = mainCameraEntity.getComponent('camera') as CameraComponent;
      const camera = cameraComponent.getCamera();
      camera.setViewport(Render.width, Render.height);
      this.mainCamera = camera;

      // Enable camera jittering if temporal AA components are present
      const needsJitter = mainCameraEntity?.hasComponent('smaa_t2x');

      if (needsJitter && !camera.isJitterEnabled()) {
        camera.enableJitter();
      } else if (!needsJitter && camera.isJitterEnabled()) {
        camera.disableJitter();
      }

      // Advance to next jitter offset if jittering is active
      if (needsJitter) {
        camera.nextJitter();
      }

      RenderManager.getInstance().performCulling(camera);
      RenderManager.getInstance().performLightCulling(camera);
      this.deferred.generateShadowMaps();

      RenderManager.getInstance().setCamera(camera);

      result = this.deferred.render(mainCameraEntity);
    }

    // Post-processing solo si hay MainCamera
    if (mainCameraEntity) {
      // Enable velocity buffer if any component needs it
      const velocityMgr = VelocityBufferManager.getInstance();
      const needsVelocity = mainCameraEntity?.hasComponent('smaa_t2x');
      velocityMgr.setEnabled(needsVelocity);
      // Generar velocity buffer si está activo
      if (velocityMgr.isEnabled()) {
        velocityMgr.generate(this.mainCamera, this.deferred.getGBufferBindGroup());
      }

      if (mainCameraEntity?.hasComponent('height_fog')) {
        const heightFog = mainCameraEntity.getComponent('height_fog') as HeightFogComponent;
        if (heightFog && heightFog.hasLoaded()) {
          result = heightFog.apply(result, this.deferred.getGBufferBindGroup());
        }
      }

      if (mainCameraEntity?.hasComponent('bloom')) {
        const bloom = mainCameraEntity.getComponent('bloom') as BloomComponent;
        const enableBloom = QualitySettings.getInstance().getSettings().enableBloom;

        if (enableBloom && bloom.hasLoaded()) {
          result = bloom.apply(result, this.deferred.getGBufferBindGroup());
        }
      }

      if (mainCameraEntity?.hasComponent('motion_blur')) {
        const motionBlur = mainCameraEntity.getComponent('motion_blur') as MotionBlurComponent;
        const enableMotionBlur = QualitySettings.getInstance().getSettings().enableMotionBlur;

        if (enableMotionBlur && motionBlur.hasLoaded()) {
          result = motionBlur.apply(result, this.deferred.getGBufferBindGroup());
        }
      }

      this.distorsions.render(result, this.deferred.getDepthStencilView()!);

      if (mainCameraEntity?.hasComponent('depth_of_field')) {
        const depthOfField = mainCameraEntity.getComponent(
          'depth_of_field',
        ) as DepthOfFieldComponent;
        if (depthOfField.hasLoaded()) {
          result = depthOfField.apply(result, this.deferred.getGBufferBindGroup());
        }
      }

      if (mainCameraEntity?.hasComponent('tone_mapping')) {
        const toneMapping = mainCameraEntity.getComponent('tone_mapping') as ToneMappingComponent;
        if (toneMapping.hasLoaded()) {
          result = toneMapping.apply(result);
        }
      }

      if (mainCameraEntity?.hasComponent('fxaa')) {
        const antialiasing = mainCameraEntity.getComponent('fxaa') as FXAAComponent;
        if (antialiasing.hasLoaded()) {
          result = antialiasing.apply(result);
        }
      }

      if (mainCameraEntity?.hasComponent('smaa')) {
        const antialiasing = mainCameraEntity.getComponent('smaa') as SMAAComponent;
        if (antialiasing.hasLoaded()) {
          result = antialiasing.apply(result);
        }
      }

      if (mainCameraEntity?.hasComponent('speed_lines_vfx')) {
        const speedLines = mainCameraEntity.getComponent(
          'speed_lines_vfx',
        ) as SpeedLinesVFXComponent;
        if (speedLines.hasLoaded()) {
          speedLines.apply(result);
        }
      }
    }

    // Render UI overlay on top of result texture
    this.renderUIOnTexture(result);

    // Present final result to screen
    this.presentResult(result);

    Render.getInstance().endFrame();
  }

  /**
   * Render UI overlay directly on top of result texture
   */
  private renderUIOnTexture(resultView: GPUTextureView): void {
    const moduleUI = ModuleUI.getInstance();
    if (!moduleUI) {
      return; // No UI module
    }

    const render = Render.getInstance();
    const device = render.getDevice();
    const encoder = device.createCommandEncoder({ label: 'ui_overlay_encoder' });
    const renderPass = encoder.beginRenderPass({
      label: 'ui_overlay_pass',
      colorAttachments: [
        {
          view: resultView,
          loadOp: 'load', // Load existing scene content
          storeOp: 'store',
        },
      ],
    });

    // Set viewport to physical pixels (GPU renders at physical resolution)
    const canvas = render.getCanvas();
    const physicalWidth = canvas.width;
    const physicalHeight = canvas.height;

    // Configure viewport and scissor for UI rendering
    renderPass.setViewport(0, 0, physicalWidth, physicalHeight, 0.0, 1.0);
    renderPass.setScissorRect(0, 0, physicalWidth, physicalHeight);

    // Render all active UI widgets
    moduleUI.render(renderPass);

    renderPass.end();
    render.getDevice().queue.submit([encoder.finish()]);
  }

  private presentResult(sceneResult: GPUTextureView): void {
    const render = Render.getInstance();

    // Create bind group for scene presentation
    if (!this.presentationBindGroup) {
      const sampler = SamplerLibrary.simpleSampler;

      this.presentationBindGroup = BindGroupFactory.createBindGroup(
        `presentation_bindgroup`,
        this.presentationTechnique.getPipeline().getBindGroupLayout(0),
        [
          {
            binding: 0,
            resource: sceneResult,
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

    // Render result to screen
    this.presentationTechnique.activatePipeline(pass);
    this.fullscreenQuadMesh.activate(pass);
    pass.setBindGroup(0, this.presentationBindGroup);
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public stop(): void {
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

      // Clean up black texture for UI-only rendering
      if (this.blackTexture) {
        this.blackTexture.destroy();
        this.blackTexture = null as any;
        this.blackTextureView = null as any;
      }

      // Clean up UI rendering resources
      UIRenderUtils.destroy();

      RenderManager.getInstance().destroy();
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
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    // Directional Lights section - each light gets its own window
    const directionalLights = Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList();

    if (directionalLights && directionalLights.length > 0) {
      for (const light of directionalLights) {
        const dirLight = light as DirectionalLightComponent;
        const lightName = dirLight.getOwner().getName();

        if (this.beginGUIWindow(lightName)) {
          dirLight.renderInMenu();
          this.endGUIWindow();
        }
      }
    }

    this.deferred.renderInMenu();

    // Create main window for render stats
    if (this.beginGUIWindow('Render Statistics')) {
      // Add dynamic text displays that auto-update
      gui.addDynamicText(this.debugValues.drawCallsSolids, 'value', 'Draw Calls (Solids)');
      gui.addDynamicText(
        this.debugValues.drawCallsTransparent,
        'value',
        'Draw Calls (Transparent)',
      );
      gui.addDynamicText(
        this.debugValues.drawCallsDistorsions,
        'value',
        'Draw Calls (Distortions)',
      );
      gui.addDynamicText(this.debugValues.drawCallsDecals, 'value', 'Draw Calls (Decals)');
      this.addGUISeparator();
      gui.addDynamicText(this.debugValues.totalDrawCalls, 'value', 'Total Draw Calls');
      gui.addDynamicText(this.debugValues.resolution, 'value', 'Resolution');
      this.endGUIWindow();
    }

    // Get main camera for post-processing components
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    if (mainCamera && this.beginGUIWindow('Post-Processing')) {
      // Render post-processing component controls
      this.endGUIWindow();
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

  public getDeferredRenderer(): DeferredRenderer {
    return this.deferred;
  }

  private originalMainCamera: Camera | null = null;
  public setTemporaryMainCamera(camera: Camera): void {
    if (!this.originalMainCamera) {
      this.originalMainCamera = this.mainCamera;
    }
    this.mainCamera = camera;
  }

  public restoreMainCamera(): void {
    if (this.originalMainCamera) {
      this.mainCamera = this.originalMainCamera;
      this.originalMainCamera = null;
    }
  }
}
