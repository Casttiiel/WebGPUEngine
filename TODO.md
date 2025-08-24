FIXES------------------------------------------

1. Diffuse IBL (irradiance map, prefiltered cube)
2. Specular Occlusion
3. (Metallic/Roughness good? Check other sponzas- Reflectance)
4. OnResizeEnd event
5. Github pages
6. Fix Spot Lights
7. Fix spot lights with shadows (shadow quality on component info) (shadow tap reduced)
8. Compute-based distortion

HIGH-END-FEATURES------------------------------

1. Volumetric lighting
2. Auto exposure(HAY BRANCH)
3. Motion Blur
4. Tweakpane
6. Particles
7. CSM: 3-cascade system
8. Move objects with mouse
9. Indirect light (Indirect diffuse/Specular)
10. Volumetric fog
11. Shadow mapping (PCF/PCSS, cascaded for directional)
12. Lens Flare
13. Area Light
14. Atmospheric scattering
15. Global Ilumination

IMPROVEMENTS------------------------------------------

1. Specular IBL (pre-filtered envmap mip chain + BRDF LUT for Fresnel/roughness integration)
2. Screen Space Ambient Occlusion (GTAO / HBAO+)
3. Subsurface Scattering (SSS)
4. Decals selective writing / Parallax / Detail maps
5. TAA / MSAA: Anti-aliasing temporal o multi-sample.

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
