import { QualitySettings } from './QualitySettings';

export class Time {
  private static lastTimeFPSUpdate: number = 0;

  public static updateFPSDisplay(deltaTime: number): void {
    Time.lastTimeFPSUpdate += deltaTime;
    if (Time.lastTimeFPSUpdate >= 0.2) {
      Time.lastTimeFPSUpdate = 0;
      const fpsDisplay = document.getElementById('fps-display');
      if (fpsDisplay) {
        const currentQuality = QualitySettings.getInstance().getCurrentQualityName();
        fpsDisplay.innerText = `FPS: ${(1 / deltaTime).toFixed(1)} | Quality: ${currentQuality}`;
      }
      if (1 / deltaTime < 40) {
        console.log(
          'Low FPS detected! Consider lowering the graphics quality settings for a better experience.',
        );
      }
    }
  }
}
