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
import { AntialiasingComponent } from '../../components/render/AntialiasingComponent';
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
import { BloomComponent } from '../../components/render/BloomComponent';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { DeferredRenderer } from '../../renderer/core/pipeline/DeferredRenderer';
import { Render } from '../../renderer/core/pipeline/Render';
import { Camera } from '../../core/math/Camera';

export class ModuleRender extends Module {
  private deferred: DeferredRenderer;
  private lastBloomQualitySetting: string = ''; // Track bloom quality changes

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
  }

  public async start(): Promise<boolean> {
    await this.deferred.load();
    this.onResolutionUpdated();
    await this.initializePresentationData();

    // Initialize GPU Frustum Culling
    await RenderManager.getInstance().initialize();

    return true;
  }

  public onResolutionUpdated(): void {
    this.deferred.create(Render.width, Render.height);
    this.presentationBindGroup = null;
  }

  public generateFrame(): void {
    Render.getInstance().beginFrame();

    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();

    //Generate shadow maps if needed
    this.generateShadowMaps();

    // Actualizar buffer uniforme global solo con view y projection
    RenderManager.getInstance().setCamera(camera);

    if (!mainCamera) {
      console.warn('No main camera found');
      return;
    }

    this.mainCamera = camera;

    let result = this.deferred.render(mainCamera);

    if (mainCamera?.hasComponent('bloom')) {
      const bloom = mainCamera.getComponent('bloom') as BloomComponent;
      const qualitySettings = QualitySettings.getInstance();
      const bloomConfig = qualitySettings.getBloomConfig();

      if (bloomConfig.enabled) {
        // Apply quality-based bloom settings
        this.applyBloomQualitySettings(bloom);
        bloom.generateHighlights(this.deferred.getGBufferBindGroup(), result);
        bloom.addBloom(result);
      }
    }

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

  public generateShadowMaps(): void {
    this.deferred.generateShadowMaps();
  }

  public renderDistorsions(texture: GPUTextureView): void {
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(texture, 'load', 'store');
    const depthAttachment = GPUUtils.createDepthStencilAttachment(
      this.deferred.getDepthStencilView()!,
      'load',
      'discard',
    );
    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor(
          'Distorsions Render pass',
          [colorAttachment],
          depthAttachment,
        ),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);

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
      //result = this.deferred.directionalLight.shadowMap.getView();
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

    if (mainCamera.hasComponent('ambient_occlusion')) {
      const aoComponent = mainCamera.getComponent('ambient_occlusion') as AmbientOcclusionComponent;
      if (aoComponent && typeof aoComponent.renderInMenu === 'function') {
        aoComponent.renderInMenu();
      }
    }

    if (mainCamera.hasComponent('antialiasing')) {
      const antialiasingComponent = mainCamera.getComponent(
        'antialiasing',
      ) as AntialiasingComponent;
      if (antialiasingComponent && typeof antialiasingComponent.renderInMenu === 'function') {
        antialiasingComponent.renderInMenu();
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

  private async initializePresentationData(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');

    this.presentationTechnique = await Technique.get('presentation.tech');
  }

  public getMainCameraBindGroup(): GPUBindGroup {
    return this.mainCamera.getBindGroup();
  }

  private applyBloomQualitySettings(bloomComponent: BloomComponent): void {
    const qualitySettings = QualitySettings.getInstance();
    const bloomConfig = qualitySettings.getBloomConfig();
    const currentBloomQuality = qualitySettings.getSettings().bloomQuality;

    // Only apply settings if quality has changed or this is the first time
    if (this.lastBloomQualitySetting !== currentBloomQuality) {
      this.lastBloomQualitySetting = currentBloomQuality;

      if (!bloomConfig.enabled) {
        // Bloom disabled, skip processing
        return;
      }

      // Apply bloom parameters based on quality settings
      bloomComponent.setMaxBlurSteps(bloomConfig.maxBlurSteps);
      bloomComponent.setBlurStrength(bloomConfig.blurStrength);

      console.log(`Applied bloom quality settings: ${currentBloomQuality}`, bloomConfig);
    }
  }
}
