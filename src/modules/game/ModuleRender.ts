import { CameraComponent } from "../../components/render/CameraComponent";
import { Engine } from "../../core/engine/Engine";
import { DeferredRenderer } from "../../renderer/core/DeferredRenderer";
import { Render } from "../../renderer/core/render";
import { RenderManager } from "../../renderer/core/RenderManager";
import { RenderToTexture } from "../../renderer/core/RenderToTexture";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Module } from "../core/Module";

export class ModuleRender extends Module {
  private deferred: DeferredRenderer;
  private deferredOutput: RenderToTexture;
  private shineOutput: RenderToTexture;
  private debugControlsAdded: boolean = false;

  // Debug values para Tweakpane
  private debugValues = {
    drawCallsSolids: { name: 'Draw Calls (Solids)', value: 0 },
    drawCallsTransparent: { name: 'Draw Calls (Transparent)', value: 0 },
    totalDrawCalls: { name: 'Total Draw Calls', value: 0 },
    resolution: { name: 'Resolution', value: '0x0' }
  };

  constructor(name: string) {
    super(name);
    this.deferred = new DeferredRenderer();
    this.deferredOutput = new RenderToTexture();
    this.shineOutput = new RenderToTexture();
  }

  public async start(): Promise<boolean> {
    this.setupDeferredOutput();
    this.onResolutionUpdated();
    return true;
  }

  private setupDeferredOutput(): void {
    if (this.deferredOutput.getWidth() !== Render.width || this.deferredOutput.getHeight() !== Render.height) {
      this.deferredOutput.createRT("g_deferred_output.dds", Render.width, Render.height, "rgba16float", "", true);
    }

    if (this.shineOutput.getWidth() !== Render.width || this.shineOutput.getHeight() !== Render.height) {
      this.shineOutput.createRT("g_shine_output.dds", Render.width, Render.height, "rgba16float");
    }
  }

  private onResolutionUpdated(): void {
    this.deferred.create(Render.width, Render.height);
  }

  public generateFrame(): void {
    const commandEncoder = Render.getInstance().beginFrame();
    if (!commandEncoder) return;

    const res = Render.getInstance().startRenderingBackBuffer(commandEncoder, { r: 0.2, g: 0.3, b: 0.4, a: 1 });
    if (!res) return;

    const mainCamera = Engine.getEntities().getEntityByName("MainCamera");
    if(!mainCamera) {
      console.error("Main camera not found!");
      return;
    }
    const cameraComponent = mainCamera.getComponent("camera") as CameraComponent;
    const camera = cameraComponent.getCamera();
    
    // Actualizar buffer uniforme global solo con view y projection
    Render.getInstance().updateGlobalUniforms(
      new Float32Array(camera.getView()),
      new Float32Array(camera.getProjection())
    );
    
    RenderManager.getInstance().setCamera(camera);
    RenderManager.getInstance().render(RenderCategory.SOLIDS);

    const pass = Render.getInstance().getPass();
    if (pass) {
      pass.end();
    }

    Render.getInstance().endFrame(commandEncoder);
  }

  public stop(): void {
    throw new Error("Method not implemented.");
  }

  public update(dt: number): void {
    // Actualizar valores de debug
    const renderManager = RenderManager.getInstance();
    this.debugValues.drawCallsSolids.value = renderManager.getDrawCallsForCategory(RenderCategory.SOLIDS);
    this.debugValues.drawCallsTransparent.value = renderManager.getDrawCallsForCategory(RenderCategory.TRANSPARENT);
    this.debugValues.totalDrawCalls.value = this.debugValues.drawCallsSolids.value + this.debugValues.drawCallsTransparent.value;
    this.debugValues.resolution.value = `${Render.width}x${Render.height}`;
  }

  public renderInMenu(): void {
    if (this.debugControlsAdded) return;

    // Render Stats
    this.addDebugControl(this.debugValues.drawCallsSolids, 'value', this.debugValues.drawCallsSolids.name);
    this.addDebugControl(this.debugValues.drawCallsTransparent, 'value', this.debugValues.drawCallsTransparent.name);
    this.addDebugControl(this.debugValues.totalDrawCalls, 'value', this.debugValues.totalDrawCalls.name);
    this.addDebugControl(this.debugValues.resolution, 'value', this.debugValues.resolution.name);

    this.debugControlsAdded = true;
  }

  public renderDebug(): void {
    throw new Error("Method not implemented.");
  }
}