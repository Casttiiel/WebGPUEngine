import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
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
  private flowLevel: number = 0; // 0-4
  private flowEnergy: number = 0.0; // Acumulador suave para subir de nivel

  // Configuración
  private energyThresholdPerLevel: number = 100.0; // Energía acumulada necesaria para subir nivel
  private enabled: boolean = true;

  // Multiplicadores por nivel (tabla de diseño)
  private speedMultipliers: number[] = [1.0, 1.1, 1.25, 1.45, 1.7];
  private startingActions: string[] = ['mantle', 'impulse_pad', 'swing_bar'];

  // Referencias
  private characterController: CharacterControllerComponent | null = null;
  private initialized: boolean = false;

  constructor() {
    super();
  }

  public async load(data: FlowComponentData): Promise<void> {
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

    //this.updateFlowLevel();
  }

  /*private evaluateFlowLoss(dt: number): void {
    const currentSpeed = this.characterController!.getCurrentSpeed();

    // Pérdida rápida si te detienes
    if (currentSpeed < 1.0) {
      this.flowEnergy -= this.flowDecayRate * dt * 20; // Decay rápido al parar
    }

    // Decay pasivo siempre activo (lento)
    this.flowEnergy -= this.flowDecayRate * dt;

    // No permitir energía negativa
    this.flowEnergy = Math.max(0, this.flowEnergy);
  }*/

  private updateFlowLevel(): void {
    // Subir de nivel
    while (
      this.flowLevel < 5 &&
      this.flowEnergy >= (this.flowLevel + 1) * this.energyThresholdPerLevel
    ) {
      this.flowLevel++;
      console.log(`💨 FLOW UP! Nivel ${this.flowLevel}`);
    }

    // Bajar de nivel
    while (this.flowLevel > 0 && this.flowEnergy < this.flowLevel * this.energyThresholdPerLevel) {
      this.flowLevel--;
      console.log(`💧 FLOW DOWN! Nivel ${this.flowLevel}`);
    }
  }

  // ==================== NOTIFICACIONES DE ACCIONES ====================

  /**
   * Notifica que se ha realizado una acción especial que debe dar flow
   * Si flow = 0, estas acciones dan +1 flow instantáneo
   * Si flow > 0, dan energía progresiva
   */
  public notifyAction(actionType: string): void {
    if (!this.enabled) return;

    // Si flow es 0, dar 1 flow instantáneo
    if (this.flowLevel === 0 && this.startingActions.includes(actionType)) {
      this.flowLevel = 1;
      this.flowEnergy = 0.0;
      console.log(`✨ FLOW INICIADO por ${actionType}! Nivel 1`);
    } else {
      // Si ya tienes flow, añadir energía progresiva
      const energyGain = this.energyThresholdPerLevel * 0.3; // 30% de umbral por acción
      this.flowEnergy += energyGain;
      console.log(`🔥 Flow boost por ${actionType}! +${energyGain.toFixed(0)} energía`);
    }
  }

  public resetFlow(reason: string): void {
    if (this.flowLevel > 0 || this.flowEnergy > 0) {
      console.log(`💥 FLOW PERDIDO: ${reason}`);
      this.flowLevel = 0;
      this.flowEnergy = 0;
    }
  }

  public penalizeFlow(reason: string, amount: number): void {
    this.flowEnergy = Math.max(0, this.flowEnergy - amount);
    console.log(`⚠️ Flow penalizado: ${reason} (-${amount})`);
  }

  public getSpeedMultiplier(): number {
    return this.speedMultipliers[this.flowLevel] ?? 1.0;
  }

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
