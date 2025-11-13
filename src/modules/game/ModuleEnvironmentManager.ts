import { ResourceManager } from '../../core/engine/ResourceManager';
import { AmbientEnvironmentData } from '../../types/AmbientEnvironmentData.type';
import { Module } from '../core/Module';

export class ModuleEnvironmentManager extends Module {
  private ssrEnvironmentTexture!: GPUTexture;
  private skyboxTexture!: GPUTexture;
  private ambientLightData!: AmbientEnvironmentData;

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
      irradianceCubemap: jsonData.ambient.irradianceCubemap,
    };

    return true;
  }

  public update(): void {}

  public renderDebug(): void {}

  public stop(): void {
    console.log('ModuleEnvironmentManager stopped.');
  }

  public getAmbientLightData(): AmbientEnvironmentData {
    return this.ambientLightData;
  }
}
