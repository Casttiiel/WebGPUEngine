import { Component } from '../../core/ecs/Component';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import * as CANNON from 'cannon-es';
import { Engine } from '../../core/engine/Engine';

export class InfinitePlaneColliderComponent extends Component {
  private body!: CANNON.Body;
  private transform!: TransformComponent;
  private normal: vec3;
  private material!: CANNON.Material;

  constructor() {
    super();
    // Por defecto el plano mira hacia arriba (suelo)
    this.normal = vec3.fromValues(0, 1, 0);
  }

  public async load(data: any): Promise<void> {
    this.transform = this.getOwner().getComponent('transform') as TransformComponent;
    if (!this.transform) {
      throw new Error('InfinitePlaneCollider requires a TransformComponent');
    }

    // Crear material físico
    this.material = new CANNON.Material();
    if (data.material) {
      this.material.friction = data.material.friction || 0.3;
      this.material.restitution = data.material.restitution || 0.3;
    }

    // Obtener transformación mundial
    const worldPosition = this.transform.getTransform().getWorldPosition();
    const worldRotation = this.transform.getTransform().getWorldRotation();

    // El plano en CANNON.js por defecto mira en dirección Z (0,0,1)
    // Primero rotamos -90 grados en X para que mire hacia arriba
    const baseRotation = new CANNON.Quaternion();
    baseRotation.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);

    // Luego aplicamos la rotación del objeto
    const objectRotation = new CANNON.Quaternion(
      worldRotation[0],
      worldRotation[1],
      worldRotation[2],
      worldRotation[3],
    );

    // Combinar rotaciones: primero la base, luego la del objeto
    const finalRotation = objectRotation.mult(baseRotation);

    // Crear cuerpo físico
    this.body = new CANNON.Body({
      mass: 0, // Los planos infinitos siempre son estáticos
      material: this.material,
      shape: new CANNON.Plane(),
      position: new CANNON.Vec3(worldPosition[0], worldPosition[1], worldPosition[2]),
      quaternion: finalRotation, // Rotación combinada: -90º en X + rotación del objeto
    });

    // Registrar en el sistema de física
    const physics = Engine.getPhysics();
    if (physics) {
      physics.addBody(this.body, this.getOwner().id);
    }
  }

  public update(deltaTime: number): void {
    // Los planos infinitos son estáticos, no necesitan actualización
  }

  public dispose(): void {
    // Limpiar el cuerpo físico del mundo
    const physics = Engine.getPhysics();
    if (physics && this.body) {
      physics.removeBody(this.getOwner().id);
    }
  }

  // Getters útiles
  public getBody(): CANNON.Body {
    return this.body;
  }

  public getNormal(): vec3 {
    return this.normal;
  }

  public getMaterial(): CANNON.Material {
    return this.material;
  }

  public renderDebug(): void {}

  public override renderInMenu(): void {}
}
