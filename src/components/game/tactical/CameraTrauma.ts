import { vec3 } from 'gl-matrix';

const DEG = Math.PI / 180;
const UP = vec3.fromValues(0, 1, 0);

/** Trauma que se pierde por segundo. */
const DECAY = 1.5;
/** Giro máximo (guiñada / cabeceo) con trauma 1. */
const MAX_ANGLE = 1.2 * DEG;
/** Alabeo máximo con trauma 1. */
const MAX_ROLL = 2.0 * DEG;
/** Desplazamiento máximo (m) con trauma 1. */
const MAX_OFFSET = 0.1;
/** Rapidez del ruido (Hz aprox.). */
const FREQUENCY = 13;
/** Muelle del empujón: rigidez y amortiguación (algo por debajo de la crítica: rebota un poco). */
const KICK_STIFFNESS = 380;
const KICK_DAMPING = 2 * Math.sqrt(KICK_STIFFNESS) * 0.6;
/** Paso máximo del muelle (s): con un tirón de framerate no explota. */
const MAX_STEP = 1 / 60;

/**
 * CameraTrauma — sacudida de cámara por "trauma" (Squirrel Eiserloh, GDC 2016, "Juicing Your
 * Cameras With Math"). Los golpes suman trauma (0..1), que baja solo; la sacudida es trauma²
 * (un golpe flojo apenas mueve, varios seguidos o uno fuerte mucho) y sigue un ruido suave
 * (no un azar por frame): giro, alabeo y algo de desplazamiento. Un golpe con dirección da
 * además un empujón de la cámara hacia allí que vuelve con un muelle: se siente el peso.
 *
 * Lo aplican las dos cámaras (táctica y de acción) al colocarse; la táctica lo avanza.
 */
export class CameraTrauma {
  private static trauma = 0;
  private static time = 0;
  private static readonly kick = vec3.create();
  private static readonly kickVelocity = vec3.create();
  private static readonly forward = vec3.create();
  private static readonly right = vec3.create();
  private static readonly up = vec3.create();
  private static readonly tmp = vec3.create();

  /**
   * Suma `amount` de trauma (0..1). `direction`: hacia dónde empuja el golpe (mundo); `kick`:
   * velocidad (m/s) del empujón en esa dirección.
   */
  public static add(amount: number, direction?: vec3, kick = 0): void {
    this.trauma = Math.min(1, this.trauma + amount);
    if (direction && kick > 0) {
      const len = vec3.length(direction);
      if (len > 1e-4) vec3.scaleAndAdd(this.kickVelocity, this.kickVelocity, direction, kick / len);
    }
  }

  public static getTrauma(): number {
    return this.trauma;
  }

  public static update(dt: number): void {
    this.trauma = Math.max(0, this.trauma - DECAY * dt);
    this.time += dt;
    // Muelle amortiguado (Euler semi-implícito, en pasos cortos).
    for (let left = dt; left > 0; left -= MAX_STEP) {
      const h = Math.min(left, MAX_STEP);
      for (let i = 0; i < 3; i++) {
        const a = -KICK_STIFFNESS * this.kick[i]! - KICK_DAMPING * this.kickVelocity[i]!;
        this.kickVelocity[i] = this.kickVelocity[i]! + a * h;
        this.kick[i] = this.kick[i]! + this.kickVelocity[i]! * h;
      }
    }
  }

  /**
   * Mueve `eye` y `look` con la sacudida y el empujón actuales. Devuelve el alabeo (rad) que
   * hay que sumar al vector "arriba" de la cámara (ver rolledUp).
   */
  public static apply(eye: vec3, look: vec3): number {
    vec3.add(eye, eye, this.kick);
    vec3.add(look, look, this.kick);
    const shake = this.trauma * this.trauma;
    if (shake < 1e-5) return 0;

    const t = this.time * FREQUENCY;
    vec3.sub(this.forward, look, eye);
    const dist = vec3.length(this.forward);
    if (dist < 1e-4) return 0;
    vec3.scale(this.forward, this.forward, 1 / dist);
    vec3.cross(this.right, this.forward, UP);
    if (vec3.length(this.right) < 1e-4) vec3.set(this.right, 1, 0, 0);
    vec3.normalize(this.right, this.right);
    vec3.cross(this.up, this.right, this.forward);

    // Giro: el punto de mira se mueve en el plano de la pantalla (a su distancia).
    const yaw = Math.tan(MAX_ANGLE * shake * noise(t, 1)) * dist;
    const pitch = Math.tan(MAX_ANGLE * shake * noise(t, 2)) * dist;
    vec3.scaleAndAdd(look, look, this.right, yaw);
    vec3.scaleAndAdd(look, look, this.up, pitch);
    // Desplazamiento: ojo y punto de mira juntos.
    vec3.scale(this.tmp, this.right, MAX_OFFSET * shake * noise(t, 3));
    vec3.scaleAndAdd(this.tmp, this.tmp, this.up, MAX_OFFSET * shake * noise(t, 4));
    vec3.add(eye, eye, this.tmp);
    vec3.add(look, look, this.tmp);
    return MAX_ROLL * shake * noise(t, 5);
  }

  /** "Arriba" de una cámara que mira de `eye` a `look`, girado `roll` rad (Rodrigues). */
  public static rolledUp(eye: vec3, look: vec3, roll: number, out: vec3): vec3 {
    if (Math.abs(roll) < 1e-6) return vec3.copy(out, UP);
    const k = vec3.normalize(this.tmp, vec3.sub(this.tmp, look, eye));
    const cos = Math.cos(roll);
    vec3.cross(out, k, UP);
    vec3.scale(out, out, Math.sin(roll));
    vec3.scaleAndAdd(out, out, UP, cos);
    return vec3.scaleAndAdd(out, out, k, vec3.dot(k, UP) * (1 - cos));
  }

  /** Sin sacudida ni empujón (reinicio del encuentro). */
  public static clear(): void {
    this.trauma = 0;
    vec3.zero(this.kick);
    vec3.zero(this.kickVelocity);
  }
}

/** Ruido de gradiente 1D suave en [-1, 1]; `channel` da una curva independiente por eje. */
function noise(t: number, channel: number): number {
  const x = t + channel * 31.7;
  const i = Math.floor(x);
  const f = x - i;
  const g0 = gradient(i, channel) * f;
  const g1 = gradient(i + 1, channel) * (f - 1);
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return (g0 + (g1 - g0) * u) * 2;
}

function gradient(i: number, channel: number): number {
  const h = Math.sin(i * 127.1 + channel * 311.7) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}
