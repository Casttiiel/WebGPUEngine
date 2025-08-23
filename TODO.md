FIXES------------------------------------------

1. 
2. OnResizeEnd event
3. Screen Space Reflections (Resolution)
4. Fix Spot Lights
5. Fix spot lights with shadows (shadow quality on component info)
6. Tweakpane
7. Github pages
8. Lens Flare
9. Compute-based distortion

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

HIGH-END-FEATURES------------------------------

1. Volumetric lighting
2. Light Exposure (For now is immediate, but wrong)(HAY BRANCH)
3. Motion Blur
4. Temporal Anti-Aliasing (TAA) / Aliasing quality
5. Decals selective writing
6. Particles
7. CSM: 3-cascade system
8. Move objects with mouse
9. Volumetric fog
10. Area Light
11. Atmospheric scattering
12. Global Ilumination
13. Indirect light
14. Adaptive Bias: Surface angle-based slope-scaled bias
15. Multiple Lights: Shadow atlas system
16. PCSS: Variable filter size
17. VSM: Variance Shadow Maps

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
