export class Time {
    private lastTime: number = 0;
    private deltaTime: number = 0;
    private fps: number = 0;
    private frameCount: number = 0;
    private lastTimeFPSUpdate: number = 0;

    constructor() {
        this.lastTime = performance.now();
    }

    public update(): void {
        const currentTime = performance.now();
        this.deltaTime = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;
        this.lastTimeFPSUpdate += this.deltaTime;
        this.frameCount++;

        if (this.lastTimeFPSUpdate >= 1) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.lastTimeFPSUpdate = 0;
            this.updateFPSDisplay(this.fps);
        }
    }

    public getDeltaTime(): number {
        return this.deltaTime;
    }

    private updateFPSDisplay(fps: number): void {
        const fpsDisplay = document.getElementById("fps-display");
        if (fpsDisplay) {
            fpsDisplay.innerText = `FPS: ${fps}`;
        }
    }
}