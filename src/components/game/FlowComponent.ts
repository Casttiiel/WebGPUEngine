import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponent } from './CharacterControllerComponent';

export interface FlowComponentData {
  flowDecayRate?: number;
  flowGainThreshold?: number;
  energyThresholdPerLevel?: number;
  enabled?: boolean;
}

/**
 * FlowComponent - Sistema de momentum y multiplicadores de movimiento
 *
 * FLOW = multiplicador de potencial de movimiento desbloqueado por continuidad espacial
 *
 * Se gana FLOW por:
 * - Transformar energía (caída → horizontal, pared → horizontal)
 * - Conservar velocidad alta sin interrupciones
 * - Mantener dirección consistente
 *
 * Se pierde FLOW por:
 * - Colisiones duras
 * - Detenerse completamente
 * - Decay pasivo
 */
export class FlowComponent extends Component {
  // Estado
  private flowLevel: number = 0; // 0-5
  private flowEnergy: number = 0.0; // Acumulador suave para subir de nivel
  private previousVelocity: vec3 = vec3.create(); // Para detectar conservación de dirección

  // Configuración
  private flowDecayRate: number = 1.0; // FLOW/segundo de decay pasivo
  private flowGainThreshold: number = 8.0; // Velocidad mínima para empezar a ganar flow
  private energyThresholdPerLevel: number = 100.0; // Energía acumulada necesaria para subir nivel
  private enabled: boolean = true;

  // Multiplicadores por nivel (tabla de diseño)
  // FLOW 0: 100%, FLOW 1: 110%, FLOW 2: 125%, FLOW 3: 145%, FLOW 4: 170%, FLOW 5: 200%
  private speedMultipliers: number[] = [1.0, 1.1, 1.25, 1.45, 1.7, 2.0];
  private jumpMultipliers: number[] = [1.0, 1.1, 1.2, 1.35, 1.5, 1.7];

  // Referencias
  private characterController: CharacterControllerComponent | null = null;
  private initialized: boolean = false;

  constructor() {
    super();
  }

  public async load(data: FlowComponentData): Promise<void> {
    if (data.flowDecayRate !== undefined) {
      this.flowDecayRate = data.flowDecayRate;
    }
    if (data.flowGainThreshold !== undefined) {
      this.flowGainThreshold = data.flowGainThreshold;
    }
    if (data.energyThresholdPerLevel !== undefined) {
      this.energyThresholdPerLevel = data.energyThresholdPerLevel;
    }
    if (data.enabled !== undefined) {
      this.enabled = data.enabled;
    }
  }

  public update(dt: number): void {
    if (!this.enabled) return;

    // Lazy initialization: buscar CharacterController
    if (!this.initialized) {
      this.characterController = this.getOwner().getComponent(
        'character_controller',
      ) as CharacterControllerComponent;

      if (!this.characterController) {
        console.warn('FlowComponent: No CharacterController found on owner');
        return;
      }

      this.initialized = true;
    }

    if (!this.characterController) return;

    // TODO: Implementar lógica de flow
    // - evaluateFlowGain()
    // - evaluateFlowLoss(dt)
    // - updateFlowLevel()

    // Guardar velocidad actual para próximo frame
    vec3.copy(this.previousVelocity, this.characterController.getCurrentHorizontalVelocity());
  }

  // ==================== GETTERS PÚBLICOS ====================

  /**
   * Obtiene el multiplicador de velocidad según el nivel de flow actual
   */
  public getSpeedMultiplier(): number {
    return this.speedMultipliers[this.flowLevel] ?? 1.0;
  }

  /**
   * Obtiene el multiplicador de salto según el nivel de flow actual
   */
  public getJumpMultiplier(): number {
    return this.jumpMultipliers[this.flowLevel] ?? 1.0;
  }

  /**
   * Obtiene el nivel de flow actual (0-5)
   */
  public getFlowLevel(): number {
    return this.flowLevel;
  }

  /**
   * Obtiene la energía acumulada actual
   */
  public getFlowEnergy(): number {
    return this.flowEnergy;
  }

  /**
   * Verifica si el sistema está habilitado
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  // ==================== DEBUG UI ====================

  public override renderInMenu(): void {}

  public renderDebug(): void {
    // TODO: Visualización debug en mundo 3D
    // - Barra de flow sobre personaje
    // - Trail de color según nivel
  }

  public dispose(): void {
    // Cleanup si es necesario
  }
}
