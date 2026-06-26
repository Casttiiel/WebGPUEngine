import { GPUUtils } from './utils/GPUUtils';

/**
 * Projects a captured cubemap into SH L2 irradiance coefficients on the CPU.
 *
 * Reads back each face via mapAsync, computes the 9 SH basis projections with
 * per-texel solid-angle weighting, then pre-multiplies the cosine-lobe convolution
 * factors (ẑ_l) so the returned coefficients can be evaluated directly with
 * evalSH(N) = Σ_k coef_k · Y_k(N) in the shader.
 *
 * Output: Float32Array(27) — 9 coefficients × 3 channels, layout: R0 G0 B0 R1 G1 B1 …
 */
export class SHProjector {
  public static async projectFromGPUTexture(
    texture: GPUTexture,
    faceSize: number,
  ): Promise<Float32Array> {
    const device = GPUUtils.getDevice();
    const bytesPerRow = faceSize * 8; // rgba16float = 8 bytes/pixel
    const faceBytes = bytesPerRow * faceSize;

    // 9 SH coefficients, each with 3 channels (R, G, B)
    const coefs: Float32Array[] = Array.from({ length: 9 }, () => new Float32Array(3));

    for (let face = 0; face < 6; face++) {
      const readBuf = device.createBuffer({
        size: faceBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture, origin: { x: 0, y: 0, z: face } },
        { buffer: readBuf, bytesPerRow },
        { width: faceSize, height: faceSize, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish()]);

      await readBuf.mapAsync(GPUMapMode.READ);
      const f16 = new Uint16Array(readBuf.getMappedRange());

      for (let row = 0; row < faceSize; row++) {
        for (let col = 0; col < faceSize; col++) {
          // Texel centre in [-1, 1]
          const sc = (col + 0.5) / faceSize * 2 - 1;
          const tc = (row + 0.5) / faceSize * 2 - 1;

          // Solid angle of this texel: dΩ = (2/N)² / (1+sc²+tc²)^(3/2)
          const lenSq = 1 + sc * sc + tc * tc;
          const dOmega = 4 / (faceSize * faceSize * Math.pow(lenSq, 1.5));

          const [nx, ny, nz] = SHProjector.faceDir(face, sc, tc);
          const Y = SHProjector.basis(nx, ny, nz);

          const p = (row * faceSize + col) * 4;
          const r = SHProjector.f16(f16[p]!);
          const g = SHProjector.f16(f16[p + 1]!);
          const b = SHProjector.f16(f16[p + 2]!);

          for (let k = 0; k < 9; k++) {
            const w = Y[k] * dOmega;
            coefs[k]![0] += r * w;
            coefs[k]![1] += g * w;
            coefs[k]![2] += b * w;
          }
        }
      }

      readBuf.unmap();
      readBuf.destroy();
    }

    // Pre-multiply cosine-lobe convolution factors (ẑ_l) so the shader can
    // evaluate irradiance with a plain polynomial: E(N) = Σ_k coef_k · Y_k(N).
    // Band 0: π,  Band 1: 2π/3,  Band 2: π/4
    const PI = Math.PI;
    const conv = [PI, 2 * PI / 3, 2 * PI / 3, 2 * PI / 3, PI / 4, PI / 4, PI / 4, PI / 4, PI / 4];
    for (let k = 0; k < 9; k++) {
      coefs[k]![0] *= conv[k]!;
      coefs[k]![1] *= conv[k]!;
      coefs[k]![2] *= conv[k]!;
    }

    // Pack: R0 G0 B0  R1 G1 B1  …  R8 G8 B8  (27 floats)
    const out = new Float32Array(27);
    for (let k = 0; k < 9; k++) {
      out[k * 3] = coefs[k]![0];
      out[k * 3 + 1] = coefs[k]![1];
      out[k * 3 + 2] = coefs[k]![2];
    }
    return out;
  }

  // ── Cubemap face → normalised 3D direction ────────────────────────────────

  private static faceDir(face: number, sc: number, tc: number): [number, number, number] {
    let x: number, y: number, z: number;
    switch (face) {
      case 0:  x =  1; y = -tc; z = -sc; break; // +X
      case 1:  x = -1; y = -tc; z =  sc; break; // -X
      case 2:  x =  sc; y =  1; z =  tc; break; // +Y
      case 3:  x =  sc; y = -1; z = -tc; break; // -Y
      case 4:  x =  sc; y = -tc; z =  1; break; // +Z
      default: x = -sc; y = -tc; z = -1; break; // -Z
    }
    const len = Math.sqrt(x * x + y * y + z * z);
    return [x / len, y / len, z / len];
  }

  // ── Real spherical harmonics basis (L0–L2, 9 functions) ──────────────────

  private static basis(x: number, y: number, z: number): number[] {
    return [
      0.282095,                              // Y00  (l=0)
      0.488603 * y,                          // Y1-1 (l=1)
      0.488603 * z,                          // Y10
      0.488603 * x,                          // Y11
      1.092548 * x * y,                      // Y2-2 (l=2)
      1.092548 * y * z,                      // Y2-1
      0.315392 * (3 * z * z - 1),           // Y20
      1.092548 * x * z,                      // Y21
      0.546274 * (x * x - y * y),           // Y22
    ];
  }

  // ── Float16 → Float32 conversion ─────────────────────────────────────────

  private static f16(h: number): number {
    const sign = (h & 0x8000) >> 15;
    const exp = (h & 0x7c00) >> 10;
    const frac = h & 0x03ff;
    if (exp === 0) return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
    if (exp === 0x1f) return frac ? NaN : (sign ? -1 : 1) * Infinity;
    return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
  }
}
