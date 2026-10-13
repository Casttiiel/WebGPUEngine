import { ResourceManager } from '../../core/engine/ResourceManager';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { GPUUtils } from '../core/utils/GPUUtils';
import { MipmapGenerator } from '../core/processing/MipmapGenerator';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { HDRTexture } from './HDRTexture';

export interface CubemapOptions extends IGPUResourceOptions {
  magFilter?: GPUFilterMode;
  minFilter?: GPUFilterMode;
  mipmapFilter?: GPUFilterMode;
  addressModeU?: GPUAddressMode;
  addressModeV?: GPUAddressMode;
  addressModeW?: GPUAddressMode;
  maxAnisotropy?: number;
  /** Base fetch directory. Defaults to 'assets/textures'. */
  baseFolder?: string;
}

export class Cubemap extends GPUResource {
  private gpuTexture?: GPUTexture;
  private gpuTextureView?: GPUTextureView;
  private gpuSampler?: GPUSampler;
  private readonly baseFolder: string;

  constructor(options: CubemapOptions) {
    super({
      ...options,
      type: ResourceType.CUBEMAP,
    });
    this.baseFolder = options.baseFolder ?? 'assets/textures';
  }

  public static get(path: string, options: Partial<CubemapOptions> = {}): Cubemap {
    path = Cubemap.resourceKey(path);
    try {
      return ResourceManager.getResource<Cubemap>(path);
    } catch {
      const cubemap = new Cubemap({
        path,
        type: ResourceType.CUBEMAP,
        ...options,
      });

      // Register first to prevent race conditions
      ResourceManager.registerResource(cubemap);

      // Start loading without await (non-blocking)
      cubemap.load();

      return cubemap;
    }
  }

  public static async getAsync(
    path: string,
    options: Partial<CubemapOptions> = {},
  ): Promise<Cubemap> {
    path = Cubemap.resourceKey(path);
    try {
      return ResourceManager.getResource<Cubemap>(path);
    } catch {
      const cubemap = new Cubemap({
        path,
        type: ResourceType.CUBEMAP,
        ...options,
      });

      // Register first to prevent race conditions
      ResourceManager.registerResource(cubemap);

      try {
        await cubemap.loadAsync();
      } catch (e) {
        // Unregister so future calls can retry cleanly instead of returning a broken cubemap
        ResourceManager.unregisterResource(path);
        throw e;
      }
      return cubemap;
    }
  }

  // An .hdr source is also registered as an HDRTexture under its own path (e.g. as the skybox),
  // and ResourceManager keys by path alone — so the cubemap built from it gets its own key.
  private static readonly HDR_SUFFIX = '#cube';

  private static resourceKey(path: string): string {
    return path.toLowerCase().endsWith('.hdr') ? path + Cubemap.HDR_SUFFIX : path;
  }

  public async loadAsync(): Promise<void> {
    if (this.path.endsWith(Cubemap.HDR_SUFFIX)) {
      await this.loadFromEquirectHDR();
      return;
    }
    try {
      const image = await createImageBitmap(
        await ResourceManager.fetch(`${this.baseFolder}/${this.path}`).then((r) => r.blob()),
      );

      const faceSize = image.width / 4; // Asumimos imagen 4x3 caras
      // T-layout face positions: col, row in a 4×3 grid.
      const faceCoords: [number, number][] = [
        [2, 1], // +X
        [0, 1], // -X
        [1, 0], // +Y
        [1, 2], // -Y
        [1, 1], // +Z
        [3, 1], // -Z
      ];

      // Crop each face using createImageBitmap's built-in crop — runs off-thread,
      // no synchronous drawImage/canvas work on the main thread.
      const faces = await Promise.all(
        faceCoords.map(([col, row]) =>
          createImageBitmap(image, col * faceSize, row * faceSize, faceSize, faceSize),
        ),
      );

      // Calcular niveles de mipmap
      const mipLevelCount = Math.floor(Math.log2(Math.max(faceSize, faceSize))) + 1; // Crear la textura en GPU

      const skyboxFormat = QualitySettings.getInstance().getSettings().generalTexture;

      this.gpuTexture = GPUUtils.createCubemapTexture(
        `${this.label}_texture`,
        faceSize,
        skyboxFormat,
        GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.STORAGE_BINDING,
        mipLevelCount,
      );

      // Copiar cada cara al nivel 0 de mipmap
      for (let i = 0; i < 6; i++) {
        if (!faces[i]) {
          throw new Error(`Face image for index ${i} is undefined`);
        }
        this.device.queue.copyExternalImageToTexture(
          { source: faces[i] as ImageBitmap },
          {
            texture: this.gpuTexture,
            origin: { x: 0, y: 0, z: i },
            mipLevel: 0,
          },
          [faceSize, faceSize],
        );
      }

      // Generate mipmaps for the cubemap if more than 1 mip level
      if (mipLevelCount > 1) {
        const mipmapGenerator = MipmapGenerator.getInstance();
        await mipmapGenerator.initialize();
        await mipmapGenerator.generateMipmapsForCubemap(this.gpuTexture, mipLevelCount);
      }

      // Crear la vista de la textura
      this.gpuTextureView = this.gpuTexture.createView({
        label: `${this.label}_textureView`,
        dimension: 'cube',
        baseMipLevel: 0,
        mipLevelCount: mipLevelCount,
      });

      this.gpuSampler = SamplerLibrary.environmentCubemap;

      // Mark as loaded when loadAsync completes
      this.setHasData();
    } catch (error) {
      throw new Error(`Failed to create GPU resources for cubemap ${this.path}: ${error}`);
    }
  }

