import { ReflectionProbeComponent } from '../../components/render/ReflectionProbeComponent';
import { Engine } from '../../core/engine/Engine';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Cubemap } from '../../renderer/resources/Cubemap';
import { HDRTexture } from '../../renderer/resources/HDRTexture';
import { AmbientEnvironmentData } from '../../types/AmbientEnvironmentData.type';
import { Interpolator } from '../../types/Interpolator.interface';
import { KeyCode } from '../../types/KeyCode.enum';
import { Module } from '../core/Module';
import { vec3 } from 'gl-matrix';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { DeferredRenderer } from '../../renderer/core/pipeline/DeferredRenderer';
import { Entity } from '../../core/ecs/Entity';
import { CameraComponent } from '../../components/render/CameraComponent';
import { SHProjector } from '../../renderer/core/SHProjector';
import { MipmapGenerator } from '../../renderer/core/processing/MipmapGenerator';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { ProbeAutoPlacement, ProbeCandidate } from '../../renderer/shading/ProbeAutoPlacement';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';
import { Wind } from '../../core/engine/Wind';
import { ProbeManager } from '../../renderer/core/managers/ProbeManager';
import { AmbientLight } from '../../renderer/shading/AmbientLight';

// ── Probe auto-placement config ────────────────────────────────────────────────
// Distance in metres between probe centres. Collider size and PCC AABB are
// derived automatically so adjacent probes tile without gaps.
//   Small value  → more probes, finer coverage, heavier bake
//   Large value  → fewer probes, coarser coverage, faster bake
const PROBE_SPACING = 16.0;

// Math utilities for atmospheric lighting
const lerp = (a: number, b: number, alpha: number): number => a + alpha * (b - a);
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

interface EnvironmentBlendState {
  startData: AmbientEnvironmentData;
  targetData: AmbientEnvironmentData;
  blendTime: number;
  blendedWeight: number;
  interpolator: Interpolator;
}

export class ModuleEnvironmentManager extends Module {
  private ssrEnvironmentTexture!: Cubemap;
  private environmentSH: Float32Array | null = null;
  private skyboxTexture!: HDRTexture;
  private ambientLightData!: AmbientEnvironmentData;
  private skyboxType: string = 'cubemap';
  private timeOfDay: number = 0.5; // 0.0 = midnight, 0.5 = noon, 1.0 = midnight (normalized)
  private sunDir: vec3 = vec3.fromValues(0, 1, 0); // ALWAYS the real sun direction (for sky scattering)
  /** environment.json "sun": tinte del sol (p.ej. rojo) y escala de su intensidad. */
  private sunTint: vec3 = vec3.fromValues(1, 1, 1);
  private sunIntensityScale = 1.0;
  /**
   * environment.json "sun": recorrido del sol. latitude (grados; 0 = ecuador, el sol pasa por el
   * cénit), declination (grados; la estación: +23 verano, -23 invierno en el hemisferio norte) y
   * northAzimuth (grados: hacia dónde cae el norte respecto a la escena; el este por defecto es +X
   * y el norte -Z). Todo a 0 = recorrido de este a oeste por el cénit.
   */
  private sunLatitude = 0;
  private sunDeclination = 0;
  private sunNorthAzimuth = 0;
  /** environment.json "ambient.dayScale": escala del ambiente de día ligado al cielo. */
  private ambientDayScale = 1.0;

  private blendState: EnvironmentBlendState | null = null;

  /** Base name of the first scene in boot.json (e.g. "level-1"). Used to prefix probe names. */
  private sceneName: string = 'scene';

  // Cloud parameters (sky-only, exposed via renderInMenu)
  public cloudThickness: number = 3.2;
  public cloudDistanceFade: number = 0.15;
  public cloudCoverage: number = 0.0; // 0=sparse (default), 1=overcast
  public cloudScale: number = 1.0; // >1 = bigger clouds
  public cloudLayers: number = 4; // FBM octave count [1..8]
  public cloudOpacity: number = 0.0; // max cloud opacity (0 = hidden)
  public cloudColor: [number, number, number] = [1, 1, 1]; // normalized 0-1 (white = no tint)

