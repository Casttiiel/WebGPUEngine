import { CameraComponent } from '../../components/render/CameraComponent';
import { AmbientOcclusionComponent } from '../../components/render/AmbientOcclusionComponent';
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
import { AntialiasingComponent } from '../../components/render/AntialiasingComponent';
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
import { BloomComponent } from '../../components/render/BloomComponent';
import { QualitySettings } from '../../core/engine/QualitySettings';

export class ModuleRender extends Module {
  private deferred: DeferredRenderer;
  private debugControlsAdded: boolean = false;
  private lastBloomQualitySetting: string = ''; // Track bloom quality changes

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

    if (mainCamera?.hasComponent('bloom')) {
      const bloom = mainCamera.getComponent('bloom') as BloomComponent;
      const qualitySettings = QualitySettings.getInstance();
      const bloomConfig = qualitySettings.getBloomConfig();

      // Only process bloom if enabled in quality settings
      if (bloomConfig.enabled) {
        // Apply quality-based bloom settings
        this.applyBloomQualitySettings(bloom);
        result = bloom.generateHighlights(this.deferred.getGBufferBindGroup(), result);
        //result = bloom.addBloom(result);
      }
    }

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

    // Call renderInMenu for camera components
    this.renderCameraComponentsInMenu();
  }

  private renderCameraComponentsInMenu(): void {
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCamera) return;

    // Render ImGui controls for camera components
    if (mainCamera.hasComponent('ambient_occlusion')) {
      const aoComponent = mainCamera.getComponent('ambient_occlusion') as AmbientOcclusionComponent;
      if (aoComponent) {
        aoComponent.renderInMenu();
      }
    }

    // Add bloom quality controls
    this.renderBloomQualityControls();
  }

  private renderBloomQualityControls(): void {
    const qualitySettings = QualitySettings.getInstance();
    const currentSettings = qualitySettings.getSettings();
    const bloomConfig = qualitySettings.getBloomConfig();

    // Create a simple debug object for bloom quality
    const bloomDebugObj = {
      quality: currentSettings.bloomQuality,
      enabled: bloomConfig.enabled,
      maxBlurSteps: bloomConfig.maxBlurSteps,
      blurStrength: bloomConfig.blurStrength,
      bloomIntensity: bloomConfig.bloomIntensity,
      bloomThreshold: bloomConfig.bloomThreshold,
    };

    // Add controls for bloom parameters (read-only for now)
    this.addDebugControl(bloomDebugObj, 'quality', 'Bloom Quality');
    this.addDebugControl(bloomDebugObj, 'enabled', 'Bloom Enabled');
    this.addDebugControl(bloomDebugObj, 'maxBlurSteps', 'Bloom Blur Steps');
    this.addDebugControl(bloomDebugObj, 'blurStrength', 'Bloom Blur Strength');
    this.addDebugControl(bloomDebugObj, 'bloomIntensity', 'Bloom Intensity');
    this.addDebugControl(bloomDebugObj, 'bloomThreshold', 'Bloom Threshold');
  }

  public renderDebug(): void {
    throw new Error('Method not implemented.');
  }

  private initializeUniformBuffers(): void {
    // Crear buffer uniforme global para las matrices de la cámara
    this.globalUniformBuffer = GPUUtils.createBuffer(
      'global uniform buffer',
      256,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

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
    const cameraPosition = new Float32Array(camera.getPosition()); // viewMatrix (offset 0)
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
      bloomComponent.setBlendIntensity(bloomConfig.blendIntensity);
      bloomComponent.setBloomIntensity(bloomConfig.bloomIntensity);
      bloomComponent.setBloomThreshold(bloomConfig.bloomThreshold);
      bloomComponent.setBloomRadius(bloomConfig.bloomRadius);
      bloomComponent.setBloomKnee(bloomConfig.bloomKnee);

      console.log(`Applied bloom quality settings: ${currentBloomQuality}`, bloomConfig);
    }
  }

  // Public methods for controlling bloom quality
  public setBloomQuality(quality: 'off' | 'low' | 'medium' | 'high'): void {
    const qualitySettings = QualitySettings.getInstance();
    qualitySettings.updateSettings({ bloomQuality: quality });

    // Force re-application of bloom settings
    this.lastBloomQualitySetting = '';

    console.log(`Bloom quality changed to: ${quality}`);
  }

  public getBloomQuality(): string {
    const qualitySettings = QualitySettings.getInstance();
    return qualitySettings.getSettings().bloomQuality;
  }

  public getCurrentBloomConfig() {
    const qualitySettings = QualitySettings.getInstance();
    return qualitySettings.getBloomConfig();
  }
}
