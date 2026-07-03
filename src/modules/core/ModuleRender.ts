import { CameraComponent } from '../../components/render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { Msg } from '../../core/ecs/Msg';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Module } from '../core/Module';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
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
import { SMAAT2xComponent } from '../../components/render/SMAAT2xComponent';
import { TAAComponent } from '../../components/render/TAAComponent';
import { TSRComponent } from '../../components/render/TSRComponent';
import { VelocityBufferManager } from '../../renderer/core/managers/VelocityBufferManager';
import { SpeedLinesVFXComponent } from '../../components/vfx/SpeedLinesVFXComponent';
import { HeightFogComponent } from '../../components/vfx/HeightFogComponent';
import { AtmosphericFogComponent } from '../../components/vfx/AtmosphericFogComponent';
import { LoadingStatus } from '../../core/engine/LoadingStatus';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';
import { UIRenderUtils } from '../../renderer/core/UIRenderUtils';
import { ModuleUI } from './ModuleUI';
import { BloomComponent } from '../../components/render/BloomComponent';
import { AutoExposureComponent } from '../../components/render/AutoExposureComponent';
import { FSRComponent } from '../../components/render/FSRComponent';
import { PaletteQuantizeComponent } from '../../components/render/PaletteQuantizeComponent';
import { GodRaysComponent } from '../../components/render/GodRaysComponent';
import { FogScatterComponent } from '../../components/render/FogScatterComponent';
import { LensFlareComponent } from '../../components/render/LensFlareComponent';
import { ChromaticAberrationComponent } from '../../components/render/ChromaticAberrationComponent';
import { FilmGrainComponent } from '../../components/render/FilmGrainComponent';
import { VignetteComponent } from '../../components/render/VignetteComponent';
import { PointLightComponent } from '../../components/render/PointLightComponent';
import { SpotLightComponent } from '../../components/render/SpotLightComponent';
import { ShockwavePostProcessComponent } from '../../components/render/ShockwavePostProcessComponent';
import { Profiler } from '../../core/debug/Profiler';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { TextureStreamingManager } from '../../renderer/core/managers/TextureStreamingManager';
import { PhysicsDebugDrawer } from '../../renderer/debug/PhysicsDebugDrawer';

