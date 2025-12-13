## Player

1. Revisit shadows quality tengo (Percentage-Closer Filtering de 16 samples, soft shadows, filtro radius configurable)
   Normal offset (elimina peter-panning)
   Contact hardening básico (variable filterRadius)
2. Mantling
3. Shadows on Light probes
4. Jump hang time
5. Mesh follow wrong
6. Sound
7. Level design
8. Improve particles
9. Loading Bar
10. Froxel Scattering
11. DOF adaptative
12. Directional Lights follow player (If snap to camera frustum, what about shadows from outside of frustum)
13. Cascade shadow mapping (3 cascade)

---

1. Jump to dynamic (what to do? big vs small objects)
2. Sunset overdrive Brushstrokes
3. Weird line on corners is irradiance because of normals
4. Triplanar with instanced fails (Ahora mismo necesitamos crear techniques para cada cosa, isntanced, triplanar, y combinaciones), esto se podria hacer automatico?

Hash basado en world position ⚠️
let random = hash3(wPos) _ 2.0 _ PI;

Pros

✔️ estable en el mundo
✔️ no parpadea

Contras

patrones visibles en planos grandes

aliasing temporal en movimiento rápido

Alternativa pro

Usar screen-space noise o blue noise texture:

random = textureSample(noiseTex, noiseSampler, screenUV).r \* 2π;
