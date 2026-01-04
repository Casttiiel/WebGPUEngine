import { QualitySettings } from './QualitySettings';

export class Time {
  private static lastTimeFPSUpdate: number = 0;
  private static timeScale: number = 1.0; // 0 = pausado, 1 = normal, otros valores = slow-motion/fast-forward
  private static isPaused: boolean = false;

  /**
   * Obtiene el timeScale actual (multiplicador de tiempo)
   * @returns El timeScale (0 = pausado, 1 = normal)
   */
  public static getTimeScale(): number {
    return Time.timeScale;
  }

  /**
   * Establece el timeScale (multiplicador de tiempo)
   * @param scale - El nuevo timeScale (0 = pausado, 1 = normal, 0.5 = slow-motion, 2 = fast-forward)
   */
  public static setTimeScale(scale: number): void {
    Time.timeScale = Math.max(0, scale); // No permitir valores negativos
    Time.isPaused = Time.timeScale === 0;
  }

  /**
   * Pausa el juego (timeScale = 0)
   */
  public static pause(): void {
    Time.timeScale = 0;
    Time.isPaused = true;
    console.log('Game paused');
  }

  /**
   * Reanuda el juego (timeScale = 1)
   */
  public static resume(): void {
    Time.timeScale = 1.0;
    Time.isPaused = false;
    console.log('Game resumed');
  }

  /**
   * Alterna entre pausado y reanudado
   */
  public static togglePause(): void {
    if (Time.isPaused) {
      Time.resume();
    } else {
      Time.pause();
    }
  }

  /**
   * Verifica si el juego está pausado
   * @returns true si está pausado, false si no
   */
  public static isGamePaused(): boolean {
    return Time.isPaused;
  }

  public static updateFPSDisplay(deltaTime: number): void {
    Time.lastTimeFPSUpdate += deltaTime;
    if (Time.lastTimeFPSUpdate >= 0.2) {
      Time.lastTimeFPSUpdate = 0;
      const fpsDisplay = document.getElementById('fps-display');
      if (fpsDisplay) {
        const currentQuality = QualitySettings.getInstance().getCurrentQualityName();
        const pauseIndicator = Time.isPaused ? ' [PAUSED]' : '';
        fpsDisplay.innerText = `FPS: ${(1 / deltaTime).toFixed(1)} | Quality: ${currentQuality}${pauseIndicator}`;
      }
      if (1 / deltaTime < 40) {
        console.log(
          'Low FPS detected! Consider lowering the graphics quality settings for a better experience.',
        );
      }
    }
  }
}
