import { AlchemistPower, AlchemistPowerConfig } from './AlchemistPower';

type PowerConstructor = new (config: AlchemistPowerConfig) => AlchemistPower;

const registry = new Map<string, PowerConstructor>();

/**
 * Register a concrete power class under its type key.
 * Call this at module-load time in each power's file:
 *   AlchemistPowerFactory.register('fire_bolt', FireBoltPower);
 */
export function registerPower(type: string, ctor: PowerConstructor): void {
  registry.set(type, ctor);
}

export function createPower(config: AlchemistPowerConfig): AlchemistPower | null {
  const Ctor = registry.get(config.type);
  if (!Ctor) {
    console.warn(`AlchemistPowerFactory: unknown power type "${config.type}"`);
    return null;
  }
  return new Ctor(config);
}
