import { RenderPassConfig } from './BaseRenderPass';
import { RenderTarget } from '../../resources/RenderTarget';

/**
 * Utility class for creating common render pass configurations
 */
export class RenderPassFactory {
  /**
   * Creates a depth prepass render pass configuration
   */
  public static createDepthPrepassConfig(
    depthView: GPUTextureView,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    // Create color attachment for linear depth output
    const colorAttachments: GPURenderPassColorAttachment[] = [];

    return {
      label: 'Depth Prepass',
      colorAttachments,
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
      viewport,
    };
  }

  /**
   * Creates a G-Buffer render pass configuration
   */
  public static createGBufferPassConfig(
    albedos: RenderTarget,
    normals: RenderTarget,
    linearDepth: RenderTarget,
    prepassDepthView: GPUTextureView,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    // Create color attachments for albedo, normal (octahedral), and linear depth
    const colorAttachments: GPURenderPassColorAttachment[] = [
      {
        view: albedos.getRenderView()!,
        clearValue: { r: 1, g: 1, b: 1, a: 1 }, // White for albedo
        loadOp: 'clear',
        storeOp: 'store',
      },
      {
        view: normals.getRenderView()!,
        clearValue: { r: 0.5, g: 0.5, b: 0.0, a: 0.0 }, // Neutral octahedral normal
        loadOp: 'clear',
        storeOp: 'store',
      },
      {
        view: linearDepth.getRenderView()!,
        clearValue: { r: 1.0, g: 0.0, b: 0.0, a: 0.0 }, // Far depth
        loadOp: 'clear',
        storeOp: 'store',
      },
    ];

    return {
      label: 'G-Buffer Pass',
      colorAttachments,
      depthStencilAttachment: {
        view: prepassDepthView,
        depthLoadOp: 'load', // reuse depth written by the depth prepass
        depthStoreOp: 'store',
      },
      viewport,
    };
  }

