import { Engine } from '../../core/engine/Engine';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Cubemap } from '../../renderer/resources/Cubemap';
import { HDRTexture } from '../../renderer/resources/HDRTexture';
import { AmbientEnvironmentData } from '../../types/AmbientEnvironmentData.type';
import { Interpolator } from '../../types/Interpolator.interface';
import { KeyCode } from '../../types/KeyCode.enum';
import { Module } from '../core/Module';
import { vec3 } from 'gl-matrix';
import { SHProjector } from '../../renderer/core/SHProjector';
import { MipmapGenerator } from '../../renderer/core/processing/MipmapGenerator';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { ProbeAutoPlacement } from '../../renderer/shading/ProbeAutoPlacement';
import { ProbeBaker } from '../../renderer/shading/ProbeBaker';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';
import { Wind } from '../../core/engine/Wind';

// ── Probe auto-placement config ────────────────────────────────────────────────
// Distance in metres between probe centres. Collider size and PCC AABB are
// derived automatically so adjacent probes tile without gaps.
//   Small value  → more probes, finer coverage, heavier bake
//   Large value  → fewer probes, coarser coverage, faster bake
const PROBE_SPACING = 8.0;

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

    // F7 — auto-place probes from scene geometry; the placement is saved as
    // assets/scenes/{scene}_probes.json (reference it in data/boot.json to keep them).
    if (Engine.getInput().isKeyJustPressed(KeyCode.F7)) {
      const candidates = await ProbeAutoPlacement.generate(this.sceneName, PROBE_SPACING);
      if (candidates.length > 0) {
        await ProbeBaker.save(
          'scenes',
          `${this.sceneName}_probes.json`,
          JSON.stringify(ProbeAutoPlacement.buildSceneJSON(candidates), null, 2),
        );
        console.log(
          `[Probes] ${candidates.length} placed → assets/scenes/${this.sceneName}_probes.json` +
            ' (add it to data/boot.json), F8 bakes them.',
        );
      }
    }

    // F8 — bake every probe (2 bounces), apply it live and save it to assets/probes/.
    if (Engine.getInput().isKeyJustPressed(KeyCode.F8)) {
      await ProbeBaker.bakeAll();
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
