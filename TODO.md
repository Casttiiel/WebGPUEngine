### Engine

6. Partículas: ribbons, meshes, beams

Qué falta: El sistema actual solo hace billboards. UE5's Niagara tiene ribbons (fuego, humo), mesh emitters (fragmentos), beams (rayos)
Impacto visual: Alto para efectos de juego. Explosiones, magia, sangre — todo se ve básico sin ribbons
Esfuerzo: MEDIO-ALTO por cada tipo. Ya tienes compute particles, añadir ribbon requiere strip geometry generado en compute
Estado actual: Solo billboards GPU. Ya tienes el componente trail separado que podría integrarse

8. Reflejos planares (Planar Reflections)

Qué falta: Renderizar la escena desde una cámara reflejada y proyectarla en superficies planas. Esencial para suelos brillantes, espejos, agua estática
Impacto visual: ALTO para escenas con agua o suelos reflectantes. SSR falla en ángulos grazing — planar reflections los cubre
Esfuerzo: MEDIO-ALTO. Render pass adicional con cámara invertida + clip plane
Estado actual: Solo SSR (falla en ángulos grazing y cuando el reflejo sale de pantalla)

10. Contact shadows para point/spot lights

Qué falta: Tus contact shadows solo aplican a la luz direccional. Las luces puntuales no tienen contact shadows — objetos cerca de una lámpara no proyectan su sombra de contacto
Impacto visual: Medio. Muy visible en interiores iluminados con point lights
Esfuerzo: MEDIO. Extensión del sistema actual para otras luces
Estado actual: Solo directional light contact shadows

11. Hi-Z SSR (mejor calidad de reflecciones)

Qué falta: Tu SSR usa ray marching lineal. UE5 usa Hi-Z (Hierarchical Z) que permite pasos exponenciales — llega mucho más lejos con menos samples, menos banda de ruido
Esfuerzo: MEDIO. Usa el HZB que ya tienes construido
Estado actual: Ray march lineal con blue noise

13. Temporal upscaling mejorado (TSR con optical flow)

Qué falta: El TSR actual usa velocity buffer. UE5's TSR usa optical flow para objetos sin velocity (vegetación, partículas)
Esfuerzo: ALTO
Estado actual: TSR con velocity buffer estándar

1. Better foot IK foot angle + walking
2. Character animator
   TurnLeft_90 + TurnRight_90 — pivotes en sitio cuando estás parado y giras > 45°
   TurnLeft_180 / TurnRight_180 — para inversión de dirección
3. Para IK en giros pequeños: Un LookAt IK en la cabeza/spine cuando el ángulo entre facing y velocity es < 30°. AnimatorComponent.addIkConstraint() ya lo soporta, solo necesitas el nombre del joint en el esqueleto.
4. Editor Camera (Render Debug / Gizmo / Menu)
5. Material Instances
6. [Blender] GLTF Exporter unifies metaltlic and roughness? In right channel?
7. Procedural materials
8. World Partition / Scene Streaming
9. LOD automático para meshes
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
