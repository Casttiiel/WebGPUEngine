FIXES------------------------------------------

1. Irradiance ambient
2. OnResizeEnd event
3. (Metallic/Roughness good? Check other sponzas- Reflectance)
4. Tweakpane
5. Github pages
6. Fix Spot Lights
7. Fix spot lights with shadows (shadow quality on component info) (shadow tap reduced)
8. Compute-based distortion

HIGH-END-FEATURES------------------------------

1. Physically Based BRDF (Cook-Torrance, GGX NDF, Schlick Fresnel, Smith geometry)
2. Diffuse IBL (irradiance map, prefiltered cube)
3. Specular IBL (pre-filtered envmap mip chain + BRDF LUT for Fresnel/roughness integration)
4. Screen Space Ambient Occlusion (SSAO / GTAO / HBAO+)
5. Specular Occlusion
6. Transparencias / Subsurface Scattering (SSS)
7. Decals selective writing / Parallax / Detail maps
8. Volumetric lighting
9. Auto exposure(HAY BRANCH)
10. Color Grading
11. Depth of Field (DOF)
12. Motion Blur
13. Volumetric effects: Fog, volumetric lighting, light shafts.
14. TAA / MSAA: Anti-aliasing temporal o multi-sample.
15. Sharpening / Upscaling: FidelityFX CAS, DLSS/FSR/XeSS si es posible.
16. Particles
17. Lens Flare
18. CSM: 3-cascade system
19. Move objects with mouse
20. Indirect light (Indirect diffuse/Specular)
21. Volumetric fog
22. Area Light
23. Atmospheric scattering
24. Global Ilumination
25. Multiple Lights: Shadow atlas system
26. Shadow mapping (PCF/PCSS, cascaded for directional)

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
God rays
