### Engine

1. Enemy AI
   Fase 1 — Algo que ya funciona esta semana
   ├── V Blackboard (Map<string, any>)
   ├── BehaviorTree framework (Sequence, Selector, Action, Condition)
   ├── EnemyControllerComponent (kinematic controller + desiredVelocity)
   └── Perception (raycast LOS + radius check)
   → Con esto tienes un enemigo que ve al jugador y se mueve hacia él en línea recta

   Fase 2 — Navegación real
   ├── Waypoint graph (authorado en Blender → JSON)
   ├── A\* sobre el grafo
   └── PathFollower / Steering (seek + arrive)
   → El enemigo ahora rodea obstáculos

   Fase 3 — Polish
   └── AnimationStateMachine driven by BT state
   (idle → patrol → chase → attack)

2. UI
3. Gameplay

## Gameplay

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection

### Editor

1. Editor Point Lights (Render Debug / Gizmo / Menu)
2. Editor Spot Lights (Render Debug / Gizmo / Menu)
3. Editor Light Probes (Render Debug / Gizmo)
4. Editor Camera (Render Debug / Gizmo / Menu)
5. Blender Export with player spawn
6. Asset Browser + Spawn + Delete
