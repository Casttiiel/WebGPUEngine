import { Module } from '../../modules/core/Module';

export class Gamestate {
  public name: string = '';
  public modules: Module[] = [];

  constructor(name: string) {
    this.name = name;
  }

  public push(module: Module): void {
    this.modules.push(module);
  }

  public [Symbol.iterator](): IterableIterator<Module> {
    return this.modules[Symbol.iterator]();
  }
}
