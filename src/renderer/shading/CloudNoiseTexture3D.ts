import { GPUUtils } from '../core/utils/GPUUtils';

/**
 * Tileable 3D "tri-noise" texture for volumetric cloud fog
 * (port of three.js webgpu_postprocessing_fog createNoise3DTexture).
 *
 * The original tri-noise is not periodic (its 1.8 / 1.2 octave multipliers break
 * integer periodicity), so sampling it with 'repeat' would show planar seams.
 * We make it tileable by blending the 8 unit-shifted copies with trilinear weights
 * (F(0) == F(1) on every axis) and renormalising by (Σw²)^0.25, which keeps the
 * variance constant across the tile instead of washing out the centre.
 *
 * Generated once on the CPU (~170 ms at 64³) and shared by every consumer.
 */
export class CloudNoiseTexture3D {
  private static readonly SIZE = 64;
  /** Mean of the raw noise, used as pivot for the variance-preserving blend. */
  private static readonly MEAN = 0.478;
  /** Normalisation exponent: 0.25 matches centre/edge std-dev (measured). */
  private static readonly VARIANCE_EXP = 0.25;

  private static texture: GPUTexture | null = null;
  private static view: GPUTextureView | null = null;
  private static sampler: GPUSampler | null = null;

  public static getView(): GPUTextureView {
    if (!this.view) this.create();
    return this.view!;
  }

  public static getSampler(): GPUSampler {
    if (!this.sampler) {
      this.sampler = GPUUtils.createSampler({
        label: 'cloud_noise_3d_sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
      });
    }
    return this.sampler;
  }

  public static destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.view = null;
    this.sampler = null;
  }

  private static create(): void {
    const N = this.SIZE;
    const data = new Uint8Array(N * N * N * 4); // rgba8unorm: R = noise, GBA unused
    let idx = 0;

    for (let z = 0; z < N; z++) {
      const w = z / N;
      for (let y = 0; y < N; y++) {
        const v = y / N;
        for (let x = 0; x < N; x++) {
          const u = x / N;

          let acc = 0;
          let w2 = 0;
          for (let c = 0; c < 8; c++) {
            const cx = c & 1;
            const cy = (c >> 1) & 1;
            const cz = c >> 2;
            const wt = (cx ? u : 1 - u) * (cy ? v : 1 - v) * (cz ? w : 1 - w);
            if (wt === 0) continue;
            acc += (this.cloudNoise(u - cx, v - cy, w - cz) - this.MEAN) * wt;
            w2 += wt * wt;
          }
          const val = this.MEAN + acc / Math.pow(w2, this.VARIANCE_EXP);

          data[idx] = Math.min(Math.max(val * 255, 0), 255);
          idx += 4;
        }
      }
    }

    const device = GPUUtils.getDevice();
    this.texture = device.createTexture({
      label: 'cloud_noise_3d',
      size: [N, N, N],
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.texture },
      data,
      { bytesPerRow: N * 4, rowsPerImage: N },
      [N, N, N],
    );
    this.view = this.texture.createView({ dimension: '3d' });
  }

  /** Two fractal tri-noise octaves, same weights as the three.js example. */
  private static cloudNoise(u: number, v: number, w: number): number {
    const n1 = this.triNoise(u * 4, v * 4, w * 4);
    const n2 = this.triNoise(u * 8 + 1.7, v * 8 + 0.9, w * 8 + 2.5) * 0.45;
    return (n1 + n2) * 1.15;
  }

  private static tri(x: number): number {
    return Math.abs(x - Math.floor(x) - 0.5);
  }

  private static triNoise(x: number, y: number, z: number): number {
    const tri = this.tri;
    let px = x,
      py = y,
      pz = z;
    let bx = x,
      by = y,
      bz = z;
    let zFactor = 1.4;
    let rz = 0;

    for (let i = 0; i < 4; i++) {
      const dgx = tri(bz * 2 + tri(by * 2));
      const dgy = tri(bz * 2 + tri(bx * 2));
      const dgz = tri(by * 2 + tri(bx * 2));
      px += dgx;
      py += dgy;
      pz += dgz;

      bx = bx * 1.8 + 0.14;
      by = by * 1.8 + 0.14;
      bz = bz * 1.8 + 0.14;

      zFactor *= 1.5;
      px *= 1.2;
      py *= 1.2;
      pz *= 1.2;

      rz += tri(pz + tri(px + tri(py))) / zFactor;
    }
    return rz;
  }
}
