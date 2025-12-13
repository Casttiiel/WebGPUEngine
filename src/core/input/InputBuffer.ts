import { GameAction } from '../../types/GameAction.enum';

/**
 * Entrada buffereada en espera de ser procesada
 */
interface BufferedInput {
  action: GameAction;
  timestamp: number; // Momento en que se registró la entrada (en milisegundos)
}

/**
 * InputBuffer - Sistema de buffering de inputs
 *
 * Permite registrar inputs antes de que puedan ser procesados,
 * dando una ventana de tiempo para que se procesen ("input buffering").
 *
 * Ejemplo: Si presionas salto 100ms antes de tocar el suelo,
 * el salto se ejecutará automáticamente al aterrizar.
 */
export class InputBuffer {
  private buffer: Map<GameAction, BufferedInput> = new Map();
  private bufferWindow: number = 150; // Ventana de tiempo en milisegundos (150ms por defecto)

  constructor(bufferWindowMs: number = 150) {
    this.bufferWindow = bufferWindowMs;
  }

  /**
   * Registra una acción en el buffer
   */
  public bufferAction(action: GameAction): void {
    const timestamp = performance.now();
    this.buffer.set(action, { action, timestamp });
  }

  /**
   * Verifica si una acción está en el buffer y aún es válida
   * @returns true si la acción está buffereada y no ha expirado
   */
  public isActionBuffered(action: GameAction): boolean {
    const buffered = this.buffer.get(action);
    if (!buffered) return false;

    const elapsed = performance.now() - buffered.timestamp;
    return elapsed <= this.bufferWindow;
  }

  /**
   * Consume una acción del buffer (la elimina)
   * @returns true si la acción estaba buffereada y se consumió
   */
  public consumeAction(action: GameAction): boolean {
    const wasBuffered = this.isActionBuffered(action);
    if (wasBuffered) {
      this.buffer.delete(action);
    }
    return wasBuffered;
  }

  /**
   * Limpia entradas expiradas del buffer
   * Debe llamarse cada frame
   */
  public update(): void {
    const now = performance.now();
    const expiredActions: GameAction[] = [];

    for (const [action, buffered] of this.buffer.entries()) {
      const elapsed = now - buffered.timestamp;
      if (elapsed > this.bufferWindow) {
        expiredActions.push(action);
      }
    }

    // Eliminar acciones expiradas
    for (const action of expiredActions) {
      this.buffer.delete(action);
    }
  }

  /**
   * Limpia completamente el buffer
   */
  public clear(): void {
    this.buffer.clear();
  }

  /**
   * Obtiene la ventana de buffer en milisegundos
   */
  public getBufferWindow(): number {
    return this.bufferWindow;
  }

  /**
   * Establece la ventana de buffer en milisegundos
   */
  public setBufferWindow(ms: number): void {
    this.bufferWindow = Math.max(0, ms);
  }

  /**
   * Obtiene el número de acciones actualmente buffereadas
   */
  public getBufferedCount(): number {
    // Solo contar las no expiradas
    let count = 0;
    for (const action of this.buffer.keys()) {
      if (this.isActionBuffered(action)) {
        count++;
      }
    }
    return count;
  }
}
