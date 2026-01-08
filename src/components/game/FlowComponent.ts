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
  private lastAction: string = ''; // Última acción realizada (para prevenir spam)

  // Configuración
  // Umbrales de energía por nivel (cada acción da 50 energía)
  // Nivel 0→1: 100 (2 acciones), 1→2: 150 (3 acciones), 2→3: 200 (4 acciones), 3→4: 250 (5 acciones)
  private energyThresholdsPerLevel: number[] = [100, 150, 200, 250]; // Índice = nivel actual
  private energyPerAction: number = 50.0; // Energía que da cada acción
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
    if (this.flowEnergy >= this.energyThresholdsPerLevel[this.flowLevel]) {
      this.flowEnergy = 0.0;
      this.flowLevel++;
      console.log(`🚀 FLOW SUBIÓ a nivel ${this.flowLevel}!`);
    }
  }

  // ==================== NOTIFICACIONES DE ACCIONES ====================

  /**
   * Notifica que se ha realizado una acción especial que debe dar flow
   * Si flow = 0, estas acciones dan +1 flow instantáneo
   * Si flow > 0, dan energía progresiva
   * NO se gana flow si se repite la misma acción consecutivamente
   */
  public notifyAction(actionType: string): void {
    if (!this.enabled) return;

    // Prevenir spam de la misma acción
    if (this.lastAction === actionType) {
      console.log(`⛔ No flow gain: repeated action "${actionType}"`);
      return;
    }

    // Actualizar última acción
    this.lastAction = actionType;

    // Si flow es 0 y es una acción inicial, dar nivel 1 instantáneo
    if (this.flowLevel === 0 && this.startingActions.includes(actionType)) {
      this.flowLevel = 1;
      this.flowEnergy = 0.0;
      console.log(`✨ FLOW INICIADO por ${actionType}! Nivel 1 (saltando requisito de 2 acciones)`);
    } else {
      // Si ya tienes flow, añadir energía progresiva
      this.flowEnergy += this.energyPerAction;
      console.log(
        `🔥 Flow boost por ${actionType}! +${this.energyPerAction.toFixed(0)} energía (Total: ${this.flowEnergy.toFixed(0)})`,
      );

      // Actualizar nivel basado en energía
      this.updateFlowLevel();
    }
  }

  public resetFlow(reason: string): void {
    if (this.flowLevel > 0 || this.flowEnergy > 0) {
      console.log(`💥 FLOW PERDIDO: ${reason}`);
      this.flowLevel = 0;
      this.flowEnergy = 0;
      this.lastAction = ''; // Resetear última acción también
    }
  }

  public penalizeFlow(reason: string, amount: number): void {
    this.flowEnergy -= amount;
    console.log(`⚠️ Flow penalizado: ${reason} (-${amount})`);

    // Actualizar nivel si la energía bajó suficiente
    this.updateFlowLevel();
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
