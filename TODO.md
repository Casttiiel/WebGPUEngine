### Engine

1. Character animator
   TurnLeft_90 + TurnRight_90 — pivotes en sitio cuando estás parado y giras > 45°
   TurnLeft_180 / TurnRight_180 — para inversión de dirección
2. Para IK en giros pequeños: Un LookAt IK en la cabeza/spine cuando el ángulo entre facing y velocity es < 30°. AnimatorComponent.addIkConstraint() ya lo soporta, solo necesitas el nombre del joint en el esqueleto.
3. Foot IK
4. Clouds
5. Anamorphic lens flare
6. Editor Camera (Render Debug / Gizmo / Menu)
8. Material Instances
9. [Blender] GLTF Exporter unifies metaltlic and roughness? In right channel?
10. Procedural materials
11. World Partition / Scene Streaming
12. LOD automático para meshes
    Integrar meshoptimizer (npm, WASM oficial) en el pipeline de carga de Mesh.ts. Al cargar un .glb/mesh, generar 3 niveles de LOD en CPU con meshopt_simplify (error cuadrático). El GPUCullingManager ya tiene distancia a cámara por objeto — seleccionar el LOD activo en el buffer de culling según umbral de distancia configurable. Incluye LOD crossfade con dithering para transiciones invisibles (el campo lodFadeStart ya existe en GrassVolumeComponent, el patrón está definido).

## VFX

1. Grass Influence Map / Chunks
2. Trees Generator / https://www.youtube.com/watch?v=GOfttJQ-FGw
3. Fire https://www.youtube.com/watch?v=Y1ZBzIiP-v4
4. Water Shader Reflections + Better Foam

## Gameplay

Jump landing on two stages WRONG

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection
