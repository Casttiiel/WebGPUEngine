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
    // ModuleBoot doesn't need cleanup - it's just initialization
    console.log('ModuleBoot stopped.');
  }

  public update(): void {
    // ModuleBoot doesn't need per-frame updates
  }

  public renderDebug(): void {
    // ModuleBoot doesn't have debug info to render
  }
}
