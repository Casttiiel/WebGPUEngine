### Engine

1. GLTF Exporter unifies metallic and roughness? In right channel?
2. Screen vibing
3. Enemy AI / NavMesh
4. Indirect Lighting / GI — tienes SSGI pero está limitado a lo visible en pantalla. Agregar un sistema de Light Probes dinámicos o Lumen-style GI con SDF sería enorme. Al menos: Light Propagation Volumes o Irradiance Field estáticos.
5. Screen-Space Global Illumination (SSGI proper) — ya lo tienes en wishlist. La impl correcta con radiance cache o cone tracing contra el depth buffer daría rebotes de luz realistas.

## Gameplay

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection

### Non Priority

1. Epipolar light scattering
2. Water Shader Reflections + Better Foam
3. Editor Point Lights (Render Debug / Gizmo / Menu)
4. Editor Spot Lights (Render Debug / Gizmo / Menu)
5. Editor Camera (Render Debug / Gizmo / Menu)
6. Asset Browser + Spawn + Delete
7. Mesh LOD
8. Virtual Textures / Texture Streaming — ya en wishlist. Sin streaming, escenas grandes explotan en VRAM.
9. Contact Shadows — sombras de alta frecuencia cerca de los contactos geométricos. Complementan las CSM en zonas donde las cascades tienen resolución baja.
