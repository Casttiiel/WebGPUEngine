import { Loader } from '../../core/loaders/Loader';
import { Module } from '../core/Module';

export class ModuleBoot extends Module {
  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    const response = await fetch('/assets/scenes/scene.json');
    const jsonData = await response.json();

    await Loader.loadSceneFromJSON(jsonData);

    return true;
  }

  public stop(): void {
    throw new Error('Method not implemented.');
  }
  public update(dt: number): void {
    throw new Error('Method not implemented.');
  }
  public renderDebug(): void {
    throw new Error('Method not implemented.');
  }
}
