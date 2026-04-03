# Blender → GLTF Workflow Guide

This document covers every special object type the engine reads from GLTF files exported out of Blender. All of them use Blender **Custom Properties** (Object Properties panel → Custom Properties section) to communicate intent to the loader.

---

## 1. Player Spawn Point

### What it does

Marks the world-space position where the player character is teleported at scene load. Only one spawn point should exist per scene.

### Blender setup

1. Create any object (an **Empty** works best — `Add → Empty → Plain Axes`).
2. Place it where the player should start, at floor level.
3. In the **Object Properties** panel → **Custom Properties**, add:
   - Key: `type`
   - Value: `player_spawn`
4. Export the scene as GLTF (`.glb` recommended).

### How the engine reads it

`GLTFLoader` checks every node's `extras` object. When `extras.type === "player_spawn"` is found on a **non-mesh** node, it creates an invisible entity with a `PlayerSpawnComponent`. `ModuleBoot` then reads `PlayerSpawnComponent.pendingPosition` and teleports the capsule collider of the `Player` entity.

### Notes

- The object does **not** need a mesh. An Empty exports cleanly.
- Rotation and scale are ignored — only world-space translation is used.

---

## 2. NavMesh

### What it does

Defines the walkable area for AI pathfinding. The loader builds a triangle adjacency graph used by the A\* system at runtime. No mesh is rendered for this object.

### Blender setup

1. Create a **Mesh** that covers all walkable floor surfaces. Keep the polygon count low — quads are fine, the exporter triangulates automatically.
2. The mesh should sit flush with (or slightly above) the collision floor.
3. In **Object Properties → Custom Properties**, add:
   - Key: `type`
   - Value: `navmesh`
4. Export together with the level geometry in the same GLTF file.

### How the engine reads it

`GLTFLoader` detects `extras.type === "navmesh"` on mesh nodes **before** any render processing. It extracts the `POSITION` accessor and index buffer, applies the node's world matrix, and passes them to `NavMeshBuilder.build()`. The `NavMesh` singleton is then ready for `AStar.findPath()` queries.

### Notes

- Only **one** navmesh object is supported per scene. If you need multiple areas, merge them into one mesh before exporting.
- The object becomes invisible — no `RenderComponent` or collider is created for it.
- The navmesh does not need to be watertight or closed. Open edges are fine.

---

## 3. Reflection Probes (auto-placement via F7)

Reflection probes can be placed manually in the scene JSON **or** auto-generated at runtime using the NavMesh as a guide.

### Auto-placement (F7)

With the level loaded in the engine (editor mode), press **F7**. The `ProbeAutoPlacement` tool:

1. Seeds candidate positions from every NavMesh triangle centroid + a 3 m grid around each.
2. Casts a ray upward from each candidate. Points with a ceiling hit within 20 m are classified as **interior**.
3. Clusters interior points into 5 × 5 × 5 m cells — one probe per cell at the cluster centroid.
4. Spawns a `reflection_probe` prefab entity at each position with the estimated extents already set.

The spawned probes are live in the scene immediately. You can then press **F8** to bake their cubemaps.

### Manual placement in a scene JSON

Add a probe entity using the prefab:

```json
{
  "prefab": "lighting/reflection_probe.prefab",
  "components": {
    "name": "ReflectionProbe_Corridor",
    "transform": { "position": [4.0, 1.5, 12.0] },
    "reflection_probe": {
      "resolution": 512,
      "extents": [5.0, 3.0, 5.0]
    }
  }
}
```

- `resolution` — cubemap face resolution in pixels (256, 512, or 1024).
- `extents` — half-extents `[x, y, z]` of the influence box in metres. Defaults to `[radius, radius, radius]` if omitted.

### Probe influence and blending

`ProbeManager` computes a **box-intersection weight** for every probe each frame based on the player's position. The two highest-weight probes are blended in the ambient diffuse pass (`ambient.fs`) using a `mix()` between `irradianceMap` and `irradianceMapB`. The blend weight reaches 0 at the edge of the influence box and 1 at the centre.

---

## 4. Baking Reflection Probe Textures (F8)

### What F8 does

Press **F8** in the engine (any mode) to capture and download the cubemaps for every `ReflectionProbeComponent` currently in the scene:

- The main render loop pauses.
- For each probe the engine renders all **6 cubemap faces** at the probe's `resolution` using a temporary `DeferredRenderer` instance (full PBR pipeline, shadows included).
- Two files are downloaded per probe:
  - `<ProbeName>_env_cubemap_T.png` — full environment cubemap used for specular reflections (SSR fallback).
  - `<ProbeName>_irradiance_cubemap_T.png` — lower-resolution irradiance cubemap used for diffuse ambient blending.
- Rendering resumes after all probes are processed.

### Naming convention

The engine derives the texture filenames from `probe.getOwner().getName()`. The entity name **must** match what you reference in the `ReflectionProbeComponent` data. Examples for a probe named `ReflectionProbe_Corridor`:

| File                                                | Usage                       |
| --------------------------------------------------- | --------------------------- |
| `ReflectionProbe_Corridor_env_cubemap_T.png`        | Specular / SSR environment  |
| `ReflectionProbe_Corridor_irradiance_cubemap_T.png` | Diffuse irradiance blending |

### Recommended workflow

1. Place probes (manually or via **F7**).
2. Load the fully lit, furnished scene.
3. Press **F8** — the browser downloads all cubemap PNGs automatically.
4. Move the downloaded files into `public/assets/textures/`.
5. Reload — the `ReflectionProbeComponent` will pick up its own irradiance cubemap at `onAttach()` and register with `ProbeManager` for blending.

### Notes

- Bake **after** all static geometry, lights, and emissive materials are final, otherwise re-baking will be needed.
- The irradiance cubemap is generated at 32 × 32 px per face internally before download; the downloaded PNG is the full-res capture.
- Probe baking includes the **skybox** contribution, so bake with the intended time-of-day set in `environment.json`.
