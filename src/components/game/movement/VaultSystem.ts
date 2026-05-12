import { vec3 } from 'gl-matrix';
import { IMantleController } from './IMantleController';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';

/**
 * VaultSystem — Saltar por encima de obstáculos bajos manteniendo el momentum.
 *
 * Diferencia clave con MantleSystem:
 *  - Mantle: hay suelo arriba → el personaje trepa y se queda en la plataforma.
 *  - Vault:  no hay suelo al otro lado (o está más bajo) → el personaje cruza
 *            por encima y cae al otro lado continuando con su velocidad horizontal.
 *
 * Detección (4 raycasts):
 *  1. Horizontal forward       → colisiona con el obstáculo.
 *  2. Vertical ↓ en el lado de aproximación → calcula la altura del top del obstáculo.
 *  3. Vertical ↓ en el lado lejano         → si hay suelo a la misma altura, cede a Mantle.
 *  4. Vertical ↑ sobre el top              → comprueba que hay espacio para cruzar.
 *
 * Fases:
 *  RISE → el personaje sube hacia el peak (top del obstáculo + clearance + offset forward).
 *  Al llegar al peak → se libera con velocidad horizontal completa; la gravedad hace el resto.
 */
export class VaultSystem {
  // ── Parámetros de detección ─────────────────────────────────────────────────
  private readonly vaultDetectionDistance: number = 1.8;
  /** Altura máxima del top del obstáculo sobre los pies del jugador. */
  private readonly vaultMaxObstacleHeight: number = 1.3;
  /** Altura mínima (evita vault sobre pequeños escalones). */
  private readonly vaultMinObstacleHeight: number = 0.3;
  /** Distancia hacia adelante del wall hit para buscar el top. */
  private readonly wallProbeSkinInward: number = 0.1;
  /** Distancia hacia adelante del wall hit para el side lejano. */
  private readonly farSideProbeOffset: number = 0.8;
  /** Si hay suelo en el lado lejano a menos de esta distancia → es un mantle, no vault. */
  private readonly farGroundMantleThreshold: number = 0.35;
  /** Espacio mínimo por encima del top para que el personaje pase. */
  private readonly peakClearance: number = 0.25;
  /** Velocidad mínima para activar el vault (evita activación al caminar lento). */
  private readonly vaultMinSpeed: number = 5.0;
  /** Distancia horizontal al peak desde el punto de contacto con la pared. */
  private readonly peakForwardOffset: number = 0.45;
  /** Multiplicador de velocidad durante la fase RISE. */
  private readonly riseSpeedScale: number = 1.25;
  /** Distancia al peak para considerar que se ha completado el vault. */
  private readonly completionRadius: number = 0.28;
  /** Velocidad vertical negativa al liberar (para iniciar la caída inmediatamente). */
  private readonly releaseDownwardVelocity: number = -1.5;

  // ── Estado interno ───────────────────────────────────────────────────────────
  private vaultPeakPos: vec3 = vec3.create();
  private vaultForwardDir: vec3 = vec3.create();
  private vaultStoredSpeed: number = 0.0;
  private originalHeight: number = 0.0;
  private originalRadius: number = 0.0;

  constructor(private readonly controller: IMantleController) {
    const collider = controller.getCollider();
    this.originalHeight = collider.getCapsuleHeight();
    this.originalRadius = collider.getCapsuleRadius();
  }

  // ── API pública ──────────────────────────────────────────────────────────────

  /**
   * Llamar cada frame desde el estado IDLE del ParkourController.
   * Si detecta una oportunidad de vault, inicia automáticamente.
   */
  public update(): void {
    if (
      this.controller.getIsVaulting() ||
      this.controller.getIsMantling() ||
      (this.controller.getIsWallRunning?.() ?? false)
    ) {
      return;
    }

    const input = Engine.getInput();
    if (!input.isActionBuffered(GameAction.JUMP)) return;

    const info = this.detectVaultOpportunity();
    if (info) {
      input.consumeBufferedAction(GameAction.JUMP);
      this.startVault(info.peakPos, info.forwardDir);
    }
  }

  /**
   * Devuelve la velocidad a aplicar durante la fase RISE.
   * Cuando se alcanza el peak, finaliza el vault automáticamente.
   */
  public updateVaultMovement(): vec3 {
    const collider = this.controller.getCollider();
    const rb = collider.getRigidBody().translation();
    const pos = vec3.fromValues(rb.x, rb.y, rb.z);

    const toPeak = vec3.subtract(vec3.create(), this.vaultPeakPos, pos);
    const dist = vec3.length(toPeak);

    if (dist < this.completionRadius) {
      this.endVault();
      return vec3.create();
    }

    const dir = vec3.normalize(vec3.create(), toPeak);
    return vec3.scale(vec3.create(), dir, this.vaultStoredSpeed * this.riseSpeedScale);
  }

  // ── Detección ────────────────────────────────────────────────────────────────

