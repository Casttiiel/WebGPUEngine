import { GPUUtils } from '../utils/GPUUtils';

export interface ComputePipelineConfig {
  label: string;
  compute: {
    module: GPUShaderModule;
    entryPoint: string;
  };
  layout?: GPUPipelineLayout | 'auto';
}

export interface PipelineConfig {
  label: string;
  vertex: {
    module: GPUShaderModule;
    entryPoint: string;
    buffers?: GPUVertexBufferLayout[];
  };
  fragment?: {
    module: GPUShaderModule;
    entryPoint: string;
    targets: GPUColorTargetState[];
  };
  primitive?: GPUPrimitiveState;
  depthStencil?: GPUDepthStencilState;
  multisample?: GPUMultisampleState;
  layout?: GPUPipelineLayout | 'auto';
}

/**
 * Factory for creating render pipelines with common configurations
 */
export class PipelineFactory {
  /**
   * Creates a new render pipeline (synchronous — prefer createPipelineAsync during load)
   */
  public static createPipeline(config: PipelineConfig): GPURenderPipeline {
    const device = GPUUtils.getDevice();

    const descriptor: GPURenderPipelineDescriptor = {
      label: config.label,
      layout: config.layout || 'auto',
      vertex: config.vertex,
      ...(config.fragment !== undefined && { fragment: config.fragment }),
    };

    if (config.primitive) {
      descriptor.primitive = config.primitive;
    }
    if (config.depthStencil) {
      descriptor.depthStencil = config.depthStencil;
    }

    if (config.multisample) {
      descriptor.multisample = config.multisample;
    }

    return device.createRenderPipeline(descriptor);
  }

  /**
   * Creates a new render pipeline asynchronously.
   * Allows the browser to compile multiple pipelines in parallel without blocking the main thread.
   */
  public static async createPipelineAsync(config: PipelineConfig): Promise<GPURenderPipeline> {
    const device = GPUUtils.getDevice();

    const descriptor: GPURenderPipelineDescriptor = {
      label: config.label,
      layout: config.layout || 'auto',
      vertex: config.vertex,
      ...(config.fragment !== undefined && { fragment: config.fragment }),
    };

    if (config.primitive) {
      descriptor.primitive = config.primitive;
    }
    if (config.depthStencil) {
      descriptor.depthStencil = config.depthStencil;
    }

    if (config.multisample) {
      descriptor.multisample = config.multisample;
    }

    return device.createRenderPipelineAsync(descriptor);
  }

  /**
   * Creates a new compute pipeline
   */
  public static createComputePipeline(config: ComputePipelineConfig): GPUComputePipeline {
    const device = GPUUtils.getDevice();

    const descriptor: GPUComputePipelineDescriptor = {
      label: config.label,
      layout: config.layout || 'auto',
      compute: config.compute,
    };

    return device.createComputePipeline(descriptor);
  }
  /**
   * Creates a custom pipeline layout with the specified bind group layouts
   */
  public static createPipelineLayout(
    label: string,
    bindGroupLayouts: GPUBindGroupLayout[],
  ): GPUPipelineLayout {
    const device = GPUUtils.getDevice();

    return device.createPipelineLayout({
      label,
      bindGroupLayouts,
    });
  }

  /**
   * Gets alpha blending state
   */
  public static getAlphaBlending(): GPUBlendState {
    return {
      color: {
        srcFactor: 'src-alpha',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
    };
  }

  /**
   * Gets additive blending state
   */
  public static getAdditiveBlending(): GPUBlendState {
    return {
      color: {
        srcFactor: 'src-alpha',
        dstFactor: 'one',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'zero',
        dstFactor: 'one',
        operation: 'add',
      },
    };
  }
  /**
   * Volumetric blending for physically correct fog integration
   * Formula: FinalColor = SceneColor * T + S
   * Where src.rgb = S (in-scattering), src.a = T (transmittance)
   * Result: dst.rgb = src.rgb + dst.rgb * src.a = S + SceneColor * T
   */
  public static getVolumetricBlending(): GPUBlendState {
    return {
      color: {
        srcFactor: 'one',
        dstFactor: 'src-alpha',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'zero',
        dstFactor: 'one',
        operation: 'add',
      },
    };
  }
  /**
   * Gets pure additive blending state (one + one)
   */
  public static getPureAdditiveBlending(): GPUBlendState {
    return {
      color: {
        srcFactor: 'one',
        dstFactor: 'one',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'one',
        operation: 'add',
      },
    };
  }

  /**
   * Gets opaque blending state (replaces destination)
   */
  public static getOpaqueBlending(): GPUBlendState {
    return {
      color: {
        srcFactor: 'one',
        dstFactor: 'zero',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'zero',
        operation: 'add',
      },
    };
  }

  /**
   * Premultiplied alpha blending: ONE + ONE_MINUS_SRC_ALPHA
   * Used for OIT compose: composites premultiplied glass over opaque accLight.
   */
  public static getPremultipliedBlending(): GPUBlendState {
    return {
      color: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
    };
  }
}
