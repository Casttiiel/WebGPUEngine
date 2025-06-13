export class PerformanceDisplay {
  private static instance: PerformanceDisplay;
  private element: HTMLElement;

  private constructor() {
    this.element = document.getElementById('fps-display') as HTMLElement;
    if (!this.element) {
      throw new Error('Could not find fps-display element');
    }
  }

  public static getInstance(): PerformanceDisplay {
    if (!PerformanceDisplay.instance) {
      PerformanceDisplay.instance = new PerformanceDisplay();
    }
    return PerformanceDisplay.instance;
  }

  public update(info: {
    fps: number;
    cpuTime: number;
    gpuTime: number;
    frameTime: number;
    categories: Map<string, number>;
  }): void {
    let html = `FPS: ${info.fps.toFixed(1)}<br>`;
    html += `Frame: ${info.frameTime.toFixed(2)}ms<br>`;
    html += `CPU: ${info.cpuTime.toFixed(2)}ms<br>`;
    html += `GPU: ${info.gpuTime.toFixed(2)}ms<br>`;
    html += '<br>Categories:<br>';

    for (const [category, time] of info.categories.entries()) {
      html += `${category}: ${time.toFixed(2)}ms<br>`;
    }

    this.element.innerHTML = html;
  }
}
