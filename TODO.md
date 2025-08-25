FIXES------------------------------------------

1. Check other sponzas
2. Github pages
3. Compute-based distortion
4. New sponza, gltf loader
5. Fix Spot Lights
6. Fix spot lights with shadows (shadow quality on component info) (shadow tap reduced)

HIGH-END-FEATURES------------------------------

1. Auto exposure(HAY BRANCH)
2. CSM: 3-cascade system
3. Volumetric lighting/fog
4. Motion Blur
5. Tweakpane (scenes/cleanup)
6. Specular Occlusion
7. Particles
8. Move objects with mouse
9. Shadow mapping (PCF/PCSS, cascaded for directional)
10. Lens Flare
11. Area Light
12. Atmospheric scattering
13. Global Ilumination

IMPROVEMENTS------------------------------------------

1. Diffuse IBL (irradiance map, prefiltered cube)
2. Specular IBL (pre-filtered envmap mip chain + BRDF LUT for Fresnel/roughness integration)
3. Screen Space Ambient Occlusion (GTAO / HBAO+)
4. Subsurface Scattering (SSS)
5. Decals selective writing / Parallax / Detail maps
6. TAA / MSAA: Anti-aliasing temporal o multi-sample.
7. SSR raymarching algorithm

MAJOR-UPGRADES------------------------------------------

1. **ASYNC LOADING SYSTEM** 🚀

- Implementar sistema de carga asíncrona progresiva con prioridades
- ResourceManager con carga en background y LOD
- Progress indicators y loading states
- Streaming de recursos bajo demanda

2. Scene selector on Tweakpane
3. Escalabilidad de Luces
   Moderno: Cientos de luces con clustered culling+instancing
4. Occlusion culling / Multi-Strategy Culling System
5. GPU-Driven Rendering
6. Mesh LOD
7. Buffer Reuse y Pooling

GAME-----------------------------------

Terrain with perlin noise
Weighted terrain
Test Camera Mixer/Use Correct camera again/TweakPane for Camera Mixer
Music
Physics
Animations
Skybox with Day/Night Cycle
Day/Night Cycle
Grass
Physics Grass
Paralax Mapping (Needs height map!)
Grain
Camera Lens Dirt
Depth of Field (DOF)
