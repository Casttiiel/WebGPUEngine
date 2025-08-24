FIXES------------------------------------------

1. Diffuse IBL (irradiance map, prefiltered cube)
2. Specular Occlusion
3. Check other sponzas
4. OnResizeEnd event
5. Github pages
6. Compute-based distortion
7. New sponza, gltf loader
8. Fix Spot Lights
9. Fix spot lights with shadows (shadow quality on component info) (shadow tap reduced)

HIGH-END-FEATURES------------------------------

1. Auto exposure(HAY BRANCH)
2. CSM: 3-cascade system
3. Volumetric lighting/fog
4. Motion Blur
5. Tweakpane (scenes/cleanup)
6. Particles
7. Move objects with mouse
8. Shadow mapping (PCF/PCSS, cascaded for directional)
9. Lens Flare
10. Area Light
11. Atmospheric scattering
12. Global Ilumination

IMPROVEMENTS------------------------------------------

1. Specular IBL (pre-filtered envmap mip chain + BRDF LUT for Fresnel/roughness integration)
2. Screen Space Ambient Occlusion (GTAO / HBAO+)
3. Subsurface Scattering (SSS)
4. Decals selective writing / Parallax / Detail maps
5. TAA / MSAA: Anti-aliasing temporal o multi-sample.
6. SSR raymarching algorithm

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
