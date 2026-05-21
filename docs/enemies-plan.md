# Enemy Implementation Plan

## Architecture Overview

All enemies extend `EnemyControllerComponent` (subclass pattern, confirmed by `SpiderControllerComponent`).  
Each subclass overrides `buildTree()` to define its unique Behavior Tree.  
Shared mechanics live in reusable BT nodes and components.

```
EnemyControllerComponent (base — already exists)
├── PassiveRangerController      (Enemigo A)
├── AggressiveRangerController   (Enemigo B)
├── FastMeleeController          (Enemigo C)
├── TankMeleeController          (Enemigo D)
└── HeavyMixedController         (Enemigo E)
```

---

## Phase 0 — Shared Infrastructure (prerequisite for all)

These must be built first because multiple enemies depend on them.

### 0.1 `MeleeAttackComponent`

**File:** `src/components/game/combat/MeleeAttackComponent.ts`  
**Used by:** C, D, E

Handles close-range melee with optional AoE:

```ts
type MeleeAttackData = {
  attackRange: number; // trigger distance (e.g. 1.8)
  damage: number; // direct hit damage
  aoeRadius?: number; // if > 0, damages all enemies+player in radius
  cooldown: number; // seconds between attacks
  recoveryTime?: number; // seconds the enemy is "stunned" post-swing
};
```

- `canAttack(playerPos, selfPos): boolean` — distance check + cooldown
- `attack(center): void` — applies `Msg.damage` to all entities within `aoeRadius`
- Returns a `recoveryTimer` flag readable by the owning controller's BT

---

### 0.2 `FleeAction` (BT node)

**File:** `src/ai/nodes/FleeAction.ts`  
**Used by:** A

Maintains maximum distance from the player. Strategy:

