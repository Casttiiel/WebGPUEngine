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
  private skyboxTexture!: HDRTexture;
  private ambientLightData!: AmbientEnvironmentData;
  private skyboxType: string = 'cubemap';
  private timeOfDay: number = 0.5; // 0.0 = midnight, 0.5 = noon, 1.0 = midnight (normalized)
  private sunDir: vec3 = vec3.fromValues(0, 1, 0); // ALWAYS the real sun direction (for sky scattering)

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

    const response = await ResourceManager.fetch(`/data/environment.json`);
    const jsonData = await response.json();

    this.skyboxType = jsonData.skyboxType || 'cubemap';
    this.timeOfDay = jsonData.timeOfDay ?? 0.5;

    // Derive scene name from the first entry in boot.json for probe naming/file scoping
    try {
      const bootResp = await ResourceManager.fetch('data/boot.json');
      const bootData = (await bootResp.json()) as { scenes_to_load?: string[] };
      const first = bootData.scenes_to_load?.[0] ?? 'scene.json';
      this.sceneName = first.replace(/\.json$/i, '');
    } catch {
      this.sceneName = 'scene';
    }

    const [skyboxTexture, ssrEnvironmentTexture] = await Promise.all([
      HDRTexture.getAsync(jsonData.skybox),
      Cubemap.getAsync(jsonData.ssrEnvironment),
    ]);

    this.ambientLightData = {
      globalFactor: jsonData.ambient.globalFactor,
      diffuseFactor: jsonData.ambient.diffuseFactor,
      reflectionFactor: jsonData.ambient.reflectionFactor,
    };
    this.skyboxTexture = skyboxTexture;
    this.ssrEnvironmentTexture = ssrEnvironmentTexture;

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
    this.sunDir = vec3.fromValues(Math.cos(sunAngle), Math.sin(sunAngle), 0.0);
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
    const sunIntensity = sunAbove * sunMaxIntensity;

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
    this.ambientLightData.globalFactor = lerp(0.08, 5.0, sunAbove);
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

    // Time of Day slider with .listen() for automatic updates
    folder.add(this, 'timeOfDay', 0.0, 1.0).name('Time of Day').listen();

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
