import { Component } from "../../core/ecs/Component";
import { Render } from "../../renderer/core/render";
import { RenderToTexture } from "../../renderer/core/RenderToTexture";
import { Mesh } from "../../renderer/resources/Mesh";
import { Technique } from "../../renderer/resources/Technique";

export class AntialiasingComponent extends Component {
    private technique !: Technique;
    private fullscreenQuadMesh !: Mesh;
    private bindGroup !: GPUBindGroup;
    private result !: RenderToTexture;
    private uniformBuffer !: GPUBuffer;

    constructor() {
        super();
    }

    public async load(): Promise<void> {
        const device = Render.getInstance().getDevice();

        this.fullscreenQuadMesh = await Mesh.get("fullscreenquad.obj");

        this.technique = await Technique.get("antialiasing.tech");
        this.technique.createRenderPipeline(this.fullscreenQuadMesh);

        this.result = new RenderToTexture();
        this.result.createRT("antialiasing_result.dds", Render.width, Render.height, 'rgba16float');

        this.uniformBuffer = device.createBuffer({
            label: `antialiasing_uniformBuffer`,
            size: 2 * 4, // 1 vec2 (ScreenSize)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        device.queue.writeBuffer(
            this.uniformBuffer,
            0,  // offset
            new Float32Array([Render.width, Render.height])
        );
    }

    public resize(): void {
        this.result.createRT("antialiasing_result.dds", Render.width, Render.height, 'rgba16float');
    }

    public apply(texture: GPUTextureView): GPUTextureView {
        this.setBindGroup(texture);
        const render = Render.getInstance();
        const pass = render.getCommandEncoder().beginRenderPass(
            {
                colorAttachments: [{
                    view: this.result.getView(),
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                }],
            }
        );

        // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
        pass.setViewport(
            0, 0,                          // Offset X,Y
            render.getCanvas().width,             // Width
            render.getCanvas().height,            // Height
            0.0, 1.0                       // Min/max depth
        );

        pass.setScissorRect(
            0, 0,                          // Offset X,Y
            render.getCanvas().width,             // Width
            render.getCanvas().height             // Height
        );

        // 1. Activar el pipeline
        this.technique.activatePipeline(pass);

        // 2. Activar mesh data
        this.fullscreenQuadMesh.activate(pass);

        // 3. Activar bind groups
        pass.setBindGroup(0, this.bindGroup);

        // 4. Dibujar la mesh
        this.fullscreenQuadMesh.renderGroup(pass);

        pass.end();

        return this.result.getView();
    }

    private setBindGroup(texture: GPUTextureView): void {
        if(this.bindGroup) return;
        
        const device = Render.getInstance().getDevice();
        const sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        this.bindGroup = device.createBindGroup({
            label: `antialiasing_bindgroup`,
            layout: this.technique.getPipeline().getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: texture,
                },
                {
                    binding: 1,
                    resource: sampler,
                },
                {
                    binding: 2,
                    resource: { buffer: this.uniformBuffer }
                }
            ]
        })
    }

    public update(dt: number): void {
        throw new Error("Method not implemented.");
    }

    public debugInMenu(): void {
        // Implement debug menu if needed
    }

    public renderDebug(): void {
        // Implement debug rendering if needed
    }
}