  /**
   * Which cloud system is active (environment.json → "clouds.type"):
   *  - 'volumetric': ray-marched VolumetricClouds (default)
   *  - 'flat':       2D FBM clouds painted by the procedural sky (cloud* fields above)
   *  - 'none':       no clouds
   */
  public cloudsType: CloudsType = 'volumetric';
  /** Volumetric cloud settings from environment.json ("clouds.volumetric"), applied on load. */
  private volumetricCloudSettings: VolumetricCloudSettings = {};
  /** Ajustes de la niebla volumétrica (froxels) de environment.json ("volumetrics"). */
  private volumetricFogSettings: VolumetricFogSettings = {};

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    // Kick off mipmap pipeline compilation immediately — runs in background while
    // we fetch JSON and download textures so GPU work overlaps with I/O.
    const qualitySettings = QualitySettings.getInstance().getSettings();
    void MipmapGenerator.getInstance().preWarm([
      qualitySettings.generalTexture, // cubemap format
      'rgba16float', // HDR texture format
    ]);

    // boot.json puede elegir el fichero de entorno ("environment"); por defecto environment.json.
    // Derive scene name from the first entry in boot.json for probe naming/file scoping
    let environmentFile = 'environment.json';
    try {
      const bootResp = await ResourceManager.fetch('data/boot.json');
      const bootData = (await bootResp.json()) as {
        scenes_to_load?: string[];
        environment?: string;
      };
      const first = bootData.scenes_to_load?.[0] ?? 'scene.json';
      this.sceneName = first.replace(/\.json$/i, '');
      if (bootData.environment) environmentFile = bootData.environment;
    } catch {
      this.sceneName = 'scene';
    }

    // Dev: un scenario (`?scenario=nombre`) puede traer su propio "environment" (un fichero
    // de data/) que sustituye al de boot.json.
    if (import.meta.env.DEV) {
      const scenarioName = new URLSearchParams(window.location.search).get('scenario');
      if (scenarioName) {
        const scenarioResp = await ResourceManager.fetch(`data/scenarios/${scenarioName}.json`);
        const scenario = (await scenarioResp.json()) as { environment?: string };
        if (scenario.environment) environmentFile = scenario.environment;
      }
    }

    const response = await ResourceManager.fetch(`/data/${environmentFile}`);
    const jsonData = await response.json();

    this.skyboxType = jsonData.skyboxType || 'cubemap';
    this.loadCloudSettings(jsonData.clouds);
    this.volumetricFogSettings = jsonData.volumetrics ?? {};
    this.timeOfDay = jsonData.timeOfDay ?? 0.5;
    if (jsonData.sun?.tint) vec3.set(this.sunTint, ...(jsonData.sun.tint as [number, number, number]));
    this.sunIntensityScale = jsonData.sun?.intensityScale ?? 1.0;
    this.sunLatitude = jsonData.sun?.latitude ?? 0;
    this.sunDeclination = jsonData.sun?.declination ?? 0;
    this.sunNorthAzimuth = jsonData.sun?.northAzimuth ?? 0;
    this.ambientDayScale = jsonData.ambient?.dayScale ?? 1.0;

    const [skyboxTexture, ssrEnvironmentTexture] = await Promise.all([
      HDRTexture.getAsync(jsonData.skybox),
      Cubemap.getAsync(jsonData.ssrEnvironment),
    ]);

    this.ambientLightData = {
      globalFactor: jsonData.ambient.globalFactor,
      diffuseFactor: jsonData.ambient.diffuseFactor,
      reflectionFactor: jsonData.ambient.reflectionFactor,
      environmentIntensity: jsonData.ambient.environmentIntensity ?? 1.0,
    };
    this.skyboxTexture = skyboxTexture;
    this.ssrEnvironmentTexture = ssrEnvironmentTexture;
    this.environmentSH = await this.projectEnvironmentSH(ssrEnvironmentTexture);

