### Engine

1. Froxel Volumetric Scattering: Spot Light Injection
2. Froxel Volumetric quality
3. Froxel Volumetric Scattering Fix Banding (Bilateral filtering result)
4. Fix Player movement

5. Camera Uniforms missleading names
6. Open Editor multiple times, creates data multiple times
7. Bloom Shape
8. Contact Shadows
9. CSM: Logarithmic depth o reversed-Z or less max shadow distance
10. Reflection Probes con blending

11. Blender Export with player spawn
12. Editor Light Probes (Render Debug / Gizmo)
13. Editor Point Lights (Render Debug / Gizmo / Menu)
14. Editor Spot Lights (Render Debug / Gizmo / Menu)
15. Asset Browser + Spawn + Delete

16. Motion blur weird error
17. Point Light shadows
18. Quality settings selection
19. Improve particles
20. Multiple Light probes has good shadows?
21. Weird line on corners is irradiance because of normals

### Bugs

1. Snap to ground
2. Camera not following correct the mesh
3. Jump to ledge of same wall i am wallruning -> disableMantleAfterWallJumpTime?
4. WallRun after timer can go to wallrun again
5. Dash end speed/direction + Conserva 80% de velocidad previa
6. Dash not working
7. Roll not working
8. Swing Bar not working
9. Swing Bar needs to be picked with some angle

## Gameplay

1. Door
2. Enemy

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?

## Questions

PROBLEMA:

Muchos engines renderizan volumetric en un buffer separado y luego componen.

Si estás haciendo blending directo:

⚠️ OJO: el alpha channel no siempre se usa como esperas en WebGPU

Además, NO estás atenuando correctamente la escena si:

Hay múltiples passes

HDR resolve

Tonemap después

PRO RECOMENDADO (más robusto):

Hazlo en un composite shader explícito:

sceneColor.rgb = sceneColor.rgb \* T + S;

Y no dependas del fixed function blending para esto.

👉 Esto solo ya puede duplicar visibilidad de shafts.
