import { Component } from '../../core/ecs/Component';

/**
 * PlayerModifiersComponent - Gestiona powerups y modificadores del jugador
 * Placeholder para futura implementación de:
 * - Eco de Inercia
 * - Eco de Rebote
 * - Eco Cinético
 */
export class PlayerModifiersComponent extends Component {
  private activeModifiers: Map<string, boolean> = new Map();

  public async load(data: unknown): Promise<void> {
    // TODO: Implementar carga de modificadores
  }

  public update(dt: number): void {
    // TODO: Implementar actualización de modificadores
  }

  public renderDebug(): void {
    // TODO: Implementar debug de modificadores
  }

  public dispose(): void {
    this.activeModifiers.clear();
  }

  // Métodos placeholder para los sistemas
  public notifyPerfectAction?(): void {
    // TODO: Implementar sistema de combos
  }

  public hasModifier(modifierId: string): boolean {
    return this.activeModifiers.get(modifierId) || false;
  }

  public addModifier(modifierId: string): void {
    this.activeModifiers.set(modifierId, true);
  }

  public removeModifier(modifierId: string): void {
    this.activeModifiers.delete(modifierId);
  }
}
