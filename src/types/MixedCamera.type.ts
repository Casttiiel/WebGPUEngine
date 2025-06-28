import { Entity } from '../core/ecs/Entity';
import { Interpolator } from './Interpolator.interface';

export type MixedCamera = {
  cameraEntity: Entity;
  blendTime: number;
  interpolator: Interpolator;
  blendedWeight: number;
  appliedWeight: number;
  targetWeight: number;
};
