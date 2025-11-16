import { EntityDataType, SceneDataType } from '../../../types/SceneData.type';
import { Entity } from '../../../core/ecs/Entity';
import { RenderComponent } from '../../../components/render/RenderComponent';
import { TransformComponent } from '../../../components/core/TransformComponent';
import { Mesh } from '../../resources/Mesh';
import { Material } from '../../resources/Material';
import { GPUUtils } from '../utils/GPUUtils';
import { RenderManagerV2 } from './RenderManagerV2';
import { BindGroupFactory } from '../factories/BindGroupFactory';

/**
 * Representa un grupo de instancias con sus recursos GPU
 */
interface InstanceGroup {
  key: string;
  mesh: Mesh;
  material: Material;
  entities: Entity[];
  entityToIndex: Map<Entity, number>;
  instanceBuffer: GPUBuffer;
  instanceBindGroup: GPUBindGroup;
  instanceCount: number;
}

/**
 * Gestiona el análisis y agrupación de entidades para instancing automático
 */
export class InstanceManager {
  private static instanceGroups: Map<string, InstanceGroup> = new Map();
  private static device: GPUDevice;
  /**
   * Analiza el JSON parseado y marca qué entities pueden ser instanciadas.
   * NO elimina entities, solo añade flags en el componente render.
   *
   * Proceso:
   * 1. Agrupa entities por mesh+material
   * 2. Para grupos con 2+ entities, marca cada una con flags de instancing
   * 3. Retorna el mismo JSON modificado (todas las entities intactas)
   */
  public static flagInstanceableEntities(parsedJson: SceneDataType): SceneDataType {
    const groups = new Map<string, EntityDataType[]>();

    console.log(`InstanceManager: Analyzing ${parsedJson.length} entities for instancing...`);

    // 1. Clasificar y agrupar entities potencialmente instanciables
    for (const entity of parsedJson) {
      if (this.canBeInstanced(entity)) {
        const key = this.getInstanceKey(entity);
        if (key) {
          if (!groups.has(key)) {
            groups.set(key, []);
          }
          groups.get(key)!.push(entity);
        }
      }
    }

    // 2. Marcar entities en grupos con 2+ elementos
    let totalInstancedGroups = 0;
    let totalInstancedEntities = 0;

    for (const [key, entities] of groups) {
      if (entities.length >= 2) {
        // Marcar cada entity del grupo con flags de instancing
        for (const entity of entities) {
          if (entity.components?.render) {
            // Añadir flags al componente render existente
            (entity.components.render as any).isInstanced = true;
            (entity.components.render as any).instanceGroup = key;
          }
        }

        totalInstancedGroups++;
        totalInstancedEntities += entities.length;
        console.log(
          `InstanceManager: Flagged instance group "${key}" with ${entities.length} entities`,
        );
      }
      // Si solo hay 1 entity en el grupo, no se marca (no vale la pena instanciar)
    }

    console.log(
      `InstanceManager: Flagged ${totalInstancedGroups} instance groups with ${totalInstancedEntities} total entities`,
    );
    console.log(
      `InstanceManager: ${parsedJson.length - totalInstancedEntities} entities will render normally`,
    );

    // Retornar el JSON original con las entities modificadas (flags añadidos)
    return parsedJson;
  }

  /**
   * Determina si una entidad puede ser instanciada.
   * Ahora permite colliders y otros componentes que no afectan el renderizado.
   */
  private static canBeInstanced(entity: EntityDataType): boolean {
    const components = entity.components;
    if (!components) return false;

    // Debe tener componente render con mesh
    const render = components.render;
    if (!render || !render.meshes || render.meshes.length === 0) {
      return false;
    }

    // No debe tener children
    if (entity.children && entity.children.length > 0) {
      return false;
    }

    // No debe tener componentes que requieran datos únicos por instancia EN EL RENDERIZADO
    // Nota: Ahora SÍ permitimos colliders (box_collider, etc.) porque cada entity los mantendrá
    const uniqueComponents = [
      'camera',
      'point_light',
      'spot_light',
      'directional_light',
      'particle_system',
      'bloom',
      'tone_mapping',
      'antialiasing',
      'ambient_occlusion',
    ];

    for (const comp of uniqueComponents) {
      if (comp in components) {
        return false;
      }
    }

    return true;
  }