    return true;
  }

  public async update(dt: number): Promise<void> {
    // Update atmospheric lighting if using procedural skybox
    if (this.skyboxType === 'procedural') {
      this.updateAtmosphericLighting();
    }

    if (this.blendState) {
      this.blendState.blendedWeight = Math.min(
        this.blendState.blendedWeight + dt / this.blendState.blendTime,
        1.0,
      );
      const ratio = this.blendState.interpolator.blend(0, 1, this.blendState.blendedWeight);

      // Blend de cada parámetro
      this.ambientLightData = {
        globalFactor:
          this.blendState.startData.globalFactor * (1.0 - ratio) +
          this.blendState.targetData.globalFactor * ratio,
        diffuseFactor:
          this.blendState.startData.diffuseFactor * (1.0 - ratio) +
          this.blendState.targetData.diffuseFactor * ratio,
        reflectionFactor:
          this.blendState.startData.reflectionFactor * (1.0 - ratio) +
          this.blendState.targetData.reflectionFactor * ratio,
        environmentIntensity:
          this.blendState.startData.environmentIntensity * (1.0 - ratio) +
          this.blendState.targetData.environmentIntensity * ratio,
      };

      if (this.blendState.blendedWeight >= 1.0) {
        this.blendState = null;
      }
    }

    // F7 — auto-place probes from scene geometry and download placement JSON.
    // Add the downloaded file to assets/scenes/ and reference it in boot.json
    // so probes persist across sessions.
    if (Engine.getInput().isKeyJustPressed(KeyCode.F7)) {
      const candidates = await ProbeAutoPlacement.generate(this.sceneName, PROBE_SPACING);
      if (candidates.length > 0) {
        this.downloadProbesJSON(candidates);
      }
    }

    // F8 — bake all existing reflection probes (SH + cubemap) and re-export
    // the placement JSON so the file stays in sync with the current scene state.
    if (Engine.getInput().isKeyJustPressed(KeyCode.F8)) {
      const moduleRender = Engine.getRender();
      moduleRender.pauseRendering = true;

      const probeComponents =
        Engine.getEntities().getObjectManagerByName('reflection_probe')?.getList() ?? [];

      for (const comp of probeComponents) {
        await this.captureAndDownloadProbe(comp as ReflectionProbeComponent);
      }

      // Re-export placement JSON with the actual probes in the scene
      this.downloadProbesJSONFromComponents(
        probeComponents.map((c) => c as ReflectionProbeComponent),
      );

      moduleRender.pauseRendering = false;
    }
  }

  /**
   * Updates atmospheric lighting parameters based on time of day
   * Only called when skyboxType is 'procedural'
   *
   * FASE 2 — Una sola luz con rol sol/luna correcto
   */
  private updateAtmosphericLighting(): void {
    // Get directional light component (assumes there's at least one)
    const directionalLights = Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList();

    if (!directionalLights || directionalLights.length === 0) {
      return;
    }

    // Get first directional light (main light with sun/moon role)
    const mainLight = directionalLights[0] as DirectionalLightComponent;

    // FASE 1.1 — Dirección del sol (SIEMPRE calculada, para el sky)
    // Ángulo solar con offset para mapeo astronómico correcto:
    // -π/2  = medianoche (debajo)
    //  0    = amanecer (horizonte este)
    // +π/2  = mediodía (cenit)
    //  π    = atardecer (horizonte oeste)
    // 3π/2  = medianoche (debajo)
    const sunAngle = this.timeOfDay * 2.0 * Math.PI - Math.PI * 0.5;
    // Posición astronómica (este, norte, arriba) a partir del ángulo horario (0 = mediodía), la
    // latitud y la declinación. Con latitud y declinación 0 es el arco este → cénit → oeste.
    const hourAngle = sunAngle - Math.PI * 0.5;
    const lat = this.sunLatitude * (Math.PI / 180);
    const dec = this.sunDeclination * (Math.PI / 180);
    const east = -Math.cos(dec) * Math.sin(hourAngle);
    const north = Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(hourAngle);
    const up = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle);
    // A la escena: este = +X y norte = -Z, girados northAzimuth sobre la vertical.
    const az = this.sunNorthAzimuth * (Math.PI / 180);
    const x = east;
    const z = -north;
    this.sunDir = vec3.fromValues(
      x * Math.cos(az) - z * Math.sin(az),
      up,
      x * Math.sin(az) + z * Math.cos(az),
    );
    vec3.normalize(this.sunDir, this.sunDir);

    // FASE 1.2 — Dirección de la luna (opuesta al sol)
    const moonDir = vec3.create();
    vec3.scale(moonDir, this.sunDir, -1.0);

    // FASE 1.3 — Factores día/noche
    const sunHeight = this.sunDir[1]!; // Now correctly: positive = above, negative = below
    const sunAbove = Math.max(0.0, sunHeight);

    // FASE 2.1 — Valores del sol (día)
    const sunMaxIntensity = 10.0; // Intensidad HDR
    const t = Math.pow(sunAbove, 0.5); // Factor de altura suavizado
    const sunColor: vec3 = vec3.fromValues(
      lerp(1.0, 1.0, t), // R: siempre 1.0
      lerp(0.5, 1.0, t), // G: 0.5 (naranja) → 1.0 (blanco)
      lerp(0.3, 0.98, t), // B: 0.3 (naranja) → 0.98 (blanco-azul)
    );
    vec3.multiply(sunColor, sunColor, this.sunTint);
    const sunIntensity = sunAbove * sunMaxIntensity * this.sunIntensityScale;

    // FASE 2.2 — Valores de la luna (noche)
    const moonMaxIntensity = 0.2; // Mucho más débil
    const moonColor: vec3 = vec3.fromValues(0.6, 0.7, 1.0); // Azul frío lunar

    // FASE 2.6 — Crossfade suave en el horizonte (sin hard switch)
    const k = smoothstep(-0.05, 0.05, sunHeight);

    // Interpolar dirección, color e intensidad
    const celestialDir = vec3.create();
    vec3.lerp(celestialDir, moonDir, this.sunDir, k);
    vec3.normalize(celestialDir, celestialDir);

    // CRITICAL: Negar la dirección para que apunte HACIA las superficies (no hacia el cielo)
    // celestialDir apunta HACIA el sol/luna, lightDir debe apuntar DESDE el sol/luna HACIA el suelo
    const lightDir = vec3.create();
    vec3.negate(lightDir, celestialDir);

    const lightColor = vec3.create();
    vec3.lerp(lightColor, moonColor, sunColor, k);

    const lightIntensity = lerp(moonMaxIntensity, sunIntensity, k);

    // Aplicar a la luz principal (solo si está vinculada al tiempo del día)
    if (mainLight.linkedToTimeOfDay) {
      mainLight.setLightDirection(lightDir);
      mainLight.setColor([lightColor[0], lightColor[1], lightColor[2]]);
      mainLight.setIntensity(lightIntensity);
    }

    // FASE 4.1 — Ambient ligado al cielo
    this.ambientLightData.globalFactor = lerp(0.08, 5.0 * this.ambientDayScale, sunAbove);
  }

  /**
   * Captura un cubemap desde la posición del probe y lo descarga
   */
  private async captureAndDownloadProbe(probe: ReflectionProbeComponent): Promise<void> {
    const probeName = probe.getOwner().getName();
    const position = probe.getPosition();
    const resolution = probe.getResolution();
    const camera = probe.getCaptureCamera();

    if (!camera) {
      console.error(`❌ Probe ${probeName} no tiene cámara de captura`);
      return;
    }

    const device = GPUUtils.getDevice();

    // ✅ IMPORTANTE: Sobrescribir dimensiones del render ANTES de crear el DeferredRenderer
    // para que todos los recursos (depth, G-Buffer, etc.) se creen con la resolución correcta
    Render.setTemporaryRenderSize(resolution, resolution);

    // Crear DeferredRenderer temporal para renderizar las 6 caras
    const tempRenderer = new DeferredRenderer();
    await tempRenderer.load();
    tempRenderer.create(resolution, resolution);

    // Crear textura cubemap para almacenar resultado final
    const cubemapTexture = device.createTexture({
      label: `${probeName}_cubemap`,
      size: [resolution, resolution, 6],
      format: 'rgba16float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST | // Necesario para recibir copias
        GPUTextureUsage.TEXTURE_BINDING,
      dimension: '2d',
    });

    // Direcciones y ups para cada cara del cubemap
    const faceDirections: [vec3, vec3][] = [
      [vec3.fromValues(1, 0, 0), vec3.fromValues(0, -1, 0)], // +X
      [vec3.fromValues(-1, 0, 0), vec3.fromValues(0, -1, 0)], // -X
      [vec3.fromValues(0, 1, 0), vec3.fromValues(0, 0, 1)], // +Y
      [vec3.fromValues(0, -1, 0), vec3.fromValues(0, 0, -1)], // -Y
      [vec3.fromValues(0, 0, 1), vec3.fromValues(0, -1, 0)], // +Z
      [vec3.fromValues(0, 0, -1), vec3.fromValues(0, -1, 0)], // -Z
    ];

    // Crear entidad temporal con la cámara del probe
    const tempCameraEntity = new Entity();
    const tempCameraComponent = new CameraComponent();
    tempCameraComponent.setOwner(tempCameraEntity);
    tempCameraComponent.setCamera(camera);
    tempCameraEntity.addComponent('camera', tempCameraComponent);

    // ─── Baking mode: use white irradiance in shader to avoid feedback loop ──────
    // Prevents existing probe irradiance from contaminating the capture (feedback darkening).
    AmbientLight.setBakingMode(true);
    ProbeManager.getInstance().setBakingMode(true);
    // ─────────────────────────────────────────────────────────────────────────────

    // Renderizar cada cara
    for (let face = 0; face < 6; face++) {
      const [direction, up] = faceDirections[face]!;
      const target = vec3.add(vec3.create(), position, direction);

      // Configurar cámara para esta cara
      camera.lookAt(position, target, up);
      camera.updateUniforms(0);

      // ✅ Actualizar viewport de la cámara a la resolución del probe
      camera.setViewport(resolution, resolution);

      // ✅ INICIAR NUEVO FRAME para el probe (encoder independiente)
      Render.getInstance().beginFrame();
      // ✅ CRÍTICO: Configurar la cámara del probe como cámara principal temporal
      // Esto hace que AmbientLight, DirectionalLight y otras luces usen esta cámara
      // en lugar de la cámara principal de la escena
      const moduleRender = Engine.getRender();
      moduleRender.setTemporaryMainCamera(camera);

      // ✅ Configurar RenderManager con la cámara del probe DESPUÉS de beginFrame
      // IMPORTANTE: Esto debe ir ANTES de generateShadowMaps porque las sombras
      // necesitan saber qué cámara está activa
      RenderManager.getInstance().setCamera(camera);
      RenderManager.getInstance().performCulling(camera);

      // Regenerar shadow maps ajustados al frustum de esta cara del probe
      for (const comp of Engine.getEntities()
        .getObjectManagerByName('directional_light')
        ?.getList() ?? []) {
        (comp as DirectionalLightComponent).updateShadowsForCamera(camera);
      }
      tempRenderer.generateShadowMaps();

      // Restaurar culling de geometría principal tras la generación de shadow maps
      RenderManager.getInstance().setCamera(camera);
      RenderManager.getInstance().performCulling(camera);

      // 🔧 CRITICAL FIX: Llamar update() antes de render() para escribir uniforms
      // Sin esto, el ambient uniform buffer queda vacío/corrupto
      tempRenderer.update(0);

      // ✅ Renderizar usando el pipeline completo (G-Buffer + Lighting + Skybox)
      // Con skipPostProcessing = true para evitar SSR y volumetrics (innecesarios en probes)
      tempRenderer.render(tempCameraEntity, true);

      // ✅ Finalizar frame del probe
      Render.getInstance().endFrame();

      // ✅ Copiar resultado del rtAccLight al cubemap
      const encoder = device.createCommandEncoder({
        label: `Reflection Probe ${probeName} Face ${face} Copy`,
      });

      const accLightRenderTarget = tempRenderer.getAccLightRenderTarget();
      const accLightTexture = accLightRenderTarget.getTexture();

      encoder.copyTextureToTexture(
        { texture: accLightTexture },
        { texture: cubemapTexture, origin: { x: 0, y: 0, z: face } },
        { width: resolution, height: resolution, depthOrArrayLayers: 1 },
      );

      device.queue.submit([encoder.finish()]);
    }

    // ✅ IMPORTANTE: Restaurar la cámara principal original
    const moduleRender = Engine.getRender();
    moduleRender.restoreMainCamera();

    // Desactivar baking mode y restaurar
    AmbientLight.setBakingMode(false);
    ProbeManager.getInstance().setBakingMode(false);

    // Limpiar renderer temporal
    tempRenderer.destroy();

    // ✅ Restaurar dimensiones originales del render
    Render.restoreRenderSize();

    // Project SH L2 irradiance coefficients and download as JSON
    await this.computeAndDownloadSH(cubemapTexture, probeName, resolution);

    // Download the raw reflection cubemap (kept for specular PCC)
    await this.downloadCubemap(cubemapTexture, probeName, resolution);

    // Limpiar
    cubemapTexture.destroy();
  }

  /**
   * Projects the captured cubemap to SH L2 irradiance coefficients and downloads as JSON.
   * Replaces the old irradiance cubemap bake — produces 27 floats instead of a 128×128 image.
   */
  private async computeAndDownloadSH(
    cubemapTexture: GPUTexture,
    probeName: string,
    resolution: number,
  ): Promise<void> {
    const sh = await SHProjector.projectFromGPUTexture(cubemapTexture, resolution);
    const json = JSON.stringify({ sh: Array.from(sh) });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    // Save as {probeName}_sh.json — place in public/assets/probes/ after download
    link.download = `${probeName}_sh.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  /**
   * Descarga un cubemap como una sola imagen en formato T horizontal
   * Layout:      [top]
   *         [left][front][right][back]
   *              [bottom]
   */
  private async downloadCubemap(
    texture: GPUTexture,
    name: string,
    resolution: number,
  ): Promise<void> {
    const device = GPUUtils.getDevice();
    const bytesPerPixel = 8; // rgba16float = 8 bytes per pixel
    const bytesPerRow = resolution * bytesPerPixel;
    const bufferSize = bytesPerRow * resolution;

    // Orden de caras en el cubemap: [right, left, top, bottom, front, back]
    const faceNames = ['right', 'left', 'top', 'bottom', 'front', 'back'];

    // Crear canvas grande para el layout en T horizontal (4 ancho x 3 alto)
    const canvasWidth = resolution * 4;
    const canvasHeight = resolution * 3;
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d')!;

    // Posiciones de cada cara en el layout T horizontal
    // [top] está en (1, 0)
    // [left][front][right][back] están en (0,1), (1,1), (2,1), (3,1)
    // [bottom] está en (1, 2)
    const facePositions: Record<string, [number, number]> = {
      top: [1, 0],
      left: [0, 1],
      front: [1, 1],
      right: [2, 1],
      back: [3, 1],
      bottom: [1, 2],
    };

    // Procesar cada cara
    for (let face = 0; face < 6; face++) {
      const faceName = faceNames[face]!;

      // Crear buffer para copiar datos
      const readBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      // Copiar cara del cubemap al buffer
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        {
          texture,
          origin: { x: 0, y: 0, z: face },
        },
        {
          buffer: readBuffer,
          bytesPerRow,
        },
        {
          width: resolution,
          height: resolution,
          depthOrArrayLayers: 1,
        },
      );
      device.queue.submit([encoder.finish()]);

      // Leer datos del buffer
      await readBuffer.mapAsync(GPUMapMode.READ);
      const arrayBuffer = readBuffer.getMappedRange();
      const float16Data = new Uint16Array(arrayBuffer);

      // Convertir Float16 a RGB8 para PNG
      const rgbaData = new Uint8ClampedArray(resolution * resolution * 4);
      let minVal = Infinity;
      let maxVal = -Infinity;
      let avgVal = 0;

      // ✅ CRÍTICO: Invertir Y durante la conversión porque WebGPU tiene Y invertido
      for (let y = 0; y < resolution; y++) {
        for (let x = 0; x < resolution; x++) {
          // Leer desde la posición original (Y normal)
          const srcIndex = (y * resolution + x) * 4;

          // Escribir a la posición invertida (Y invertido)
          const dstY = resolution - 1 - y;
          const dstIndex = (dstY * resolution + x) * 4;

          // Convertir float16 a float32 y luego a 0-255
          const r = this.float16ToFloat32(float16Data[srcIndex + 0]!);
          const g = this.float16ToFloat32(float16Data[srcIndex + 1]!);
          const b = this.float16ToFloat32(float16Data[srcIndex + 2]!);

          // Track min/max para debugging
          const avg = (r + g + b) / 3;
          minVal = Math.min(minVal, avg);
          maxVal = Math.max(maxVal, avg);
          avgVal += avg;

          rgbaData[dstIndex + 0] = Math.min(255, Math.max(0, r * 255));
          rgbaData[dstIndex + 1] = Math.min(255, Math.max(0, g * 255));
          rgbaData[dstIndex + 2] = Math.min(255, Math.max(0, b * 255));
          rgbaData[dstIndex + 3] = 255; // Alpha
        }
      }

      avgVal /= resolution * resolution;

      readBuffer.unmap();
      readBuffer.destroy();

      // Crear ImageData y dibujar en la posición correspondiente del canvas grande
      const imageData = new ImageData(rgbaData, resolution, resolution);
      const [gridX, gridY] = facePositions[faceName]!;
      const canvasX = gridX * resolution;
      const canvasY = gridY * resolution;

      ctx.putImageData(imageData, canvasX, canvasY);
    }

    // Descargar la imagen completa en formato T
    await new Promise<void>((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${name}_cubemap_T.png`;

          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);

          setTimeout(() => URL.revokeObjectURL(url), 100);
        } else {
        }
        resolve();
      });
    });
  }

  /**
   * Convierte float16 a float32 (simplificado)
   */
  private float16ToFloat32(h: number): number {
    const sign = (h & 0x8000) >> 15;
    const exponent = (h & 0x7c00) >> 10;
    const fraction = h & 0x03ff;

    if (exponent === 0) {
      return (sign ? -1 : 1) * Math.pow(2, -14) * (fraction / 1024);
    } else if (exponent === 0x1f) {
      return fraction ? NaN : (sign ? -1 : 1) * Infinity;
    }

    return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
  }

  public blendTo(
    targetData: AmbientEnvironmentData,
    blendTime: number,
    interpolator: Interpolator,
  ) {
    this.blendState = {
      startData: { ...this.ambientLightData },
      targetData,
      blendTime,
      blendedWeight: 0.0,
      interpolator,
    };
  }

  // ── Probe placement JSON helpers ────────────────────────────────────────────

  /** Downloads a scene-compatible JSON from auto-placement candidates (F7). */
  private downloadProbesJSON(candidates: ProbeCandidate[]): void {
    this.downloadJSON(
      ProbeAutoPlacement.buildSceneJSON(candidates),
      `${this.sceneName}_probes.json`,
    );
    console.log(
      `[Probes] Downloaded ${this.sceneName}_probes.json` +
        ` — add it to assets/scenes/ and reference it in data/boot.json.`,
    );
  }

  /** Downloads a scene-compatible JSON from the live ReflectionProbeComponents (F8). */
  private downloadProbesJSONFromComponents(probes: ReflectionProbeComponent[]): void {
    const entities = probes.map((probe) => {
      const pos = probe.getPosition();
      const ext = probe.getExtents();
      return {
        prefab: 'lighting/reflection_probe.prefab',
        components: {
          name: probe.getOwner().getName(),
          transform: { position: [pos[0], pos[1], pos[2]] },
          reflection_probe: {
            resolution: probe.getResolution(),
            type: probe.getProbeType(),
            extents: [ext[0], ext[1], ext[2]],
          },
        },
      };
    });
    this.downloadJSON(entities, `${this.sceneName}_probes.json`);
  }

  private downloadJSON(data: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  public changeSSREnvironmentTexture(newTexture: string): void {
    Cubemap.getAsync(newTexture)
      .then((cubemap) => {
        this.ssrEnvironmentTexture = cubemap;
        Engine.getRender().getDeferredRenderer().resetSSRResources();
      })
      .catch(() => {
        // Texture not found (not yet baked) — keep current SSR environment texture
      });
  }

  /**
   * Parses the optional "clouds" block of environment.json:
   *   "clouds": {
   *     "type": "volumetric" | "flat" | "none",
   *     "flat":       { "opacity", "coverage", "scale", "thickness", "layers", "distanceFade", "color" },
   *     "volumetric": { "base", "top", "coverage", "density", "absorption", "scatterStrength",
   *                     "frequency", "stepCount", "lightSteps", "fadeRadius", "resolutionDivisor" }
   *   }
   * Every field is optional; omitted ones keep their defaults.
   */
  private loadCloudSettings(clouds: CloudsJson | undefined): void {
    if (!clouds) return;
    if (clouds.type === 'volumetric' || clouds.type === 'flat' || clouds.type === 'none') {
      this.cloudsType = clouds.type;
    } else if (clouds.type !== undefined) {
      console.warn(`[Environment] Unknown clouds.type "${clouds.type}" — using "volumetric"`);
    }

    const flat = clouds.flat ?? {};
    // Flat clouds are hidden by default (opacity 0): make them visible when selected
    this.cloudOpacity = flat.opacity ?? (this.cloudsType === 'flat' ? 1.0 : this.cloudOpacity);
    if (flat.coverage !== undefined) this.cloudCoverage = flat.coverage;
    if (flat.scale !== undefined) this.cloudScale = flat.scale;
    if (flat.thickness !== undefined) this.cloudThickness = flat.thickness;
    if (flat.layers !== undefined) this.cloudLayers = flat.layers;
    if (flat.distanceFade !== undefined) this.cloudDistanceFade = flat.distanceFade;
    if (flat.color !== undefined) this.cloudColor = flat.color;

    this.volumetricCloudSettings = clouds.volumetric ?? {};
  }

  public getCloudsType(): CloudsType {
    return this.cloudsType;
  }

  public getVolumetricCloudSettings(): Readonly<VolumetricCloudSettings> {
    return this.volumetricCloudSettings;
  }

  public getVolumetricFogSettings(): Readonly<VolumetricFogSettings> {
    return this.volumetricFogSettings;
  }

  /** Opacity of the sky's 2D clouds — zero unless the flat cloud system is selected. */
  public getFlatCloudOpacity(): number {
    return this.cloudsType === 'flat' ? this.cloudOpacity : 0.0;
  }

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    // Use beginWindow to create/get the folder
    if (!gui.beginWindow('Lighting', true)) return;

    // Get the folder from GUIManager's internal map
    const guiManager = gui as any;
    const folder = guiManager.folders?.get('Lighting');

    if (!folder) {
      gui.endWindow();
      return;
    }

    // Use raw lil-gui API with .listen() for automatic UI updates
    folder
      .add(this.ambientLightData, 'globalFactor', 0.0, 5.0)
      .name('Global Factor')
      .listen()
      .onChange(() => {
        Engine.getRender().getDeferredRenderer().resetAmbientLightResources();
      });

    folder
      .add(this.ambientLightData, 'diffuseFactor', 0.0, 5.0)
      .name('Diffuse Factor')
      .listen()
      .onChange(() => {
        Engine.getRender().getDeferredRenderer().resetAmbientLightResources();
      });

    folder
      .add(this.ambientLightData, 'reflectionFactor', 0.0, 5.0)
      .name('Reflection Factor')
      .listen()
      .onChange(() => {
        Engine.getRender().getDeferredRenderer().resetAmbientLightResources();
      });

    folder
      .add(this.ambientLightData, 'environmentIntensity', 0.0, 5.0)
      .name('Env Reflection Intensity')
      .listen();

    // Time of Day slider with .listen() for automatic updates
    folder.add(this, 'timeOfDay', 0.0, 1.0).name('Time of Day').listen();

    // ── Clouds ──
    folder.add(this, 'cloudsType', ['volumetric', 'flat', 'none']).name('Clouds').listen();

    // ── Wind ──
    folder.add(Wind, 'speed', 0.0, 0.5).name('Wind Speed').listen();
    folder.add(Wind, 'dirAngle', 0.0, 360.0).name('Wind Direction (°)').listen();

    gui.endWindow();
  }

  public renderDebug(): void {}

  public stop(): void {}

  public getAmbientLightData(): AmbientEnvironmentData {
    return this.ambientLightData;
  }

  public getSkyboxTexture(): HDRTexture {
    return this.skyboxTexture;
  }

  public getSSREnvironmentTexture(): Cubemap {
    return this.ssrEnvironmentTexture;
  }

  /** SH L2 irradiance of the global environment (HDR sources only), used when no probe covers a point. */
  public getEnvironmentSH(): Float32Array | null {
    return this.environmentSH;
  }

  /**
   * Projects an HDR (rgba16float) environment cubemap into SH irradiance, so the diffuse ambient
   * comes from the same environment as the specular. LDR cubemaps return null (no diffuse IBL).
   */
  private async projectEnvironmentSH(cubemap: Cubemap): Promise<Float32Array | null> {
    const texture = cubemap.getTexture();
    if (!texture || texture.format !== 'rgba16float') return null;
    // A low mip is plenty for L2 SH and keeps the CPU projection cheap
    const mip = Math.min(2, texture.mipLevelCount - 1);
    return SHProjector.projectFromGPUTexture(texture, texture.width, mip);
  }

  public getSkyboxType(): string {
    return this.skyboxType;
  }

  public setSkyboxType(type: string): void {
    this.skyboxType = type;
  }

  public getTimeOfDay(): number {
    return this.timeOfDay;
  }

  public setTimeOfDay(time: number): void {
    // Clamp between 0 and 1 (inclusive)
    // Note: 0 and 1 represent the same time (midnight), but we allow both for slider convenience
    this.timeOfDay = Math.max(0.0, Math.min(1.0, time));
  }

  /**
   * Get the real sun direction (ALWAYS for sky scattering)
   * Even at night, the sky needs the real sun position for correct twilight/scattering
   */
  public getSunDirection(): vec3 {
    return this.sunDir;
  }
}