  /**
   * Creates a decals render pass configuration
   */
  public static createDecalPassConfig(
    albedos: RenderTarget,
    normals: RenderTarget,
    prepassDepthView: GPUTextureView,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    // Create color attachments for albedo and normal only
    // Linear depth is read-only via bind group, not written
    const colorAttachments: GPURenderPassColorAttachment[] = [
      {
        view: albedos.getRenderView()!,
        loadOp: 'load',
        storeOp: 'store',
      },
      {
        view: normals.getRenderView()!,
        loadOp: 'load',
        storeOp: 'store',
      },
    ];

    return {
      label: 'Decal Pass',
      colorAttachments,
      depthStencilAttachment: {
        view: prepassDepthView,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
      viewport,
    };
  }

  /**
   * Creates a transparent render pass configuration
   */
  public static createTransparentPassConfig(
    accLight: RenderTarget,
    depthView: GPUTextureView,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    return {
      label: 'Transparent Pass',
      colorAttachments: [
        {
          view: accLight.getView()!,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
      viewport,
    };
  } /**
   * Creates a fullscreen post-processing pass configuration
   */
  public static createPostProcessPassConfig(
    target: RenderTarget,
    viewport?: { width: number; height: number },
    label = 'Post Process Pass',
  ): RenderPassConfig {
    const colorAttachments: GPURenderPassColorAttachment[] = [
      {
        view: target.getRenderView()!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ];

    return {
      label,
      colorAttachments,
      viewport,
    };
  }

  public static createPostProcessPassConfigBlended(
    target: GPUTextureView,
    viewport?: { width: number; height: number },
    label = 'Post Process Pass',
  ): RenderPassConfig {
    const colorAttachments: GPURenderPassColorAttachment[] = [
      {
        view: target,
        loadOp: 'load',
        storeOp: 'store',
      },
    ];

    return {
      label,
      colorAttachments,
      viewport,
    };
  }

  public static createBloomCombinePassConfig(
    target: GPUTextureView,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    const colorAttachments: GPURenderPassColorAttachment[] = [
      {
        view: target,
        loadOp: 'load',
        storeOp: 'store',
      },
    ];

    return {
      label: 'Bloom Combine Pass',
      colorAttachments,
      viewport,
    };
  }

  public static createDOFPassConfig(
    target: GPUTextureView,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    const colorAttachments: GPURenderPassColorAttachment[] = [
      {
        view: target,
        loadOp: 'load',
        storeOp: 'store',
      },
    ];

    return {
      label: 'DOF Pass',
      colorAttachments,
      viewport,
    };
  }

  /**
   * Creates configuration for point light render pass
   */
  public static createPointLightPassConfig(
    accLight: RenderTarget,
    singleDepthView: GPUTextureView,
  ): RenderPassConfig {
    return {
      label: 'Point Lights Render Pass',
      colorAttachments: [
        {
          view: accLight.getView()!,
          loadOp: 'load', // Load existing lighting data
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: singleDepthView,
        depthLoadOp: 'load', // Load existing depth
        depthStoreOp: 'store',
      },
    };
  }

  /**
   * Creates configuration for spot light render pass
   */
  public static createSpotLightPassConfig(
    accLight: RenderTarget,
    singleDepthView: GPUTextureView,
  ): RenderPassConfig {
    return {
      label: 'Spot Lights Render Pass',
      colorAttachments: [
        {
          view: accLight.getView()!,
          loadOp: 'load', // Load existing lighting data
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: singleDepthView,
        depthLoadOp: 'load', // Load existing depth
        depthStoreOp: 'store',
      },
    };
  }

  /**
   * Creates the render pass config for the tiled lighting full-screen pass.
   * No depth attachment — the technique uses "z: disable_all".
   * The pass additively accumulates all shadowless point/spot lights into accLight.
   */
  public static createTiledLightingPassConfig(accLight: RenderTarget): RenderPassConfig {
    return {
      label: 'Tiled Lighting Pass',
      colorAttachments: [
        {
          view: accLight.getRenderView()!,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    };
  }

  /**
   * Creates configuration for the Weighted Blended OIT gather pass.
   * Renders glass into two dual render targets:
   *   [0] accumulation (RGBA16F) — cleared to (0,0,0,0), additive blend
   *   [1] revealage    (RGBA8Unorm) — cleared to (1,0,0,1), product of (1 - alpha_i)
   * Depth is read-only: test geometry visibility but never write (prepass depth is preserved).
   */
  public static createOITGatherPassConfig(
    accumulation: RenderTarget,
    revealage: RenderTarget,
    depthView: GPUTextureView,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    return {
      label: 'OIT Gather Pass',
      colorAttachments: [
        {
          view: accumulation.getRenderView()!,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: revealage.getRenderView()!,
          clearValue: { r: 1, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthReadOnly: true,
      },
      viewport,
    };
  }

  /**
   * Creates configuration for the OIT compose pass.
   * Blends the resolved OIT result over the existing accLight buffer using premultiplied alpha.
   */
  public static createOITComposePassConfig(
    accLight: RenderTarget,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    return {
      label: 'OIT Compose Pass',
      colorAttachments: [
        {
          view: accLight.getRenderView()!,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      viewport,
    };
  }

  /**
   * Creates configuration for the water GBuffer pass.
   * Writes water geometry into 3 dedicated render targets (separate from the solid GBuffer).
   * All targets are cleared to 0 so a depth value of 0 unambiguously means "no water".
   * Depth is read-only — tested against the prepass depth but never written.
   */
  public static createWaterGBufferPassConfig(
    waterAlbedo: RenderTarget,
    waterNormals: RenderTarget,
    waterDepth: RenderTarget,
    prepassDepthView: GPUTextureView,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    return {
      label: 'Water GBuffer Pass',
      colorAttachments: [
        {
          view: waterAlbedo.getRenderView()!,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: waterNormals.getRenderView()!,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: waterDepth.getRenderView()!,
          clearValue: { r: 1, g: 1, b: 1, a: 1 }, // 1 = no water; shaders discard depth >= 0.999
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: prepassDepthView,
        depthLoadOp: 'load',
        depthStoreOp: 'store', // test only (technique uses test_but_no_write)
      },
      viewport,
    };
  }

  /**
   * Creates configuration for the water composite pass.
   * Replaces the entire accLight buffer with the composited water+scene output.
   * Every pixel is overwritten by the fullscreen quad, so loadOp: 'clear' is safe.
   */
  public static createWaterCompositePassConfig(
    accLight: RenderTarget,
    viewport?: { width: number; height: number },
  ): RenderPassConfig {
    return {
      label: 'Water Composite Pass',
      colorAttachments: [
        {
          view: accLight.getRenderView()!,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      viewport,
    };
  }
}