  /**
   * Genera una clave única para agrupar entidades instanciables
   */
  private static getInstanceKey(entity: EntityDataType): string | null {
    const render = entity.components?.render;
    if (!render || !render.meshes || render.meshes.length === 0) {
      return null;
    }

    // Por ahora, agrupamos solo por el primer mesh/material
    const firstMesh = render.meshes[0];
    if (!firstMesh) return null;

    const mesh = firstMesh.mesh || '';
    const material = firstMesh.material || '';

    if (!mesh || !material) return null;

    return `${mesh}|${material}`;
  }

  /**
   * Crea los grupos de instancias después de que todas las entities estén cargadas.
   * Se llama desde ModuleBoot después de Loader.loadSceneFromJSON().
   */
  public static async createInstanceGroups(allEntities: Entity[]): Promise<void> {
    this.device = GPUUtils.getDevice();
    console.log('InstanceManager: Creating instance groups from loaded entities...');

    // 1. Filtrar entities con RenderComponent.isInstanced === true
    const instancedEntities: Entity[] = [];
    for (const entity of allEntities) {
      const renderComp = entity.getComponent('render') as RenderComponent | null;
      if (renderComp && renderComp.getIsInstanced()) {
        instancedEntities.push(entity);
      }
    }

    if (instancedEntities.length === 0) {
      console.log('InstanceManager: No instanced entities found');
      return;
    }

    console.log(`InstanceManager: Found ${instancedEntities.length} instanced entities`);

    // 2. Agrupar por instanceGroup
    const groups = new Map<string, Entity[]>();
    for (const entity of instancedEntities) {
      const renderComp = entity.getComponent('render') as RenderComponent;
      const groupKey = renderComp.getInstanceGroup();

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(entity);
    }

    console.log(`InstanceManager: Creating ${groups.size} instance groups`);

    // 3. Crear buffers y RenderKeys para cada grupo
    for (const [key, entities] of groups) {
      await this.createInstanceGroup(key, entities);
    }

    console.log('InstanceManager: Instance groups creation complete');
  }

  /**
   * Crea un grupo de instancias individual con su storage buffer y RenderKey
   */
  private static async createInstanceGroup(key: string, entities: Entity[]): Promise<void> {
    if (entities.length === 0) {
      console.warn(`InstanceManager: Empty entity array for group "${key}"`);
      return;
    }

    const instanceCount = entities.length;
    console.log(
      `InstanceManager: Creating instance group "${key}" with ${instanceCount} instances`,
    );

    // a. Recolectar datos
    const firstEntity = entities[0]!;
    const renderComp = firstEntity.getComponent('render') as RenderComponent;
    const parts = renderComp.getParts();

    if (parts.length === 0) {
      console.warn(`InstanceManager: No mesh parts found for group "${key}"`);
      return;
    }

    const firstPart = parts[0]!;
    const mesh = firstPart.mesh;
    const material = firstPart.material;

    // Crear mapping entity → índice
    const entityToIndex = new Map<Entity, number>();
    entities.forEach((entity, index) => {
      entityToIndex.set(entity, index);
    });

    // b. Crear storage buffer GPU
    const instanceMatrices = new Float32Array(instanceCount * 16);
    entities.forEach((entity, i) => {
      const transformComp = entity.getComponent('transform') as TransformComponent;
      const worldMatrix = transformComp.getTransform().getWorldMatrix();
      instanceMatrices.set(worldMatrix as Float32Array, i * 16);
    });

    const instanceBuffer = this.device.createBuffer({
      label: `instance_buffer_${key}`,
      size: instanceMatrices.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(instanceBuffer.getMappedRange()).set(instanceMatrices);
    instanceBuffer.unmap();

    // c. Crear bind group @group(2)
    const bindGroupLayout = BindGroupFactory.getInstanceStorageLayout();
    const instanceBindGroup = this.device.createBindGroup({
      label: `instance_bg_${key}`,
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: instanceBuffer },
        },
      ],
    });

