/**
 * CollisionGroups - Grupos de colisión bit flags para Rapier
 *
 * Cada grupo ocupa un bit en un número de 32 bits.
 * Los grupos permiten filtrar interacciones de colisión.
 *
 * Uso:
 * - collisionGroups: Define a qué grupo pertenece este collider
 * - collisionMask: Define con qué grupos puede colisionar este collider
 *
 * Ejemplo:
 * - Un DashTrigger tiene collisionGroups = DASH_TRIGGER
 * - El Player tiene collisionMask con DASH_TRIGGER habilitado para detectarlo
 */
export enum CollisionGroups {
  // Grupos principales
  PLAYER = 0x00000001, // 0b00000001 - Jugador
  ENVIRONMENT = 0x00000002, // 0b00000010 - Escenario (paredes, suelo)
  ENEMY = 0x00000004, // 0b00000100 - Enemigos
  PROJECTILE = 0x00000008, // 0b00001000 - Proyectiles

  // Triggers especiales
  DASH_TRIGGER = 0x00000010, // 0b00010000 - Triggers de dash (punto de anclaje)
  SWING_TRIGGER = 0x00000020, // 0b00100000 - Barras de swing
  IMPULSE_TRIGGER = 0x00000040, // 0b01000000 - Plataformas de impulso
  CHECKPOINT = 0x00000080, // 0b10000000 - Checkpoints

  // Utilidades
  ALL = 0xffffffff, // Todos los grupos
  NONE = 0x00000000, // Ningún grupo
}

/**
 * CollisionMasks - Máscaras predefinidas para casos comunes
 */
export const CollisionMasks = {
  // Player interactúa con todo excepto otros players
  PLAYER:
    CollisionGroups.ENVIRONMENT |
    CollisionGroups.ENEMY |
    CollisionGroups.PROJECTILE |
    CollisionGroups.DASH_TRIGGER |
    CollisionGroups.SWING_TRIGGER |
    CollisionGroups.IMPULSE_TRIGGER |
    CollisionGroups.CHECKPOINT,

  // Environment solo colisiona con player, enemigos y proyectiles
  ENVIRONMENT: CollisionGroups.PLAYER | CollisionGroups.ENEMY | CollisionGroups.PROJECTILE,

  // Triggers solo detectan al player (sin colisión física)
  TRIGGER: CollisionGroups.PLAYER,

  // Todo (default)
  ALL: CollisionGroups.ALL,
};
