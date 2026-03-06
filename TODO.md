### Engine

1. Trails
2. Froxel Self Occlusion
3. Froxel Density Volumes
4. Voxel Cone Tracing
5. Gameplay
6. Enemy AI
   Fase 2 — Navegación real
   ├── Waypoint graph (authorado en Blender → JSON)
   ├── A\* sobre el grafo
   └── PathFollower / Steering (seek + arrive)
   → El enemigo ahora rodea obstáculos

   Fase 3 — Polish
   └── AnimationStateMachine driven by BT state
   (idle → patrol → chase → attack)

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