export type CloudsType = 'volumetric' | 'flat' | 'none';

/** Overrides for VolumetricClouds (environment.json → "clouds.volumetric"). */
/** environment.json "volumetrics": niebla volumétrica (froxels). Lo que falte, por defecto. */
export interface VolumetricFogSettings {
  /** Fase de Henyey-Greenstein: 0.9 = god rays (solo hacia el sol), ~0.2 = bruma que se ve desde cualquier lado. */
  anisotropy?: number;
  /** Luz ambiente que dispersa la niebla (sin ella solo se ve iluminada por luces). */
  ambientIntensity?: number;
}

export interface VolumetricCloudSettings {
  base?: number; // world-Y of the cloud bottom (m)
  top?: number; // world-Y of the cloud top (m)
  coverage?: number; // 0 = sparse … 1 = overcast
  density?: number;
  absorption?: number;
  scatterStrength?: number;
  frequency?: number;
  stepCount?: number;
  lightSteps?: number;
  fadeRadius?: number; // m
  resolutionDivisor?: number; // render at 1/N resolution
}

interface CloudsJson {
  type?: string;
  flat?: {
    opacity?: number;
    coverage?: number;
    scale?: number;
    thickness?: number;
    layers?: number;
    distanceFade?: number;
    color?: [number, number, number];
  };
  volumetric?: VolumetricCloudSettings;
}