    // d. Intentar cargar material instanciado
    let instancedMaterial = material;
    try {
      const techniquePath = material.getTechnique()!.path;
      const instancedTechniquePath = techniquePath.replace('.tech', '_instanced.tech');

      // Obtener las texturas del material original usando el getter
      const textureFiles = material.getTextureFiles();
      const materialData = {
        technique: instancedTechniquePath,
        textures: {
          txAlbedo: textureFiles.albedo,
          txNormal: textureFiles.normal,
          txMetallic: textureFiles.metallic,
          txRoughness: textureFiles.roughness,
          txEmissive: textureFiles.emissive,
        },
        category: material.getCategory(),
        casts_shadows: material.getCastsShadows(),
      };

      instancedMaterial = await Material.get(materialData);
      console.log(`InstanceManager: Loaded instanced material for "${key}"`);

      // El material instanciado cargará automáticamente su shadowsMaterial con la técnica instanciada
      // porque Material.get() crea el shadowsMaterial basado en la técnica principal
    } catch (error) {
      console.warn(
        `InstanceManager: Instanced technique not found for "${key}", using original material`,
      );
    }

    // e. Registrar RenderKey único en RenderManagerV2
    const renderManager = RenderManagerV2.getInstance();
    const firstTransform = firstEntity.getComponent('transform') as TransformComponent;

    // Llamar a addKey con los parámetros de instancing
    // RenderManagerV2 automáticamente creará el RenderKey de sombras usando instancedMaterial.getShadowsMaterial()
    renderManager.addKey(
      null as any, // owner: null para grupos instanciados
      mesh,
      instancedMaterial,
      firstTransform, // Transform del primer elemento (para culling AABB)
      true, // isInstanced
      instanceCount, // instanceCount
      instanceBindGroup, // instanceBindGroup
    );

    // f. Almacenar mapping en Map interno
    this.instanceGroups.set(key, {
      key,
      mesh,
      material: instancedMaterial,
      entities,
      entityToIndex,
      instanceBuffer,
      instanceBindGroup,
      instanceCount,
    });