export class ModuleRender extends Module {
  private deferred: DeferredRenderer;
  private distorsions!: Distorsions;
  public pauseRendering: boolean = false; // Flag para pausar rendering durante probe capture
  private lastDt: number = 1 / 60; // Cached delta time from update(), used in generateFrame()

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
    drawCallsSolids: { name: 'Draw Cmds (Solids)', value: 0 },
    drawCallsTransparent: { name: 'Draw Cmds (Transparent)', value: 0 },
    drawCallsGlass: { name: 'Draw Cmds (Glass)', value: 0 },
    drawCallsDistorsions: { name: 'Draw Cmds (Distorsions)', value: 0 },
    drawCallsDecals: { name: 'Draw Cmds (Decals)', value: 0 },
    totalDrawCalls: { name: 'Total Draw Cmds', value: 0 },
    gpuCullingKeys: { name: 'GPU Managed Keys', value: '0 / 0' },
    gpuEstimatedVisible: { name: 'Est. Visible (CPU)', value: '0 / 0' },
    hzbCulled: { name: 'HZB Culled', value: '0 objs' },
    visiblePointLights: { name: 'Point Lights (visible)', value: 0 },
    visibleSpotLights: { name: 'Spot Lights (visible)', value: 0 },
    resolution: { name: 'Resolution', value: '0x0' },
    canvasResolution: { name: 'Canvas Resolution', value: '0x0' },
  };

  // Profiler display values (updated every frame in update())
  private readonly profilerCPU = {
    Entities: { value: '0.00 ms' },
    Shadows: { value: '0.00 ms' },
    Deferred: { value: '0.00 ms' },
    'Post-Process': { value: '0.00 ms' },
  };

  private readonly profilerGPU: Record<string, { value: string }> = {
    // Shadows
    'Directional Shadow': { value: '-' },
    'Point Shadow': { value: '-' },
    'Spot Shadow': { value: '-' },
    // Lighting
    'Directional Light': { value: '-' },
    'Ambient Diffuse': { value: '-' },
    'Ambient Specular': { value: '-' },
    Skybox: { value: '-' },
    // G-Buffer & Geometry
    'Depth Prepass': { value: '-' },
    'G-Buffer Pass': { value: '-' },
    'Decal Pass': { value: '-' },
    'Transparent Pass': { value: '-' },
    'OIT Gather Pass': { value: '-' },
    'OIT Compose Pass': { value: '-' },
    // Lights (deferred)
    'Point Lights Render Pass': { value: '-' },
    'Point Lights with Shadows': { value: '-' },
    'Spot Lights Render Pass': { value: '-' },
    'Spot Lights with Shadows': { value: '-' },
    // Compute effects
    'GTAO Compute': { value: '-' },
    'AO Bilateral Horizontal': { value: '-' },
    'AO Bilateral Vertical': { value: '-' },
    'SSR Compute': { value: '-' },
    'SSR Blur': { value: '-' },
    hzb_build_copy: { value: '-' },
    // Auto Exposure
    'AE Luminance': { value: '-' },
    'AE Adapt': { value: '-' },
    // Volumetrics
    froxel_density_compute: { value: '-' },
    froxel_directional_light_injection_compute: { value: '-' },
    froxel_point_light_injection_compute: { value: '-' },
    froxel_spot_light_injection_compute: { value: '-' },
    froxel_volumetrict_integration_compute: { value: '-' },
    froxel_volumetrics_render: { value: '-' },
    // Post Process
    'Post Process Pass': { value: '-' },
    'Bloom Combine Pass': { value: '-' },
    'DOF Pass': { value: '-' },
  };

  private readonly profilerMeta = {
    gpuSupported: { value: 'checking…' },
  };

  constructor(name: string) {
    super(name);
    this.deferred = new DeferredRenderer();
    this.distorsions = new Distorsions();
  }

  public async start(): Promise<boolean> {
    // 1. Deferred renderer first — sets up GBuffer that everything else depends on
    LoadingStatus.updateStatus('Initializing deferred renderer...', 45);
    await this.deferred.load();

    this.onResolutionUpdated();

    await PhysicsDebugDrawer.getInstance().initialize();

    // 2. Everything independent of each other → parallel
    LoadingStatus.updateStatus('Loading render resources...', 50);
    [this.fullscreenQuadMesh, this.presentationTechnique] = (await Promise.all([
      Mesh.getAsync('fullscreenquad.obj'),
      Technique.getAsync('utility/presentation.tech'),
      this.distorsions.load(),
      RenderManager.getInstance().initialize(),
    ])) as [Mesh, Technique, void, void];

    // 3. UI + velocity buffer are independent of each other → parallel
    LoadingStatus.updateStatus('Initializing UI renderer...', 60);
    await Promise.all([
      UIRenderUtils.initialize(),
      VelocityBufferManager.getInstance().initialize(Render.width, Render.height),
    ]);

    // Register HZB pyramid builder with the render manager.
    // Both systems are fully initialized at this point: deferred renderer built
    // the HZBBuilder pipelines and resources in load()/create(), and
    // RenderManager initialized HZBCullingPass in initialize().
    RenderManager.getInstance().setHZBBuilder(this.deferred.getHZBBuilder());

    // Initialize UI screen dimensions immediately after UIRenderUtils
    const canvas = Render.getInstance().getCanvas();
    const physicalWidth = canvas.width;
    const physicalHeight = canvas.height;
    const dpr = window.devicePixelRatio || 1;

    UIRenderUtils.updateScreenSize(physicalWidth, physicalHeight, dpr);

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
      return;
    }
    const cameraComponent = mainCameraEntity.getComponent('camera') as CameraComponent;
    if (cameraComponent) {
      cameraComponent.getCamera().setViewport(Render.width, Render.height);
    }

    // Notificar a todos los componentes suscritos a RESIZE
    const allEntities = Engine.getEntities().getAllEntities();
    MsgDispatcher.broadcast(
      allEntities,
      Msg.resize({ width: Render.width, height: Render.height }),
    );
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
      const needsJitter =
        mainCameraEntity?.hasComponent('smaa_t2x') ||
        mainCameraEntity?.hasComponent('taa') ||
        mainCameraEntity?.hasComponent('tsr');

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

      // Evaluate camera–object distances and stream in full-res mips for nearby textures.
      TextureStreamingManager.getInstance().update(camera.getPosition());

      Profiler.getInstance().cpu.begin('Shadows');
      this.deferred.generateShadowMaps();
      Profiler.getInstance().cpu.end();

      RenderManager.getInstance().setCamera(camera);

      // Inform SSR whether a temporal component is active so it can halve its step count.
      // TAA/TSR accumulate SSR hits across frames, giving equivalent quality at half steps.
      const taaActive =
        (mainCameraEntity?.hasComponent('taa') &&
          (mainCameraEntity.getComponent('taa') as TAAComponent).hasLoaded()) ??
        false;
      const tsrActive =
        (mainCameraEntity?.hasComponent('tsr') &&
          (mainCameraEntity.getComponent('tsr') as TSRComponent).hasLoaded()) ??
        false;
      this.deferred.setSSRTemporalMode(!!(taaActive || tsrActive));

      Profiler.getInstance().cpu.begin('Deferred');
      result = this.deferred.render(mainCameraEntity);
      Profiler.getInstance().cpu.end();
    }

    // Post-processing solo si hay MainCamera
    if (mainCameraEntity) {
      Profiler.getInstance().cpu.begin('Post-Process');
      // Enable velocity buffer if any component needs it
      const velocityMgr = VelocityBufferManager.getInstance();
      const needsVelocity =
        mainCameraEntity?.hasComponent('smaa_t2x') ||
        mainCameraEntity?.hasComponent('taa') ||
        mainCameraEntity?.hasComponent('tsr');
      velocityMgr.setEnabled(needsVelocity);
      // Generar velocity buffer si está activo
      if (velocityMgr.isEnabled()) {
        velocityMgr.generate(this.mainCamera, this.deferred.getGBufferBindGroup());
        // Per-object pass: overwrites velocity for dynamic (moving) objects so that
        // TAA reprojects history correctly instead of ghosting on moving geometry.
        const depthView = this.deferred.getDepthStencilView();
        if (depthView) {
          velocityMgr.generatePerObject(this.mainCamera.getCulledKeys(), depthView);
          // Skinned pass: uses current + previous bone palettes for per-vertex accuracy.
          velocityMgr.generatePerObjectSkinned(this.mainCamera.getCulledKeys(), depthView);
        }
      }

      if (mainCameraEntity?.hasComponent('height_fog')) {
        const heightFog = mainCameraEntity.getComponent('height_fog') as HeightFogComponent;
        if (heightFog && heightFog.hasLoaded()) {
          result = heightFog.apply(result, this.deferred.getGBufferBindGroup());
        }
      }

      if (mainCameraEntity?.hasComponent('atmospheric_fog')) {
        const atmosphericFog = mainCameraEntity.getComponent(
          'atmospheric_fog',
        ) as AtmosphericFogComponent;
        if (atmosphericFog && atmosphericFog.hasLoaded()) {
          result = atmosphericFog.apply(result, this.deferred.getGBufferBindGroup());
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

      if (mainCameraEntity?.hasComponent('shockwave')) {
        const shockwave = mainCameraEntity.getComponent(
          'shockwave',
        ) as ShockwavePostProcessComponent;
        if (shockwave.hasLoaded()) {
          result = shockwave.apply(result, this.deferred.getLinearDepthView());
        }
      }

      if (mainCameraEntity?.hasComponent('depth_of_field')) {
        const depthOfField = mainCameraEntity.getComponent(
          'depth_of_field',
        ) as DepthOfFieldComponent;
        if (depthOfField.hasLoaded()) {
          result = depthOfField.apply(
            result,
            this.deferred.getGBufferBindGroup(),
            this.deferred.getLinearDepthView(),
          );
        }
      }

      if (mainCameraEntity?.hasComponent('auto_exposure')) {
        const autoExposure = mainCameraEntity.getComponent(
          'auto_exposure',
        ) as AutoExposureComponent;
        if (autoExposure.hasLoaded() && autoExposure.enabled) {
          autoExposure.apply(result, this.lastDt);
        }
      }

      if (mainCameraEntity?.hasComponent('god_rays')) {
        const godRays = mainCameraEntity.getComponent('god_rays') as GodRaysComponent;
        if (godRays.hasLoaded()) {
          if (mainCameraEntity.hasComponent('auto_exposure')) {
            const autoExposure = mainCameraEntity.getComponent(
              'auto_exposure',
            ) as AutoExposureComponent;
            if (autoExposure.hasLoaded()) {
              godRays.setExposureBuffer(autoExposure.getExposureBuffer());
            }
          }
          result = godRays.apply(result, this.deferred.getGBufferBindGroup());
        }
      }

      if (mainCameraEntity?.hasComponent('fog_scatter')) {
        const fogMultiScatter = mainCameraEntity.getComponent(
          'fog_scatter',
        ) as FogScatterComponent;
        if (fogMultiScatter.hasLoaded() && fogMultiScatter.isEnabled()) {
          const dirLights =
            Engine.getEntities().getObjectManagerByName('directional_light')?.getList() ?? [];
          const dirLight =
            dirLights.length > 0 ? (dirLights[0] as DirectionalLightComponent) : null;
          if (dirLight) {
            result = fogMultiScatter.render(result, this.deferred.getGBufferBindGroup(), dirLight);
          }
        }
      }

      if (mainCameraEntity?.hasComponent('lens_flare')) {
        const lensFlare = mainCameraEntity.getComponent('lens_flare') as LensFlareComponent;
        if (lensFlare.hasLoaded()) {
          result = lensFlare.apply(result, this.deferred.getGBufferBindGroup());
        }
      }

      // Physics debug wireframe — draw before TSR so colour and depth are both at
      // render resolution (TSR upscales colour to canvas size, making sizes diverge).
      {
        const physicsDebug = PhysicsDebugDrawer.getInstance();
        if (physicsDebug.hasLinesToDraw()) {
          const depthView = this.deferred.getDepthStencilView();
          if (depthView) {
            physicsDebug.draw(
              Render.getInstance().getCommandEncoder(),
              result,
              depthView,
              this.mainCamera.getBindGroup(),
            );
          }
        }
      }

      if (mainCameraEntity?.hasComponent('tsr')) {
        const tsr = mainCameraEntity.getComponent('tsr') as TSRComponent;
        if (tsr.hasLoaded()) {
          result = tsr.apply(result, this.deferred.getLinearDepthView());
        }
      } else if (mainCameraEntity?.hasComponent('taa')) {
        const taa = mainCameraEntity.getComponent('taa') as TAAComponent;
        if (taa.hasLoaded()) {
          result = taa.apply(result, this.deferred.getLinearDepthView());
        }
      }

      // View-model pass — runs AFTER TAA/TSR so the weapon is never included in the
      // temporal accumulation buffer, eliminating ghosting/trails on first-person weapons.
      // Renders into whatever texture `result` currently points to (accLight or TSR output).
      // The depth texture is resized automatically when TSR has upscaled to canvas resolution.
      const vmPass = this.deferred.getViewModelPass();
      if (vmPass.isReady()) {
        const cameraComponent = mainCameraEntity?.getComponent('camera') as CameraComponent;
        if (cameraComponent) {
          const vmCanvas = mainCameraEntity?.hasComponent('tsr')
            ? Render.canvasSize
            : { width: Render.width, height: Render.height };
          vmPass.execute(
            result,
            cameraComponent.getCamera().getBindGroup(),
            vmCanvas.width,
            vmCanvas.height,
          );
        }
      }

      if (mainCameraEntity?.hasComponent('tone_mapping')) {
        const toneMapping = mainCameraEntity.getComponent('tone_mapping') as ToneMappingComponent;
        if (toneMapping.hasLoaded()) {
          // When TSR has already upscaled to canvas resolution, tone mapping must
          // output at canvas size too — otherwise it would shrink the result back
          // to render resolution and break the scissor rect in the UI overlay pass.
          if (mainCameraEntity.hasComponent('tsr')) {
            const canvas = Render.canvasSize;
            toneMapping.setOutputSize(canvas.width, canvas.height);
          } else {
            toneMapping.setOutputSize(Render.width, Render.height);
          }
          // Wire auto-exposure buffer into tone mapping on first frame (and whenever it changes)
          if (mainCameraEntity.hasComponent('auto_exposure')) {
            const autoExposure = mainCameraEntity.getComponent(
              'auto_exposure',
            ) as AutoExposureComponent;
            if (autoExposure.hasLoaded()) {
              toneMapping.setExposureBuffer(autoExposure.getExposureBuffer());
            }
          }
          result = toneMapping.apply(result);
        }
      }

      if (mainCameraEntity?.hasComponent('palette_quantize')) {
        const paletteQuantize = mainCameraEntity.getComponent(
          'palette_quantize',
        ) as PaletteQuantizeComponent;
        if (paletteQuantize.hasLoaded()) {
          result = paletteQuantize.apply(result);
        }
      }

      if (mainCameraEntity?.hasComponent('fsr')) {
        const fsr = mainCameraEntity.getComponent('fsr') as FSRComponent;
        if (fsr.hasLoaded() && fsr.enabled) {
          // Pass the main encoder so EASU/RCAS compute passes run in the same
          // command buffer as tone mapping, eliminating the cross-submission
          // pipeline barrier that caused ~1ms GPU spikes.
          result = fsr.apply(result, Render.getInstance().getCommandEncoder());
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

      if (mainCameraEntity?.hasComponent('smaa_t2x')) {
        const smaaT2x = mainCameraEntity.getComponent('smaa_t2x') as SMAAT2xComponent;
        if (smaaT2x.hasLoaded()) {
          result = smaaT2x.apply(result, this.deferred.getLinearDepthView());
        }
      }

      if (mainCameraEntity?.hasComponent('vignette')) {
        const vignette = mainCameraEntity.getComponent('vignette') as VignetteComponent;
        if (vignette.hasLoaded()) {
          result = vignette.apply(result);
        }
      }

      if (mainCameraEntity?.hasComponent('chromatic_aberration')) {
        const ca = mainCameraEntity.getComponent(
          'chromatic_aberration',
        ) as ChromaticAberrationComponent;
        if (ca.hasLoaded()) {
          result = ca.apply(result);
        }
      }

      if (mainCameraEntity?.hasComponent('film_grain')) {
        const filmGrain = mainCameraEntity.getComponent('film_grain') as FilmGrainComponent;
        if (filmGrain.hasLoaded()) {
          result = filmGrain.apply(result, this.lastDt);
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

      Profiler.getInstance().cpu.end(); // Post-Process
    }

    // Render UI overlay on top of result texture
    this.renderUIOnTexture(result);

    // Present final result to screen
    this.presentResult(result);

    Render.getInstance().endFrame();

    // Trigger GPU readback mapAsync calls AFTER the main encoder is submitted.
    // HZBCullingPass copies counter/debug buffers into the main encoder;
    // mapAsync must start only once the encoder has been submitted (endFrame above).
    RenderManager.getInstance().postFrame();
  }

  /**
   * Render UI overlay directly on top of result texture.
   * Uses the MAIN command encoder so that the UI pass is recorded after all
   * post-processing (FXAA/FSR/etc.) and submitted together as a single batch.
   * This prevents the UI from being overwritten by a later main-encoder submission.
   */
  private renderUIOnTexture(resultView: GPUTextureView): void {
    const moduleUI = ModuleUI.getInstance();
    if (!moduleUI) {
      return; // No UI module
    }

    const render = Render.getInstance();
    // Use the MAIN encoder — not a separate one — so execution order is guaranteed.
    const encoder = render.getCommandEncoder();
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

    // Set viewport to the result texture dimensions.
    // After FSR + FXAA the result is at canvas resolution, not render resolution.
    const canvas = Render.canvasSize;
    const rtWidth = canvas.width;
    const rtHeight = canvas.height;

    // Configure viewport and scissor for UI rendering
    renderPass.setViewport(0, 0, rtWidth, rtHeight, 0.0, 1.0);
    renderPass.setScissorRect(0, 0, rtWidth, rtHeight);

    // Render all active UI widgets
    moduleUI.render(renderPass);

    renderPass.end();
    // DO NOT submit here — endFrame() submits the main encoder.
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
    this.debugValues.drawCallsGlass.value = renderManager.getDrawCallsForCategory(
      RenderCategory.GLASS,
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
      this.debugValues.drawCallsGlass.value +
      this.debugValues.drawCallsDistorsions.value +
      this.debugValues.drawCallsDecals.value;
    // GPU culling stats
    const gpuStats = renderManager.getGPUCullerStats();
    this.debugValues.gpuCullingKeys.value = gpuStats.active
      ? `${gpuStats.managed} / ${gpuStats.total}`
      : 'CPU fallback';
    this.debugValues.gpuEstimatedVisible.value = gpuStats.active
      ? `${gpuStats.estimatedVisible} / ${gpuStats.managed}`
      : '-';
    this.debugValues.hzbCulled.value = gpuStats.active
      ? `${renderManager.getHZBCulledCount()} objs`
      : '-';

    // Visible light counts (after CPU light culling)
    const pointLights = Engine.getEntities().getObjectManagerByName('point_light')?.getList() ?? [];
    this.debugValues.visiblePointLights.value = pointLights.filter((c) =>
      (c as PointLightComponent).isVisible(),
    ).length;

    const spotLights = Engine.getEntities().getObjectManagerByName('spot_light')?.getList() ?? [];
    this.debugValues.visibleSpotLights.value = spotLights.filter((c) =>
      (c as SpotLightComponent).isVisible(),
    ).length;

    this.debugValues.resolution.value = `${Render.width}x${Render.height}`;
    const cs = Render.canvasSize;
    this.debugValues.canvasResolution.value = `${cs.width}x${cs.height}`;

    // Update profiler display values
    const cpu = Profiler.getInstance().cpu;
    this.profilerCPU.Entities.value = `${cpu.getMs('Entities').toFixed(2)} ms`;
    this.profilerCPU.Shadows.value = `${cpu.getMs('Shadows').toFixed(2)} ms`;
    this.profilerCPU.Deferred.value = `${cpu.getMs('Deferred').toFixed(2)} ms`;
    this.profilerCPU['Post-Process'].value = `${cpu.getMs('Post-Process').toFixed(2)} ms`;

    const gpu = GPUProfiler.getInstance();
    this.profilerMeta.gpuSupported.value = gpu.supported ? 'Yes' : 'Not available';
    for (const name of Object.keys(this.profilerGPU)) {
      const entry = this.profilerGPU[name];
      if (entry) entry.value = `${gpu.getMs(name).toFixed(2)} ms`;
    }

    this.deferred.update(dt);
    this.lastDt = dt;
  }

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    this.renderLightingMenu(gui);
    this.renderAtmosphereMenu(gui);
    this.renderPostProcessingMenu(gui);
    this.renderStatsMenu(gui);
  }

  // Adds directional lights as sub-folders inside the "Lighting" folder created by ModuleEnvironmentManager.
  private renderLightingMenu(gui: any): void {
    const lights = Engine.getEntities().getObjectManagerByName('directional_light')?.getList();
    if (!lights?.length) return;

    const lightingFolder = (gui as any).folders?.get('Lighting');
    if (!lightingFolder) return;

    for (const light of lights) {
      const dirLight = light as DirectionalLightComponent;
      dirLight.renderInMenu(lightingFolder);
    }
  }

  private renderAtmosphereMenu(gui: any): void {
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCamera) return;

    if (this.beginGUIWindow('Atmosphere')) {
      this.endGUIWindow();
    }

    const atmoFolder = (gui as any).folders?.get('Atmosphere');
    if (!atmoFolder) return;

    // Volumetrics and clouds — each guards itself via _editorFolder.
    this.deferred.renderAtmosphereInMenu(atmoFolder);

    const tryRender = (key: string) => {
      if (!mainCamera.hasComponent(key)) return;
      const c = mainCamera.getComponent(key) as any;
      if (c?.hasLoaded?.() ?? true) c?.renderInMenu(atmoFolder);
    };

    tryRender('god_rays');
    tryRender('atmospheric_fog');
    tryRender('fog_scatter');
  }

  private renderPostProcessingMenu(gui: any): void {
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCamera) return;

    if (this.beginGUIWindow('Post Processing')) {
      this.endGUIWindow();
    }

    const ppFolder = (gui as any).folders?.get('Post Processing');
    if (!ppFolder) return;

    // Camera component controls — each guards itself via _editorFolder.
    this.deferred.renderSSRInMenu(ppFolder);

    const tryRender = (key: string) => {
      if (!mainCamera.hasComponent(key)) return;
      const c = mainCamera.getComponent(key) as any;
      if (c?.hasLoaded?.() ?? true) c?.renderInMenu(ppFolder);
    };

    tryRender('auto_exposure');
    tryRender('bloom');
    tryRender('tone_mapping');
    tryRender('lens_flare');
    tryRender('fsr');
    tryRender('tsr');
    tryRender('taa');
    tryRender('ambient_occlusion');
    tryRender('contact_shadows');
    tryRender('vignette');
    tryRender('chromatic_aberration');
    tryRender('film_grain');
    tryRender('shockwave');
  }

  private renderStatsMenu(gui: any): void {
    if (!this.beginGUIWindow('Statistics')) return;

    gui.addDynamicText(this.debugValues.drawCallsSolids, 'value', 'Draw Calls (Solids)');
    gui.addDynamicText(this.debugValues.drawCallsTransparent, 'value', 'Draw Calls (Transparent)');
    gui.addDynamicText(this.debugValues.drawCallsGlass, 'value', 'Draw Calls (Glass)');
    gui.addDynamicText(this.debugValues.drawCallsDistorsions, 'value', 'Draw Calls (Distortions)');
    gui.addDynamicText(this.debugValues.drawCallsDecals, 'value', 'Draw Calls (Decals)');
    this.addGUISeparator();
    gui.addDynamicText(this.debugValues.totalDrawCalls, 'value', 'Total Draw Cmds');
    this.addGUISeparator();
    gui.addDynamicText(this.debugValues.gpuCullingKeys, 'value', 'GPU Managed Keys');
    gui.addDynamicText(this.debugValues.gpuEstimatedVisible, 'value', 'Est. Visible (CPU)');
    gui.addDynamicText(this.debugValues.hzbCulled, 'value', 'HZB Culled');
    gui.addDynamicText(this.debugValues.visiblePointLights, 'value', 'Point Lights (visible)');
    gui.addDynamicText(this.debugValues.visibleSpotLights, 'value', 'Spot Lights (visible)');
    this.addGUISeparator();
    gui.addDynamicText(this.debugValues.resolution, 'value', 'Render Resolution');
    gui.addDynamicText(this.debugValues.canvasResolution, 'value', 'Canvas Resolution');
    this.endGUIWindow();
  }

  public override renderDebug(_filter?: string): void {}

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
