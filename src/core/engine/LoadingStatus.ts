/**
 * Gestiona el estado de carga y los mensajes mostrados durante el inicio del motor
 */
export class LoadingStatus {
  private static loaderElement: HTMLElement | null = null;
  private static textElement: HTMLElement | null = null;
  private static progressBarFill: HTMLElement | null = null;
  private static progressBarText: HTMLElement | null = null;
  private static errorElement: HTMLElement | null = null;
  private static currentProgress: number = 0;

  // Sistema de rango de progreso para tareas granulares
  private static progressRangeStart: number = 0;
  private static progressRangeEnd: number = 100;

  /**
   * Inicializa los elementos del DOM
   */
  public static initialize(): void {
    this.loaderElement = document.getElementById('loader-container');
    this.textElement = document.getElementById('loader-text');
    this.progressBarFill = document.getElementById('progress-bar-fill');
    this.progressBarText = document.getElementById('progress-bar-text');
    this.errorElement = document.getElementById('error-message');
    this.currentProgress = 0;
    this.progressRangeStart = 0;
    this.progressRangeEnd = 100;
    this.updateProgressBar(0);
  }

  /**
   * Actualiza el texto de carga y el progreso
   */
  public static updateStatus(message: string, progress?: number): void {
    if (this.textElement) {
      this.textElement.textContent = message;
    }
    if (progress !== undefined) {
      this.updateProgressBar(progress);
    }
  }

  /**
   * Actualiza la barra de progreso
   */
  private static updateProgressBar(progress: number): void {
    this.currentProgress = Math.max(0, Math.min(100, progress));

    if (this.progressBarFill) {
      this.progressBarFill.style.width = `${this.currentProgress}%`;
    }

    if (this.progressBarText) {
      this.progressBarText.textContent = `${Math.floor(this.currentProgress)}%`;
    }
  }

  /**
   * Obtiene el progreso actual
   */
  public static getProgress(): number {
    return this.currentProgress;
  }

  /**
   * Establece un rango de progreso para tareas granulares
   * @param start Progreso inicial del rango (0-100)
   * @param end Progreso final del rango (0-100)
   */
  public static setProgressRange(start: number, end: number): void {
    this.progressRangeStart = Math.max(0, Math.min(100, start));
    this.progressRangeEnd = Math.max(0, Math.min(100, end));
  }

  /**
   * Actualiza el progreso dentro del rango establecido
   * @param progress Progreso relativo dentro del rango (0-1)
   * @param message Mensaje opcional a mostrar
   */
  public static updateRangeProgress(progress: number, message?: string): void {
    progress = Math.max(0, Math.min(1, progress));
    const actualProgress =
      this.progressRangeStart + (this.progressRangeEnd - this.progressRangeStart) * progress;

    if (message) {
      this.updateStatus(message, actualProgress);
    } else {
      this.updateProgressBar(actualProgress);
    }
  }

  /**
   * Oculta el loader completamente
   */
  public static hide(): void {
    if (this.loaderElement) {
      this.loaderElement.classList.add('hidden');
    }
  }

  /**
   * Muestra el loader
   */
  public static show(): void {
    if (this.loaderElement) {
      this.loaderElement.classList.remove('hidden');
    }
  }

  /**
   * Muestra un mensaje de error y detiene el loader
   * @param error El error a mostrar
   */
  public static showError(error: Error | string): void {
    const errorMessage = error instanceof Error ? error.message : error;
    const errorStack = error instanceof Error ? error.stack : '';

    console.error('[Loading Error]', error);

    // Ocultar GIF y barra de progreso
    const loaderGif = document.getElementById('loader-gif');
    const progressBar = document.getElementById('progress-bar-container');
    if (loaderGif) loaderGif.style.display = 'none';
    if (progressBar) progressBar.style.display = 'none';

    // Actualizar texto principal
    if (this.textElement) {
      this.textElement.textContent = '❌ Engine Initialization Failed';
      this.textElement.style.color = '#ff0000';
    }

    // Mostrar mensaje de error detallado
    if (this.errorElement) {
      this.errorElement.innerHTML = `<strong>Error:</strong> ${errorMessage}\n\nPlease check the console for more details.`;
      this.errorElement.classList.remove('hidden');
    }
  }
}
