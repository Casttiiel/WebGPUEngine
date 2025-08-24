FIXES------------------------------------------

1. Screen Space Reflections (Change quality)(Window resize)(What happens with specular calcs)(Fallback/Disabled SSR -> fallback) (Skybox reflection) (Metallic/Roughness good? Check other sponzas)
2. OnResizeEnd event
3. Fix Spot Lights
4. Fix spot lights with shadows (shadow quality on component info) (shadow tap reduced)
5. Tweakpane
6. Github pages
7. Compute-based distortion

HIGH-END-FEATURES------------------------------

1. Indirect light (Indirect diffuse/Specular)
2. Everything is so plain?
3. Volumetric lighting
4. Light Exposure (For now is immediate, but wrong)(HAY BRANCH)
5. Lens Flare
6. Motion Blur
7. Temporal Anti-Aliasing (TAA) / Aliasing quality
8. Decals selective writing
9. Particles
10. CSM: 3-cascade system
11. Move objects with mouse
12. Volumetric fog
13. Area Light
14. Atmospheric scattering
15. Global Ilumination
16. Adaptive Bias: Surface angle-based slope-scaled bias
17. Multiple Lights: Shadow atlas system
18. PCSS: Variable filter size
19. VSM: Variance Shadow Maps

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