  /**
   * Builds the cubemap from an equirectangular .hdr (same mapping as skybox.fs, so reflections
   * line up with the visible sky). Faces are rgba16float at EQUIRECT_FACE_SIZE — the size of the
   * baked PNG cubemaps — so the roughness → mip mapping of the IBL/SSR lookups is unchanged.
   */
  private async loadFromEquirectHDR(): Promise<void> {
    const hdr = await HDRTexture.getAsync(this.path.slice(0, -Cubemap.HDR_SUFFIX.length));
    const faceSize = Cubemap.EQUIRECT_FACE_SIZE;
    const mipLevelCount = Math.floor(Math.log2(faceSize)) + 1;
    const format: GPUTextureFormat = 'rgba16float';

    this.gpuTexture = GPUUtils.createCubemapTexture(
      `${this.label}_texture`,
      faceSize,
      format,
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC | // read back for the SH projection
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.STORAGE_BINDING,
      mipLevelCount,
    );

    const module = this.device.createShaderModule({
      label: 'equirect_to_cubemap',
      code: Cubemap.EQUIRECT_TO_CUBE_WGSL,
    });
    const pipeline = await this.device.createComputePipelineAsync({
      label: 'equirect_to_cubemap',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindGroup = this.device.createBindGroup({
      label: `${this.label}_equirect_bg`,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: hdr.getTextureView()! },
        { binding: 1, resource: hdr.getSampler()! },
        {
          binding: 2,
          resource: this.gpuTexture.createView({
            dimension: '2d-array',
            baseMipLevel: 0,
            mipLevelCount: 1,
          }),
        },
      ],
    });

    const encoder = this.device.createCommandEncoder({ label: 'equirect_to_cubemap' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(faceSize / 8), Math.ceil(faceSize / 8), 6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    const mipmapGenerator = MipmapGenerator.getInstance();
    await mipmapGenerator.initialize();
    await mipmapGenerator.generateMipmapsForCubemap(this.gpuTexture, mipLevelCount);

    this.gpuTextureView = this.gpuTexture.createView({
      label: `${this.label}_textureView`,
      dimension: 'cube',
      baseMipLevel: 0,
      mipLevelCount,
    });
    this.gpuSampler = SamplerLibrary.environmentCubemap;
    this.setHasData();
  }

  private static readonly EQUIRECT_FACE_SIZE = 512;

  // Face directions follow the WebGPU cube convention (+X, -X, +Y, -Y, +Z, -Z), so sampling the
  // cube with a world direction returns the equirect texel skybox.fs shows in that direction.
  // Radiance is clamped to 16 like skybox.fs so the sun doesn't bleed through every box-filtered mip.
  private static readonly EQUIRECT_TO_CUBE_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265359;

@group(0) @binding(0) var equirect: texture_2d<f32>;
@group(0) @binding(1) var equirectSampler: sampler;
@group(0) @binding(2) var outFaces: texture_storage_2d_array<rgba16float, write>;

fn faceDirection(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let a = uv.x * 2.0 - 1.0;
    let b = uv.y * 2.0 - 1.0;
    switch face {
        case 0u: { return vec3<f32>( 1.0, -b, -a); }
        case 1u: { return vec3<f32>(-1.0, -b,  a); }
        case 2u: { return vec3<f32>( a,  1.0,  b); }
        case 3u: { return vec3<f32>( a, -1.0, -b); }
        case 4u: { return vec3<f32>( a, -b,  1.0); }
        default: { return vec3<f32>(-a, -b, -1.0); }
    }
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = textureDimensions(outFaces);
    if (gid.x >= size.x || gid.y >= size.y) { return; }
    let uv  = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size);
    let dir = normalize(faceDirection(gid.z, uv));
    // Same mapping as direction_to_equirect_uv (common/math/coordinates.wgsl)
    let eq = vec2<f32>((atan2(dir.x, dir.z) + PI) / (2.0 * PI), acos(clamp(dir.y, -1.0, 1.0)) / PI);
    let c  = textureSampleLevel(equirect, equirectSampler, eq, 0.0).rgb;
    textureStore(outFaces, vec2<i32>(gid.xy), i32(gid.z), vec4<f32>(min(c, vec3<f32>(16.0)), 1.0));
}
`;

  public override load(): void {
    // Síncrono: inicia la carga sin await
    this.loadAsync().catch((error) => {
      console.error(`Error loading cubemap ${this.path}:`, error);
    });
  }

  public getTexture(): GPUTexture | undefined {
    return this.gpuTexture;
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.gpuTextureView;
  }

  public getSampler(): GPUSampler | undefined {
    return this.gpuSampler;
  }
}