    console.log(`InstanceManager: Instance group "${key}" created successfully`);
  }

  /**
   * Obtiene todos los grupos de instancias creados
   */
  public static getInstanceGroups(): Map<string, InstanceGroup> {
    return this.instanceGroups;
  }

  /**
   * Actualiza la matriz de transformación de una entidad instanciada en el GPU buffer.
   * Solo actualiza la matriz específica, no todo el buffer (optimización).
   *
   * @param entity - Entidad cuyo transform ha cambiado
   */
  public static updateInstanceTransform(entity: Entity): void {
    // 1. Buscar el grupo al que pertenece la entidad
    let targetGroup: InstanceGroup | null = null;
    let entityIndex = -1;

    for (const group of this.instanceGroups.values()) {
      if (group.entityToIndex.has(entity)) {
        targetGroup = group;
        entityIndex = group.entityToIndex.get(entity)!;
        break;
      }
    }

    if (!targetGroup || entityIndex === -1) {
      console.warn('InstanceManager: Entity not found in any instance group');
      return;
    }

    // 2. Obtener la nueva matriz de transformación
    const transformComponent = entity.getComponent('transform') as TransformComponent;
    if (!transformComponent) {
      console.warn('InstanceManager: Entity has no transform component');
      return;
    }

    const worldMatrix = transformComponent.getTransform().getWorldMatrix();

    // 3. Actualizar solo la matriz correspondiente en el storage buffer
    // Cada matriz ocupa 16 floats (4x4), offset = entityIndex * 16 * 4 bytes
    const matrixData = new Float32Array(worldMatrix);
    const offset = entityIndex * 16 * 4; // 16 floats * 4 bytes per float

    this.device.queue.writeBuffer(
      targetGroup.instanceBuffer,
      offset,
      matrixData.buffer,
      0,
      matrixData.byteLength,
    );
  }

  /**
   * Marca una entidad como removida del sistema de instancing.
   * Usa la estrategia de "escala 0" para hacerla invisible sin compactar el buffer.
   *
   * @param entity - Entidad a remover
   */
  public static removeInstance(entity: Entity): void {
    // 1. Buscar el grupo al que pertenece la entidad
    let targetGroup: InstanceGroup | null = null;
    let entityIndex = -1;

    for (const group of this.instanceGroups.values()) {
      if (group.entityToIndex.has(entity)) {
        targetGroup = group;
        entityIndex = group.entityToIndex.get(entity)!;
        break;
      }
    }

    if (!targetGroup || entityIndex === -1) {
      console.warn('InstanceManager: Entity not found in any instance group');
      return;
    }

    // 2. Crear matriz de "invisible" (escala 0)
    // Esto es más simple que compactar el buffer y funciona bien para objetos estáticos
    const invisibleMatrix = new Float32Array([
      0,
      0,
      0,
      0, // Primera fila (escala X = 0)
      0,
      0,
      0,
      0, // Segunda fila (escala Y = 0)
      0,
      0,
      0,
      0, // Tercera fila (escala Z = 0)
      0,
      0,
      0,
      1, // Cuarta fila (mantener w = 1 para homogéneas)
    ]);

    // 3. Escribir matriz invisible en la posición de la entidad
    const offset = entityIndex * 16 * 4;
    this.device.queue.writeBuffer(
      targetGroup.instanceBuffer,
      offset,
      invisibleMatrix.buffer,
      0,
      invisibleMatrix.byteLength,
    );

    // 4. Remover del Map (ya no es actualizable)
    targetGroup.entityToIndex.delete(entity);

    console.log(`InstanceManager: Entity removed from instance group "${targetGroup.key}"`);

    // Nota: El instanceCount NO se reduce para evitar reconfigurar RenderKey
    // La GPU seguirá renderizando todas las instancias, pero esta será invisible
  }

  /**
   * Actualiza las transformaciones de múltiples entidades de forma batch.
   * Más eficiente que llamar a updateInstanceTransform() múltiples veces.
   *
   * @param entities - Array de entidades a actualizar
   */
  public static updateInstanceTransforms(entities: Entity[]): void {
    // Agrupar entities por instance group para batch updates
    const updatesByGroup = new Map<InstanceGroup, Array<{ entity: Entity; index: number }>>();

    for (const entity of entities) {
      for (const group of this.instanceGroups.values()) {
        if (group.entityToIndex.has(entity)) {
          const index = group.entityToIndex.get(entity)!;
          if (!updatesByGroup.has(group)) {
            updatesByGroup.set(group, []);
          }
          updatesByGroup.get(group)!.push({ entity, index });
          break;
        }
      }
    }

    // Actualizar cada grupo con todas sus entities modificadas
    for (const [group, updates] of updatesByGroup) {
      for (const { entity, index } of updates) {
        const transformComponent = entity.getComponent('transform') as TransformComponent;
        if (transformComponent) {
          const worldMatrix = transformComponent.getTransform().getWorldMatrix();
          const matrixData = new Float32Array(worldMatrix);
          const offset = index * 16 * 4;

          this.device.queue.writeBuffer(
            group.instanceBuffer,
            offset,
            matrixData.buffer,
            0,
            matrixData.byteLength,
          );
        }
      }
    }
  }
}
