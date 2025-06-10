import { Entity } from '../core/entity';
import { Interpolator } from '../interfaces/interpolator.interface';

export type MixedCamera = {
  cameraEntity: Entity;
  blendTime: number;
  interpolator: Interpolator;
  blendedWeight: number;
  appliedWeight: number;
  targetWeight: number;
};
