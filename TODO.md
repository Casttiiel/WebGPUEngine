### Engine

1. Froxel Volumetric Scattering
   Spot Light Injection
2. Camera UpdateUniforms occurs always
3. Camera Uniforms missleading names
4. AO
5. Bloom Shape
6. Lightmaps / Baked GI
7. Reflection Probes con blending
8. Contact Shadows
9. Shadow filtering mejor: PCF 5x5 adaptativo/PCSS
10. Light cookies
11. Froxel Volumetric Scattering Fix Banding (Blur result)

12. Fix Player movement
13. Blender Export with player spawn
14. Light/Shadow bug on level-1?

15. Editor Light Probes (Render Debug / Gizmo)
16. Editor Point Lights (Render Debug / Gizmo / Menu)
17. Editor Spot Lights (Render Debug / Gizmo / Menu)
18. Asset Browser + Spawn + Delete

19. Froxel Volumetric/Height Fog based on quality
20. Motion blur weird error
21. Point Light shadows
22. Quality settings selection
23. Improve particles
24. Multiple Light probes has good shadows?
25. Weird line on corners is irradiance because of normals

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
