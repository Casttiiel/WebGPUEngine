---------------------------------------Wishlist Backlog-----------------------------------

1. Spawn/Delete items having in mind Instancing
2. Parallax Mapping
3. Progressive texture streaming o mip streaming
4. Mesh Collider
5. DOF adaptative
6. Lens distorsion + chromatic aberration RE4
7. FSR 1.0
8. TAA
9. SS Global Illumination
   Animations
   Pre-multiplied Alpha Solids (Cristal)
   Auto exposure
   GPUDrivenRendering with indirect draw calls and frustum culling on GPU
   Tool for asset creation (Pregenerar AABBs y tangentes)
   Grain
   Lens Flare
   Atmospheric shadowing
   Area Light (LTC (Linearly Transformed Cosines) for shadows)
   Subsurface Scattering (SSS) (If we need to extend the gbuffer, work on decals normals)
   Weighted terrain
   Grass
   Physics Grass
   Mesh LOD
   Light Clustered culling + instancing
   Occlusion culling
   TrimSheets
   CRT Shader

Setup (one-time)

1. Download the basisu binary → github.com/BinomialLLC/basis_universal/releases
   Place at scripts/bin/basisu.exe

2. Download the browser WASM transcoder (2 files from Three.js CDN):

Place both in public/basis/

Compress your textures
The script auto-detects sRGB vs linear from filename patterns (normal, metallic, roughness → linear; everything else → sRGB). Mips are baked in.

How the engine uses them
The flow in Texture.getAsync('sponza/wall.png'):

Tries assets/textures/sponza/wall.ktx2 via a direct fetch()
If 200 OK → KTX2Loader.decode() → transcode UASTC → BC7 → upload all embedded mips → done (no MipmapGenerator needed)
If 404 → falls back to the original PNG/WebP path silently
If the WASM transcoder fails to load → permanently disables KTX2 for the session, always uses fallback
The first KTX2 load triggers one WASM init (lazy, cached), shown as [KTX2Loader] Basis Universal transcoder ready.

Expected gains
Metric Before After
Texture load time (~100 textures) ~4000ms CPU decode ~400ms GPU upload
GPU memory 100% (RGBA8) ~25% (BC7 = 4:1 ratio)
Runtime MipmapGenerator calls per-texture zero (baked)
Fallback if .ktx2 missing — transparent, uses original
