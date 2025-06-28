import { GPUUtils } from '../utils/GPUUtils';
import { BindGroupFactory } from './BindGroupFactory';

export interface PipelineConfig {
    label: string;
    vertex: {
        module: GPUShaderModule;
        entryPoint: string;
        buffers?: GPUVertexBufferLayout[];
    };
    fragment: {
        module: GPUShaderModule;
        entryPoint: string;
        targets: GPUColorTargetState[];
    };
    primitive?: GPUPrimitiveState;
    depthStencil?: GPUDepthStencilState;
    layout?: GPUPipelineLayout | 'auto';
}

/**
 * Factory for creating render pipelines with common configurations
 */
export class PipelineFactory {
    private static pipelines: Map<string, GPURenderPipeline> = new Map();

    /**
     * Creates or retrieves a cached render pipeline
     */
    public static getPipeline(key: string, config: PipelineConfig): GPURenderPipeline {
        if (!this.pipelines.has(key)) {
            const pipeline = this.createPipeline(config);
            this.pipelines.set(key, pipeline);
        }
        return this.pipelines.get(key)!;
    }

    /**
     * Creates a new render pipeline
     */
    public static createPipeline(config: PipelineConfig): GPURenderPipeline {
        const device = GPUUtils.getDevice();

        const descriptor: GPURenderPipelineDescriptor = {
            label: config.label,
            layout: config.layout || 'auto',
            vertex: config.vertex,
            fragment: config.fragment,
        };

        if (config.primitive) {
            descriptor.primitive = config.primitive;
        }

        if (config.depthStencil) {
            descriptor.depthStencil = config.depthStencil;
        }

        return device.createRenderPipeline(descriptor);
    }

    /**
     * Creates a standard geometry pipeline
     */
    public static createGeometryPipeline(
        label: string,
        vertexModule: GPUShaderModule,
        fragmentModule: GPUShaderModule,
        colorTargets: GPUColorTargetState[],
        hasDepth = true,
    ): GPURenderPipeline {
        const config: PipelineConfig = {
            label,
            vertex: {
                module: vertexModule,
                entryPoint: 'vs',
                buffers: this.getStandardVertexBuffers(),
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fs',
                targets: colorTargets,
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'back',
                frontFace: 'ccw',
            },
            layout: this.createStandardPipelineLayout(),
        };

        if (hasDepth) {
            config.depthStencil = {
                format: 'depth32float',
                depthWriteEnabled: true,
                depthCompare: 'less',
            };
        }

        return this.createPipeline(config);
    }

    /**
     * Creates a fullscreen quad pipeline
     */
    public static createFullscreenPipeline(
        label: string,
        vertexModule: GPUShaderModule,
        fragmentModule: GPUShaderModule,
        colorTargets: GPUColorTargetState[],
    ): GPURenderPipeline {
        const config: PipelineConfig = {
            label,
            vertex: {
                module: vertexModule,
                entryPoint: 'vs',
                // No vertex buffers needed for fullscreen quad
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fs',
                targets: colorTargets,
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            layout: 'auto',
        };

        return this.createPipeline(config);
    }

    /**
     * Gets standard vertex buffer layout for geometry
     */
    public static getStandardVertexBuffers(): GPUVertexBufferLayout[] {
        return [
            // Positions
            {
                arrayStride: 3 * 4, // 3 floats
                attributes: [
                    {
                        shaderLocation: 0,
                        offset: 0,
                        format: 'float32x3',
                    },
                ],
            },
            // Normals
            {
                arrayStride: 3 * 4, // 3 floats
                attributes: [
                    {
                        shaderLocation: 1,
                        offset: 0,
                        format: 'float32x3',
                    },
                ],
            },
            // UVs
            {
                arrayStride: 2 * 4, // 2 floats
                attributes: [
                    {
                        shaderLocation: 2,
                        offset: 0,
                        format: 'float32x2',
                    },
                ],
            },
            // Tangents
            {
                arrayStride: 4 * 4, // 4 floats
                attributes: [
                    {
                        shaderLocation: 3,
                        offset: 0,
                        format: 'float32x4',
                    },
                ],
            },
        ];
    }

    /**
     * Creates standard pipeline layout
     */
    public static createStandardPipelineLayout(): GPUPipelineLayout {
        const device = GPUUtils.getDevice();

        return device.createPipelineLayout({
            label: 'standard_pipeline_layout',
            bindGroupLayouts: [
                BindGroupFactory.getCameraUniformsLayout(),    // Group 0: Camera
                BindGroupFactory.getObjectUniformsLayout(),    // Group 1: Object
                BindGroupFactory.getMaterialTexturesLayout(),  // Group 2: Material
            ],
        });
    }

    /**
     * Creates common color target states
     */
    public static getColorTargetState(
        format: GPUTextureFormat,
        blend?: GPUBlendState,
    ): GPUColorTargetState {
        return {
            format,
            blend,
            writeMask: GPUColorWrite.ALL,
        };
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
     * Clears pipeline cache
     */
    public static clearCache(): void {
        this.pipelines.clear();
    }
}
