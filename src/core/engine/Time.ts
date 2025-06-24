export class Time {
  private static lastTimeFPSUpdate: number = 0;

  public static updateFPSDisplay(deltaTime: number): void {
    Time.lastTimeFPSUpdate += deltaTime;
    if (Time.lastTimeFPSUpdate >= 0.1) {
      Time.lastTimeFPSUpdate = 0;
      const fpsDisplay = document.getElementById('fps-display');
      if (fpsDisplay) {
        fpsDisplay.innerText = `FPS: ${(1 / deltaTime).toFixed(1)}. CPU: ${deltaTime.toFixed(2)}ms`;
      }
    }
  }
}
