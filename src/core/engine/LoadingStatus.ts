/**
 * Gestiona el estado de carga y los mensajes mostrados durante el inicio del motor
 */
export class LoadingStatus {
  private static loaderElement: HTMLElement | null = null;
  private static textElement: HTMLElement | null = null;
  private static progressBarFill: HTMLElement | null = null;
  private static progressBarText: HTMLElement | null = null;
  private static currentProgress: number = 0;

  /**
   * Inicializa los elementos del DOM
   */
  public static initialize(): void {
    this.loaderElement = document.getElementById('loader-container');
    this.textElement = document.getElementById('loader-text');
    this.progressBarFill = document.getElementById('progress-bar-fill');
    this.progressBarText = document.getElementById('progress-bar-text');
    this.currentProgress = 0;
    this.updateProgressBar(0);
  }

  /**
   * Actualiza el texto de carga y el progreso
   */
  public static updateStatus(message: string, progress?: number): void {
    if (this.textElement) {
      this.textElement.textContent = message;
      console.log(`[Loading] ${message} ${progress !== undefined ? `(${progress}%)` : ''}`);
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
}
