### Engine

1. Contact shadows para point/spot lights

2. Hi-Z SSR (mejor calidad de reflecciones)

Qué falta: Tu SSR usa ray marching lineal. UE5 usa Hi-Z (Hierarchical Z) que permite pasos exponenciales — llega mucho más lejos con menos samples, menos banda de ruido
Esfuerzo: MEDIO. Usa el HZB que ya tienes construido
Estado actual: Ray march lineal con blue noise

3. Temporal upscaling mejorado (TSR con optical flow)

Qué falta: El TSR actual usa velocity buffer. UE5's TSR usa optical flow para objetos sin velocity (vegetación, partículas)
Esfuerzo: ALTO
Estado actual: TSR con velocity buffer estándar

4. Better foot IK foot angle + walking
5. Character animator
   TurnLeft_90 + TurnRight_90 — pivotes en sitio cuando estás parado y giras > 45°
   TurnLeft_180 / TurnRight_180 — para inversión de dirección
6. Para IK en giros pequeños: Un LookAt IK en la cabeza/spine cuando el ángulo entre facing y velocity es < 30°. AnimatorComponent.addIkConstraint() ya lo soporta, solo necesitas el nombre del joint en el esqueleto.
7. Editor Camera (Render Debug / Gizmo / Menu)
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

Jump / Double Jump
Mantle
Maintain Gravity
Dash
Light Attack
Push Attack
Lift Attack
(Batman Arkham style)

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection
