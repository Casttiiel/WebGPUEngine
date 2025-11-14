import { Cubemap } from '../renderer/resources/Cubemap';

export interface AmbientEnvironmentData {
  globalFactor: number;
  diffuseFactor: number;
  reflectionFactor: number;
  irradianceCubemap: Cubemap;
}