  private detectVaultOpportunity(): { peakPos: vec3; forwardDir: vec3 } | null {
    const physics = Engine.getPhysics();
    const camera = this.controller.getCamera();
    if (!camera) return null;

    const collider = this.controller.getCollider();
    const playerPos = collider.getRigidBody().translation();

    // Dirección horizontal de la cámara
    let forward = camera.getCamera().getFront();
    forward[1] = 0;
    vec3.normalize(forward, forward);

    // ── Ray 1: horizontal forward → buscar pared ────────────────────────────
    // A mayor velocidad, mayor distancia de detección (igual que MantleSystem).
    const currentSpeed = this.controller.getCurrentSpeed();
    const speedRatio = Math.min(currentSpeed / (14.0 * 2.0), 2.0);
    const dynamicDetectionDistance = this.vaultDetectionDistance * (1.0 + speedRatio * 0.8);

    const ray1 = new RAPIER.Ray(
      { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      { x: forward[0], y: 0, z: forward[2] },
    );

    const wallHit = physics
      .getWorld()
      .castRay(
        ray1,
        dynamicDetectionDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider.getCollider(),
      );

    if (!wallHit) return null;
    if (wallHit.collider.parent()!.bodyType() !== RAPIER.RigidBodyType.Fixed) return null;

    const wallDist = wallHit.timeOfImpact;
    const playerFeetY = playerPos.y - this.originalHeight / 2.0 - this.originalRadius;

    // Punto de sondeo: ligeramente dentro del obstáculo (lado de aproximación)
    const probeX = playerPos.x + forward[0] * (wallDist + this.wallProbeSkinInward);
    const probeZ = playerPos.z + forward[2] * (wallDist + this.wallProbeSkinInward);
    const castFromY = playerFeetY + this.vaultMaxObstacleHeight + 0.5;

    // ── Ray 2: vertical ↓ lado de aproximación → top del obstáculo ──────────
    const ray2 = new RAPIER.Ray({ x: probeX, y: castFromY, z: probeZ }, { x: 0, y: -1, z: 0 });

    const topHit = physics
      .getWorld()
      .castRay(
        ray2,
        this.vaultMaxObstacleHeight + 0.5,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider.getCollider(),
      );

    if (!topHit) return null;

    const wallTopY = castFromY - topHit.timeOfImpact;
    const obstacleHeight = wallTopY - playerFeetY;

    if (obstacleHeight < this.vaultMinObstacleHeight) return null;
    if (obstacleHeight > this.vaultMaxObstacleHeight) return null;

    // ── Ray 3: vertical ↓ lado lejano → distinguir Vault de Mantle ──────────
    // Si hay suelo a la misma altura en el otro lado, es un mantle (plataforma).
    const farX = playerPos.x + forward[0] * (wallDist + this.farSideProbeOffset);
    const farZ = playerPos.z + forward[2] * (wallDist + this.farSideProbeOffset);

    const ray3 = new RAPIER.Ray({ x: farX, y: wallTopY + 0.2, z: farZ }, { x: 0, y: -1, z: 0 });

    const farGroundHit = physics
      .getWorld()
      .castRay(
        ray3,
        this.farGroundMantleThreshold + 0.2,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider.getCollider(),
      );

    // Si hay suelo cerca en el lado lejano → mantle territory, no vault
    if (farGroundHit && farGroundHit.timeOfImpact < this.farGroundMantleThreshold) return null;

    // ── Ray 4: vertical ↑ sobre el top → comprobar espacio para cruzar ──────
    const ray4 = new RAPIER.Ray({ x: probeX, y: wallTopY + 0.1, z: probeZ }, { x: 0, y: 1, z: 0 });

    const ceilingHit = physics
      .getWorld()
      .castRay(
        ray4,
        this.originalHeight + 0.5,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider.getCollider(),
      );

    if (ceilingHit && ceilingHit.timeOfImpact < this.originalHeight) return null;

    // ── Peak: centro del personaje sobre el top, ligeramente hacia adelante ──
    const peakPos = vec3.fromValues(
      playerPos.x + forward[0] * (wallDist + this.peakForwardOffset),
      wallTopY + this.originalHeight / 2.0 + this.peakClearance,
      playerPos.z + forward[2] * (wallDist + this.peakForwardOffset),
    );

    return { peakPos, forwardDir: vec3.clone(forward) };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  private startVault(peakPos: vec3, forwardDir: vec3): void {
    this.controller.setIsVaulting(true);
    this.controller.setIsJumping(false);
    vec3.copy(this.vaultPeakPos, peakPos);
    vec3.copy(this.vaultForwardDir, forwardDir);
    this.vaultStoredSpeed = Math.max(this.controller.getCurrentSpeed(), this.vaultMinSpeed);
    this.controller.setVerticalVelocity(0.0);
  }

  private endVault(): void {
    this.controller.setIsVaulting(false);
    // Liberar con velocidad horizontal completa → la gravedad maneja la caída
    const landVelocity = vec3.scale(vec3.create(), this.vaultForwardDir, this.vaultStoredSpeed);
    this.controller.setHorizontalVelocity(landVelocity);
    this.controller.setVerticalVelocity(this.releaseDownwardVelocity);
  }
}
