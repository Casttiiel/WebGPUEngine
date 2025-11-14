import { ResourceManager } from '../../core/engine/ResourceManager';
import { Cubemap } from '../../renderer/resources/Cubemap';
import { HDRTexture } from '../../renderer/resources/HDRTexture';
import { AmbientEnvironmentData } from '../../types/AmbientEnvironmentData.type';
import { Interpolator } from '../../types/Interpolator.interface';
import { Module } from '../core/Module';

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

  private blendState: EnvironmentBlendState | null = null;

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    const response = await ResourceManager.fetch(`/data/environment.json`);
    const jsonData = await response.json();

    this.ambientLightData = {
      globalFactor: jsonData.ambient.globalFactor,
      diffuseFactor: jsonData.ambient.diffuseFactor,
      reflectionFactor: jsonData.ambient.reflectionFactor,
      irradianceCubemap: await Cubemap.getAsync(jsonData.ambient.irradianceCubemap),
    };

    this.skyboxTexture = await HDRTexture.getAsync(jsonData.skybox);
    this.ssrEnvironmentTexture = await Cubemap.getAsync(jsonData.ssrEnvironment);

    return true;
  }

  public update(dt: number): void {
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
        irradianceCubemap: this.blendState.startData.irradianceCubemap,
      };

      if (this.blendState.blendedWeight >= 1.0) {
        this.blendState = null;
      }
    }
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

  public changeIrradianceTexture(newTexture: string): void {
    Cubemap.getAsync(newTexture).then((cubemap) => {
      this.ambientLightData.irradianceCubemap = cubemap;
      //Delete de ambient light class blind group
    });
  }

  public changeSSREnvironmentTexture(newTexture: string): void {
    Cubemap.getAsync(newTexture).then((cubemap) => {
      this.ssrEnvironmentTexture = cubemap;
      //Delete de SSR class blind group
    });
  }

  public renderDebug(): void {}

  public stop(): void {
    console.log('ModuleEnvironmentManager stopped.');
  }

  public getAmbientLightData(): AmbientEnvironmentData {
    return this.ambientLightData;
  }

  public getSkyboxTexture(): HDRTexture {
    return this.skyboxTexture;
  }

  public getSSREnvironmentTexture(): Cubemap {
    return this.ssrEnvironmentTexture;
  }
}
