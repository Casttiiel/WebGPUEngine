### Engine

1. GLTF Glass
2. SSR (One direction good, others bad)
3. Gameplay
4. Decals error on some places

## Gameplay

1. Actions: Jump, Wall Run, Horizontal Wall Jump, Mantle, Vertical Wall Jump, Fast Fall, Slide
2. Blur on borders
3. Momentum
4. Jump right on change inclination and then wallrun

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection

## Rendering

1. **Weighted Blended OIT** para `RenderCategory.GLASS` (cristales, agua, vidrios)
   - Dos render targets: `accumulation` (RGBA16F) + `revealage` (R8)
   - Compose pass sobre la escena opaca tras el forward pass
   - Sin sorting CPU, sin artifacts de orden de renderizado
   - `RenderCategory.TRANSPARENT` mantiene blend aditivo actual (partículas, VFX)

### Editor

1. Editor Point Lights (Render Debug / Gizmo / Menu)
2. Editor Spot Lights (Render Debug / Gizmo / Menu)
3. Editor Light Probes (Render Debug / Gizmo)
4. Editor Camera (Render Debug / Gizmo / Menu)
5. Blender Export with player spawn
6. Asset Browser + Spawn + Delete