- If player is within `fleeRadius`: move directly away + lateral component to avoid geometry lock
- If line of sight is lost: slow reposition to recover sight
- Every 0.5 s checks for peer enemies → applies a gentle separation push (same pattern as `ShootAction`'s `K_SEP_PUSH`)

```ts
interface FleeActionOptions {
  fleeRadius: number; // max desired distance, retreat if player closer (e.g. 14)
  minFleeRadius: number; // stop retreating at this distance (e.g. 10)
  lateralFlipInterval: number; // seconds between lateral direction flips (e.g. 1.5)
}
```

---

### 0.3 `HomingProjectileComponent`

**File:** `src/components/game/combat/HomingProjectileComponent.ts`  
**Used by:** B

Extends `ProjectileComponent`. On each `update()` applies a slight angular correction toward the tracked player position.

```ts
type HomingProjectileData = ProjectileComponentData & {
  trackingStrength: number; // radians/second of max turn (e.g. 1.2 — not pure homing)
};
```

- Reads player position from `Engine.getEntities().getEntityByName('Player')` (lazy)
- Caps angular correction to `trackingStrength * dt` so it curves but doesn't fully home
- Falls back to straight flight if player not found

---

### 0.4 `ChargeAction` (BT node)

**File:** `src/ai/nodes/ChargeAction.ts`  
**Used by:** C

Drives a charge + overshoot + recovery loop:

States (stored in Blackboard under `_chargeState`):

- `IDLE` → transitions to `CHARGING` when `canSeePlayer`
- `CHARGING` — moves toward player at `chargeSpeed`, applies limited turn radius (`maxTurnRate` rad/s)
- `OVERSHOT` — triggered when enemy passes the player (dot product reverses). Locks movement for `recoveryTime` seconds
- `RECOVERY` — countdown, then back to `IDLE`

```ts
interface ChargeActionOptions {
  chargeSpeed: number; // e.g. 10
  maxTurnRate: number; // rad/s, limits cornering ability (e.g. 1.8)
  recoveryTime: number; // e.g. 1.0
  meleeRange: number; // triggers MeleeAttackComponent (e.g. 1.5)
}
```

The `OVERSHOT` recovery window is the enemy's deliberate vulnerability — no movement, takes full damage.

---

### 0.5 `WeakPointComponent`

**File:** `src/components/game/combat/WeakPointComponent.ts`  
**Used by:** D

Attached to a **child entity** that represents the weak spot mesh/hitbox.  
Intercepts `MsgType.ON_DAMAGE` and multiplies damage if the hit projectile is `blood_explosive_projectile` (tagged via `Msg.damage` `instigatorTag` field, or by checking the projectile type).

```ts
type WeakPointData = {
  damageMultiplier: number; // e.g. 5.0
  projectileTag?: string; // only amplify this tag, e.g. 'blood_explosive'
};
```

Requires adding an optional `tag?: string` field to `Msg.damage` payload so projectiles can self-identify.

---

## Phase 1 — Enemigo A: Rango Pasivo

**Controller:** `PassiveRangerController`  
**File:** `src/components/game/PassiveRangerController.ts`  
**Loader key:** `passive_ranger_controller`

### Behavior Tree

```
Selector [reactive]
├── Sequence [canSeePlayer]
│   ├── FleeAction          ← moves away / lateral, maintains max distance
│   └── SingleShotAction    ← fires every 2 s (burstSize=1, burstPause=2)
├── Sequence [hasLastKnown]
│   └── ...reposition to recover LoS (slow, direct movement)
└── Idle
```

### Movement parameters

- `moveSpeed: 2.5` (slow)
- `FleeAction.fleeRadius: 14`, `minFleeRadius: 10`
- Lateral flee flip every `1.5 s`

### Projectile

- New prefab: `gameplay/passive_blob.prefab`
- Component: `projectile` (base `ProjectileComponent`) with `speed: 7`, `gravity: 1.5`, `damage: 8`
- Pool: `PassiveBlobManager`, size 4
- Visually large and slow — big mesh scale, distinct material

### `ShootAction` config

```ts
new ShootAction('SlowShot', {
  poolName: 'PassiveBlobManager',
  burstSize: 1,
  burstPause: 2.0,
  fireRate: 1,
  optimalMin: 10,
  optimalMax: 14,
  maxRange: 16,
});
```

_Note:_ `ShootAction`'s built-in movement logic conflicts with `FleeAction`. Either:

- Extend `ShootAction` with a `noMovement` flag so only the firing logic runs while `FleeAction` handles movement, OR
- Split into a dedicated `FireOnlyAction` (simpler approach — just shoot without moving)

**Recommended:** Create `FireOnlyAction` (BT node, ~30 lines) that only handles the burst/cooldown fire logic without any movement. Reusable for A and E's vulnerable window.

### Group behavior

`FleeAction` must enforce **minimum peer distance** (≥ 5 m from other `passive_ranger_controller` entities). Already similar to `ShootAction`'s separation — extract into a shared `SeparationHelper` utility.

### Stats

- `health: 30`
- `moveSpeed: 2.5`

### Files to create/modify

- `src/components/game/PassiveRangerController.ts` — new
- `src/ai/nodes/FireOnlyAction.ts` — new (shoot without moving)
- `src/ai/nodes/FleeAction.ts` — new (Phase 0.2)
- `public/assets/prefabs/gameplay/passive_blob.prefab` — new
- `public/assets/prefabs/characters/passive_ranger.prefab` — new
- `src/core/loaders/Loader.ts` — register `passive_ranger_controller`

---

## Phase 2 — Enemigo B: Rango Agresivo

**Controller:** `AggressiveRangerController`  
**File:** `src/components/game/AggressiveRangerController.ts`  
**Loader key:** `aggressive_ranger_controller`

### Behavior Tree

Reuses the default `EnemyControllerComponent.buildTree()` almost verbatim — just swap `ShootAction` params.  
Override `buildTree()` only to pass custom `ShootActionOptions`.

### Movement parameters

- `moveSpeed: 5.5` (medium-fast)
- `ShootAction` arcs — already implemented, just tune `optimalMin/Max`

### Projectile

- New component: `HomingProjectileComponent` (Phase 0.3)
- New prefab: `gameplay/homing_shot.prefab`
- `speed: 16`, `trackingStrength: 1.2`, `damage: 15`, `gravity: 0`
- Pool: `HomingBulletManager`, size 6

### `ShootAction` config

```ts
new ShootAction('HomingShot', {
  poolName: 'HomingBulletManager',
  burstSize: 2,
  burstPause: 1.5,
  fireRate: 3.0,
  optimalMin: 6,
  optimalMax: 15,
  maxRange: 25,
});
```

### Stats

- `health: 80`
- `moveSpeed: 5.5`

### Files to create/modify

- `src/components/game/AggressiveRangerController.ts` — new (minimal, just overrides buildTree params)
- `src/components/game/combat/HomingProjectileComponent.ts` — new (Phase 0.3)
- `public/assets/prefabs/gameplay/homing_shot.prefab` — new
- `public/assets/prefabs/characters/aggressive_ranger.prefab` — new
- `src/core/loaders/Loader.ts` — register `aggressive_ranger_controller`, `homing_projectile`

---

## Phase 3 — Enemigo C: Melee Rápido

**Controller:** `FastMeleeController`  
**File:** `src/components/game/FastMeleeController.ts`  
**Loader key:** `fast_melee_controller`

### Behavior Tree

```
Selector [reactive]
├── Sequence [canSeePlayer]
│   └── ChargeAction    ← charges, overshoots, recovers
├── Sequence [hasLastKnown]
│   └── moveDirectlyTo 'playerPosition'
├── Sequence [notAtHome]
│   └── ReturnAction
└── Idle
```

`ChargeAction` internally owns all states (CHARGING → OVERSHOT → RECOVERY) so the BT just runs it as a single `RUNNING` node.

### `ChargeAction` config

```ts
new ChargeAction({
  chargeSpeed: 10,
  maxTurnRate: 1.8, // limited — strafe brusco makes it overshoot
  recoveryTime: 1.0,
  meleeRange: 1.5,
});
```

### Melee attack (inside `ChargeAction`)

When within `meleeRange`: call `MeleeAttackComponent.attack()`, then set `recoveryTimer`.

- `damage: 35`, `cooldown: 0.5`, `recoveryTime: 0.5`

### Stats

- `health: 40`
- `moveSpeed: 10` (during charge, base ignored — `ChargeAction` sets its own speed)

### Files to create/modify

- `src/components/game/FastMeleeController.ts` — new
- `src/ai/nodes/ChargeAction.ts` — new (Phase 0.4)
- `src/components/game/combat/MeleeAttackComponent.ts` — new (Phase 0.1)
- `public/assets/prefabs/characters/fast_melee.prefab` — new
- `src/core/loaders/Loader.ts` — register `fast_melee_controller`

---

## Phase 4 — Enemigo D: Melee Tanque

**Controller:** `TankMeleeController`  
**File:** `src/components/game/TankMeleeController.ts`  
**Loader key:** `tank_melee_controller`

### Behavior Tree

```
Selector [reactive]
├── Sequence [canSeePlayer]
│   ├── AoEMeleeAction    ← when player < meleeRange, swing + retreat step
│   └── AdvanceAction     ← slow constant advance toward player
├── Sequence [notAtHome]
│   └── ReturnAction (slow)
└── Idle
```

`AoEMeleeAction`: new BT node, or handled directly inside the controller's `buildTree()` using a `Condition(playerInMeleeRange)` + `Action(doAoESwing)` inline.  
**Recommended inline Action** — short logic, no reason for a separate file.

### Advance movement

A simple inline `Action('Advance')` that calls `self.setDesiredHorizontal(toPlayer)` every tick — tank never stops moving.

### Weak point

Child entity `WeakPoint` with `WeakPointComponent`:

- `damageMultiplier: 5.0`
- `projectileTag: 'blood_explosive'`
- Must add `tag` field to `ProjectileComponent` base and to `Msg.damage`

### `MeleeAttackComponent` config

- Direct: `damage: 50`, `aoeRadius: 2.5`, `damageOnAll: true`
- AoE swing triggers when player within `2.5 m`
- `cooldown: 1.2`, `recoveryTime: 0`

### Stats

- `health: 300`
- `moveSpeed: 2.0`
- Base dagger damage vs tank (without weak point): `×0.2` multiplier — implement as a `damageResistance` field on `EnemyControllerComponent` that scales incoming `Msg.damage` before applying to health

### Required base changes

- `EnemyControllerComponent`: add `damageResistance: number` field (0..1, multiplied against incoming damage) — configure via `enemy_controller` JSON data
- `Msg.damage` payload: add optional `sourceTag?: string` field
- `ProjectileComponent`: add `sourceTag?: string` field, written into damage msg on hit

### Files to create/modify

- `src/components/game/TankMeleeController.ts` — new
- `src/components/game/combat/WeakPointComponent.ts` — new (Phase 0.5)
- `src/components/game/combat/MeleeAttackComponent.ts` — (already created in Phase 0.1)
- `src/components/game/EnemyControllerComponent.ts` — add `damageResistance` support
- `src/components/game/ProjectileComponent.ts` — add `sourceTag` field
- `src/core/ecs/Msg.ts` — add `sourceTag` to damage payload type
- `public/assets/prefabs/characters/tank_melee.prefab` — new (includes child WeakPoint entity)
- `src/core/loaders/Loader.ts` — register `tank_melee_controller`, `weak_point`

---

## Phase 5 — Enemigo E: Mixto

**Controller:** `HeavyMixedController`  
**File:** `src/components/game/HeavyMixedController.ts`  
**Loader key:** `heavy_mixed_controller`

### Behavior Tree

```
Selector [reactive]
├── Sequence [playerInMeleeRange]      ← highest priority: punish aggression
│   ├── AoEMeleeAction                 ← area attack + immediate backstep
│   └── BackstepAction                 ← moves away from player 2-3 m
├── Sequence [canSeePlayer, inBurst]   ← during active burst window
│   └── FireOnlyAction                 ← 3-shot burst, no movement
├── Sequence [canSeePlayer, inPause]   ← 1-second vulnerability window
│   └── VulnerableAction               ← stays still, full damage received (no resist)
├── Sequence [canSeePlayer, tooFar]    ← advance while reloading
│   └── AdvanceAction
└── ...investigate/return/idle
```

The burst/pause state is tracked in Blackboard:

- `_burstShotsRemaining: number`
- `_burstPauseTimer: number` — countdown, when > 0 → vulnerability window

### Projectile

- Base `ProjectileComponent`, no homing: `speed: 22`, `damage: 20`, `gravity: 0`
- Pool: `HeavyBulletManager`, size 6
- Burst: 3 shots, `fireRate: 4`, `burstPause: 2.0`

### Melee

`MeleeAttackComponent`: `damage: 60`, `aoeRadius: 3.0`, `cooldown: 1.5`

### Backstep

Inline `Action('Backstep')`: `setDesiredHorizontal(-toPlayer, 4.0)` for `0.5 s` then clears.

### Stats

- `health: 180`
- `moveSpeed: 4.0`
- `damageResistance: 0` (no resistance — just high health)
- Max 1 per arena (spawn constraint, enforced in scene data)

### Files to create/modify

- `src/components/game/HeavyMixedController.ts` — new
- `src/ai/nodes/FireOnlyAction.ts` — (already created in Phase 1 if done first)
- `src/components/game/combat/MeleeAttackComponent.ts` — (Phase 0.1)
- `public/assets/prefabs/gameplay/heavy_shot.prefab` — new
- `public/assets/prefabs/characters/heavy_mixed.prefab` — new
- `src/core/loaders/Loader.ts` — register `heavy_mixed_controller`

---

## Reusable Component / Node Summary

| Asset                       | Type                 | Used by                               |
| --------------------------- | -------------------- | ------------------------------------- |
| `MeleeAttackComponent`      | Component            | C, D, E                               |
| `FleeAction`                | BT node              | A                                     |
| `FireOnlyAction`            | BT node              | A, E                                  |
| `ChargeAction`              | BT node              | C                                     |
| `HomingProjectileComponent` | Projectile Component | B                                     |
| `WeakPointComponent`        | Component            | D                                     |
| `SeparationHelper`          | Utility (static)     | A, B (already partial in ShootAction) |
| `damageResistance` on base  | Base class field     | D                                     |
| `sourceTag` on Msg.damage   | Payload field        | D (WeakPoint), future                 |

---

## Base Class Changes Required

### `EnemyControllerComponent`

- Add `damageResistance: number` (0 = no resistance, 0.8 = takes 20% damage)
- Handle in `onDamage` message handler (scale `amount` by `1 - damageResistance`)

### `ProjectileComponent`

- Add `sourceTag?: string` field
- Pass `sourceTag` in `Msg.damage` call on `onHit`

### `Msg.ts` / damage payload

- Add `sourceTag?: string` to `DamagePayload`

---

## Suggested Implementation Order

```
Phase 0.1  MeleeAttackComponent
Phase 0.2  FleeAction
Phase 0.3  HomingProjectileComponent
Phase 0.4  ChargeAction
Phase 0.5  WeakPointComponent
Phase 0.X  FireOnlyAction (simple, needed for A & E)
Phase 0.X  Base class changes (damageResistance, sourceTag, Msg.damage)

Phase 1    Enemigo A (PassiveRanger)        — tests FleeAction + FireOnlyAction
Phase 2    Enemigo B (AggressiveRanger)     — tests HomingProjectile + ShootAction reuse
Phase 3    Enemigo C (FastMelee)            — tests ChargeAction + MeleeAttackComponent
Phase 4    Enemigo D (TankMelee)            — tests WeakPoint + damageResistance
Phase 5    Enemigo E (HeavyMixed)           — tests full composite (range+melee)
```

---

## Prefab Structure Reference

Each enemy prefab follows the existing pattern:

```json
{
  "components": {
    "name": "EnemyA",
    "transform": { "position": [0, 0, 0] },
    "capsule_collider": { "bodyType": "DYNAMIC", "lockRotationX": true, "lockRotationZ": true },
    "passive_ranger_controller": { "moveSpeed": 2.5, "gravity": 20 },
    "perception": { "viewDistance": 18, "fovAngle": 120 },
    "health": { "maxHealth": 30 },
    "blood_drain_source": {}
  },
  "children": [
    {
      "components": {
        "name": "PassiveBlobManager",
        "transform": { "position": [0, 0, 0] },
        "bullet_pool": {
          "prefab": "gameplay/passive_blob.prefab",
          "size": 4,
          "projectileType": "projectile"
        }
      }
    }
  ]
}
```
