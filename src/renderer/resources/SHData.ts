import { BaseResource } from '../../core/resources/IResource';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { ResourceType } from '../../types/ResourceType.enum';

/**
 * SH L2 irradiance coefficients for a single probe.
 * Loaded from `assets/probes/{name}_sh.json` which contains 27 floats:
 * 9 SH basis coefficients × 3 RGB channels.
 * The cosine-lobe convolution factors are pre-baked in so the shader can
 * evaluate diffuse irradiance directly as E(N) = Σ_k coef_k · Y_k(N).
 */
export class SHData extends BaseResource {
  private coefficients: Float32Array | null = null;

  private constructor(path: string) {
    super({ path, type: ResourceType.SH_DATA });
  }

  /** Non-blocking — starts loading in the background, returns immediately. */
  public static get(path: string): SHData {
    try {
      return ResourceManager.getResource<SHData>(path);
    } catch {
      const sh = new SHData(path);
      ResourceManager.registerResource(sh);
      sh.load();
      return sh;
    }
  }

  /** Async — resolves once the JSON is fetched and parsed. Throws on 404. */
  public static async getAsync(path: string): Promise<SHData> {
    try {
      return ResourceManager.getResource<SHData>(path);
    } catch {
      const sh = new SHData(path);
      ResourceManager.registerResource(sh);
      try {
        await sh.loadAsync();
      } catch (e) {
        ResourceManager.unregisterResource(path);
        throw e;
      }
      return sh;
    }
  }

  /** Synchronous entry-point required by BaseResource — fires loadAsync and ignores the promise. */
  public override load(): void {
    this.loadAsync().catch((err) => {
      console.error(`[SHData] failed to load ${this.path}:`, err);
    });
  }

  public async loadAsync(): Promise<void> {
    const response = await ResourceManager.fetch(`assets/probes/${this.path}`);
    if (!response.ok) throw new Error(`SHData: HTTP ${response.status} for ${this.path}`);
    const json = (await response.json()) as { sh: number[] };
    this.coefficients = new Float32Array(json.sh);
    this.setHasData();
  }

  /** Returns the 27-float coefficient array (R0 G0 B0 … R8 G8 B8), or null while loading. */
  public getCoefficients(): Float32Array | null {
    return this.coefficients;
  }
}
