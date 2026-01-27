import { BaseRenderPass, RenderPassConfig } from './BaseRenderPass';
import { GPUUtils } from '../utils/GPUUtils';
import { Engine } from '../../../core/engine/Engine';
import { PointLightComponent } from '../../../components/render/PointLightComponent';
import { SpotLightComponent } from '../../../components/render/SpotLightComponent';
import { TransformComponent } from '../../../components/core/TransformComponent';
import { Technique } from '../../resources/Technique';
import { Mesh } from '../../resources/Mesh';

/**
 * Render pass for point lights using deferred shading
 */
export class PointLightRenderPass extends BaseRenderPass {
  private technique!: Technique;
  private mesh!: Mesh;
  private gBufferBindGroup!: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    technique: Technique,
    mesh: Mesh,
    gBufferBindGroup: GPUBindGroup,
  ) {
    super(config);
    this.technique = technique;
    this.mesh = mesh;
    this.gBufferBindGroup = gBufferBindGroup;
  }

  protected render(pass: GPURenderPassEncoder): void {
    // Configure viewport
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.technique.activatePipeline(pass);

    // 2. Activate mesh data
    this.mesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.gBufferBindGroup); // GBuffer textures

    // 4. Render all point lights
    for (const comp of Engine.getEntities().getObjectManagerByName('point_light')?.getList() ??
      []) {
      const pointLightComponent = comp as PointLightComponent;
      if (!pointLightComponent.isVisible()) {
        continue;
      }
      const entity = pointLightComponent.getOwner();
      const transform = entity.getComponent('transform') as TransformComponent;

      pass.setBindGroup(2, transform.getModelBindGroup());
      pointLightComponent.setBindGroup(pass);

      // Draw the mesh
      this.mesh.renderGroup(pass);
    }
  }
}

/**
 * Render pass for spot lights using deferred shading
 */
export class SpotLightRenderPass extends BaseRenderPass {
  private technique!: Technique;
  private mesh!: Mesh;
  private gBufferBindGroup!: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    technique: Technique,
    mesh: Mesh,
    gBufferBindGroup: GPUBindGroup,
  ) {
    super(config);
    this.technique = technique;
    this.mesh = mesh;
    this.gBufferBindGroup = gBufferBindGroup;
  }

  protected render(pass: GPURenderPassEncoder): void {
    // Configure viewport
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.technique.activatePipeline(pass);

    // 2. Activate mesh data
    this.mesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.gBufferBindGroup); // GBuffer textures

    // 4. Render all spot lights
    for (const comp of Engine.getEntities().getObjectManagerByName('spot_light')?.getList() ?? []) {
      const spotLightComponent = comp as SpotLightComponent;
      if (spotLightComponent.hasShadows() && !spotLightComponent.isVisible()) {
        continue;
      }
      spotLightComponent.setBindGroup(pass);

      // Draw the mesh
      this.mesh.renderGroup(pass);
    }
  }
}

export class SpotLightWithShadowsRenderPass extends BaseRenderPass {
  private technique!: Technique;
  private mesh!: Mesh;
  private gBufferBindGroup!: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    technique: Technique,
    mesh: Mesh,
    gBufferBindGroup: GPUBindGroup,
  ) {
    super(config);
    this.technique = technique;
    this.mesh = mesh;
    this.gBufferBindGroup = gBufferBindGroup;
  }

  protected render(pass: GPURenderPassEncoder): void {
    // Configure viewport
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.technique.activatePipeline(pass);

    // 2. Activate mesh data
    this.mesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.gBufferBindGroup); // GBuffer textures

    // 4. Render all spot lights
    for (const comp of Engine.getEntities().getObjectManagerByName('spot_light')?.getList() ?? []) {
      const spotLightComponent = comp as SpotLightComponent;
      if (!spotLightComponent.hasShadows() && !spotLightComponent.isVisible()) {
        continue;
      }
      spotLightComponent.setBindGroup(pass);

      // Draw the mesh
      this.mesh.renderGroup(pass);
    }
  }
}
