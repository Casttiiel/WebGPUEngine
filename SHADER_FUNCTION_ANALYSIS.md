# Shader Function Categorization

## � **CRITICAL FINDINGS - .wgsl Code Duplication**

### **URGENT (Do First): Froxel System - Remove 4x Duplication**

**Problem**: FroxelUniforms, VolumetricUniforms structs and 8 froxel functions are **fully duplicated** across 4 compute shaders:

- `froxel_density.compute.wgsl` (100 lines)
- `froxel_light_injection_ambient.compute.wgsl` (236 lines)
- `froxel_light_injection_point.compute.wgsl` (115 lines)
- `froxel_volumetric_integration.compute.wgsl` (200 lines)

**Duplicated Code (~200 lines per file)**:

```wgsl
// Structs (duplicated 4x)
struct FroxelUniforms { ... }           // Grid dimensions, z params
struct VolumetricUniforms { ... }       // Scattering, absorption, fog

// Functions (duplicated 4x with slight variations)
fn froxelZToViewZLog(z: f32) -> f32
fn froxelZToViewZLinear(z: f32) -> f32
fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32>
fn froxelToViewSpace(froxelCoord: vec3<u32>) -> vec3<f32>
fn sliceToDepthLinear(slice: f32) -> f32    // INCONSISTENT - only in integration
fn sliceToDepthLog(slice: f32) -> f32       // INCONSISTENT - only in integration
fn sliceDzLinear(froxelZ: f32) -> f32       // INCONSISTENT - only in integration
fn sliceDzLog(froxelZ: f32) -> f32          // INCONSISTENT - only in integration
```

**Solution**: Create `common/volumetric/` folder:

- `common/volumetric/structs.wgsl` → FroxelUniforms, VolumetricUniforms
- `common/volumetric/froxel.wgsl` → All froxel coordinate/depth functions
- **Benefit**: Eliminates 800+ lines of duplication, ensures consistency

---

### **URGENT (Do First): CSM Shadows - Consolidate 150+ Duplicated Lines**

**Problem**: Full CSM shadow implementation is duplicated in `froxel_light_injection_ambient.compute.wgsl`:

```wgsl
// DirectionalLightUniforms struct
struct DirectionalLightUniforms {
    color: vec3<f32>,
    intensity: f32,
    direction: vec3<f32>,
    numCascades: u32,
    cascadeEndZ: array<f32, 4>,
    cascadeViewProj: array<mat4x4<f32>, 4>,
    // ... more fields
}

// Shadow functions (150+ lines)
fn getShadowFactorCSMBlended(wPos: vec3<f32>, ...) -> f32
fn selectCascade(viewZ: f32, ...) -> i32
fn getShadowFactorCSM(wPos: vec3<f32>, ...) -> f32
fn shadowsTapCSM(homo_coord: vec2<f32>, ...) -> f32
```

**Existing Code**: Same functions exist in:

- `directional_light_accumulation.fs` (main lighting pass)
- `froxel_light_injection_ambient.compute.wgsl` (volumetric)

**Solution**: Create `common/lighting/csm.wgsl`:

- Move all CSM structs and functions to shared include
- **Benefit**: Eliminates 150+ lines of duplication, ensures consistent shadow quality

---

### **URGENT (Do First): Volumetric Structs - Add to common/structs.wgsl**

**Problem**: `FroxelUniforms` and `VolumetricUniforms` are critical engine structs but not in common includes.

**Solution**: Add to `common/structs.wgsl` or create `common/volumetric/structs.wgsl`

---

### **HIGH (Do Second): SMAA Helpers - Organize 447-Line Library**

**Problem**: `smaa_diagonal_helpers.wgsl` is a massive helper library with no organization:

- 447 lines of highly specialized functions
- Multiple categories: math helpers, bilinear decoding, diagonal detection, blending weights
- Used only by SMAA passes but could benefit from splitting

**Solution**: Create `common/post/smaa/` folder:

- `helpers_basic.wgsl` → mad*\*, SMAAMovc*\*, basic math
- `helpers_sampling.wgsl` → SMAASampleLevelZeroOffset, bilinear decoding
- `helpers_diagonal.wgsl` → SMAADetectDiagonals, SMAASearchDiag
- `helpers_blending.wgsl` → BlendingWeightCalculation functions
- **Benefit**: Better organization, selective imports for SMAA passes

---

### **MEDIUM: IBL Sampling - Isolate Reusable Code**

**Problem**: `irradiance_convolution.wgsl` (150 lines) contains IBL-specific sampling that might be reusable:

```wgsl
// Monte Carlo integration helpers
fn hammersley(i: u32, N: u32) -> vec2<f32>
fn radicalInverseVdC(bits: u32) -> f32
fn importanceSampleCosine(xi: vec2<f32>, N: vec3<f32>) -> vec3<f32>
fn generateTBN(N: vec3<f32>) -> mat3x3<f32>
fn uvToDirection(uv: vec2<f32>, face: u32) -> vec3<f32>
```

**Also Contains**: Duplicated `PI` constant (already in common)

**Solution**: Create `common/ibl/` folder:

- `common/ibl/sampling.wgsl` → Hammersley, importance sampling
- `common/ibl/cubemap.wgsl` → uvToDirection, face utilities
- **Benefit**: Reusable for other IBL operations (prefiltering, etc.)

---

## �📊 Current `utils.wgsl` Function Inventory

### Constants (Move to `core/constants.wgsl`)

```wgsl
const PI: f32 = 3.14159265359;
```

---

### Encoding Functions (Move to `encoding/`)

#### Normal Encoding (`encoding/octahedral.wgsl` - ALREADY EXISTS)

```wgsl
✓ encodeNormal(n: vec3<f32>, nw: f32) -> vec4<f32>
✓ decodeNormal(encodedNormal: vec3<f32>) -> vec3<f32>
```

**Status**: Already in separate file, needs cleanup

---

### Math Utilities (Move to `math/`)

#### Random/Noise (`math/noise.wgsl`)

```wgsl
fn noise2D(p: vec2<f32>) -> f32
fn hash2(p: f32) -> vec2<f32>
fn hash3(p: vec3<f32>) -> f32
```

#### Matrix Operations (`math/matrices.wgsl`)

```wgsl
fn get3x3From4x4(mat: mat4x4<f32>) -> mat3x3<f32>
fn computeTBN(inputN: vec3<f32>, inputT: vec4<f32>) -> mat3x3<f32>
```

#### Basic Math (`math/common.wgsl`)

```wgsl
fn saturate(x: f32) -> f32  // clamp(x, 0.0, 1.0)
```

---

### Coordinate Transformations (Move to `math/coordinates.wgsl`)

```wgsl
fn getWorldCoords(uv: vec2<f32>, zlinear: f32, camera: CameraUniforms) -> vec3<f32>
fn get_view_dir(clip_pos: vec3<f32>) -> vec3<f32>
fn get_world_dir(view_dir: vec3<f32>) -> vec3<f32>
fn direction_to_equirect_uv(dir: vec3<f32>) -> vec2<f32>
```

**Dependencies**: Requires `core/uniforms.wgsl` (CameraUniforms)

---

### PBR Functions (Move to `pbr/`)

#### Core PBR (`pbr/core.wgsl`)

```wgsl
// Normal Distribution Function
fn NormalDistribution_GGX(NdotH: f32, roughness: f32) -> f32

// Geometry Function (Schlick-GGX)
fn Geometric_Smith_Schlick_GGX(NdotV: f32, NdotL: f32, roughness: f32) -> f32

// Geometry Function (Correlated)
fn Geometry_SmithGGX_Correlated(NdV: f32, NdL: f32, roughness: f32) -> f32

// Fresnel
fn Fresnel_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32>
fn Fresnel_Schlick_Roughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32>
```

**Dependencies**:

- `core/constants.wgsl` (PI)

**Usage Count**: HIGH (used in all PBR shaders)

#### BRDF (`pbr/brdf.wgsl`)

```wgsl
fn Specular(
    specularColor: vec3<f32>,
    h: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
    roughnessSquared: f32,
    NdL: f32,
    NdV: f32,
    NdH: f32,
    VdH: f32,
    LdV: f32
) -> vec3<f32>

fn Diffuse(pAlbedo: vec3<f32>) -> vec3<f32>
```

**Dependencies**:

- `pbr/core.wgsl` (NDF, Geometry, Fresnel)
- `core/constants.wgsl` (PI)

**Usage Count**: HIGH (lighting calculations)

---

### Shadow Functions (Move to `lighting/shadows.wgsl`)

```wgsl
// Single shadow tap with adaptive bias
fn shadowsTap(
    homo_coord: vec2<f32>,
    coord_z: f32,
    normal: vec3<f32>,
    lightDir: vec3<f32>,
    shadowMap: texture_depth_2d,
    shadowSampler: sampler_comparison
) -> f32

// PCF shadow filtering
fn getShadowFactor(
    wPos: vec3<f32>,
    normal: vec3<f32>,
    lightDir: vec3<f32>,
    lightViewProjOffset: mat4x4<f32>,
    lightShadowStepDivResolution: f32,
    shadowMap: texture_depth_2d,
    shadowSampler: sampler_comparison,
    adaptUVs: bool,
    cascadeIndex: i32
) -> f32
```

**Dependencies**:

- None (self-contained)

**Usage Count**: MEDIUM (shadow-casting lights only)

**Notes**:

- Currently hardcoded 3x3 PCF
- Could be parameterized via defines
- Adaptive bias calculation embedded

---

## 🔍 Include Dependency Analysis

### Most Common Include Combinations

#### Pattern 1: Full Stack (60+ shaders)

```wgsl
#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"
```

**Shaders**: ambient.fs, directional_light.fs, pbr.fs, ssao.fs, etc.

#### Pattern 2: Vertex Shaders (20+ shaders)

```wgsl
#include "common/uniforms"
#include "common/structs"
#include "common/utils"
```

**Shaders**: gbuffer.vs, basic.vs, shadows.vs, etc.

#### Pattern 3: Simple Post-Processing (10+ shaders)

```wgsl
#include "common/uniforms"
```

**Shaders**: fxaa.fs, gaussian_blur.fs, tone_mapping.fs, etc.

#### Pattern 4: Compute Shaders (5+ shaders)

```wgsl
#include "common/uniforms"
#include "common/structs"
```

**Shaders**: bloom*\*.cs, frustum_culling.cs, particle*\*.cs, etc.

---

## 📈 Function Usage Frequency

### High Usage (Used in 15+ shaders)

- `decodeGBuffer()` - GBuffer decode
- `saturate()` - Math helper
- `Fresnel_Schlick()` - PBR
- `NormalDistribution_GGX()` - PBR
- `getWorldCoords()` - Coordinate transform

### Medium Usage (Used in 5-15 shaders)

- `getShadowFactor()` - Shadow mapping
- `Diffuse()` - PBR diffuse
- `Specular()` - PBR specular
- `computeTBN()` - Normal mapping
- `octahedral01ToNormal()` - Normal decoding

### Low Usage (Used in 1-5 shaders)

- `noise2D()` - Noise generation
- `hash2()` / `hash3()` - Random generation
- `direction_to_equirect_uv()` - Skybox
- `get_view_dir()` - Skybox
- `shadowsTap()` - Shadow detail

---

## 🎯 Proposed New Structure with Function Mapping

### `common/core/`

```
constants.wgsl
├── PI
└── (future: EPSILON, MAX_FLOAT, etc.)

uniforms.wgsl
├── CameraUniforms
├── OldCameraUniforms
└── ObjectUniforms

structs.wgsl
├── VertexOutput
├── FragmentOutput
├── GBuffer
├── MaterialFactors
└── SSRUniforms
```

### `common/math/`

```
common.wgsl
└── saturate(x: f32) -> f32

matrices.wgsl
├── get3x3From4x4(mat: mat4x4<f32>) -> mat3x3<f32>
└── computeTBN(inputN: vec3<f32>, inputT: vec4<f32>) -> mat3x3<f32>

coordinates.wgsl
├── getWorldCoords(uv, zlinear, camera) -> vec3<f32>
├── get_view_dir(clip_pos) -> vec3<f32>
├── get_world_dir(view_dir) -> vec3<f32>
└── direction_to_equirect_uv(dir) -> vec2<f32>

noise.wgsl
├── noise2D(p: vec2<f32>) -> f32
├── hash2(p: f32) -> vec2<f32>
└── hash3(p: vec3<f32>) -> f32
```

### `common/encoding/`

```
octahedral.wgsl (EXISTING)
├── encodeOctahedral(normal) -> vec2<f32>
├── decodeOctahedral(encoded) -> vec3<f32>
├── normalToOctahedral01(normal) -> vec2<f32>
└── octahedral01ToNormal(encoded) -> vec3<f32>

normal.wgsl (NEW - from utils.wgsl)
├── encodeNormal(n, nw) -> vec4<f32>
└── decodeNormal(encodedNormal) -> vec3<f32>
```

### `common/pbr/`

```
core.wgsl
├── NormalDistribution_GGX(NdotH, roughness) -> f32
├── Geometric_Smith_Schlick_GGX(NdotV, NdotL, roughness) -> f32
├── Geometry_SmithGGX_Correlated(NdV, NdL, roughness) -> f32
├── Fresnel_Schlick(cosTheta, F0) -> vec3<f32>
└── Fresnel_Schlick_Roughness(cosTheta, F0, roughness) -> vec3<f32>

brdf.wgsl
├── Specular(...) -> vec3<f32>
└── Diffuse(pAlbedo) -> vec3<f32>
```

### `common/lighting/`

```
shadows.wgsl
├── shadowsTap(...) -> f32
└── getShadowFactor(...) -> f32
```

### `common/gbuffer/`

```
decode.wgsl (EXISTING)
└── decodeGBuffer(uv) -> GBuffer
```

---

## 🔀 Migration Examples

### Before (Current):

```wgsl
#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    let F0 = g.specularColor;
    let F = Fresnel_Schlick(NdotV, F0);
    // ... PBR calculations
}
```

### After (New Structure):

```wgsl
#include "common/core/uniforms"
#include "common/core/structs"
#include "common/gbuffer/decode"
#include "common/pbr/core"

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    let F0 = g.specularColor;
    let F = Fresnel_Schlick(NdotV, F0);
    // ... PBR calculations
}
```

**Benefits**:

- ✅ Clear what functions are available
- ✅ Only includes necessary code
- ✅ Better compile times
- ✅ Easier to maintain

---

### Before (Legacy Compatibility Layer):

```wgsl
// common/utils.wgsl (legacy)
#include "common/core/constants"
#include "common/math/common"
#include "common/math/matrices"
#include "common/math/coordinates"
#include "common/math/noise"
#include "common/encoding/normal"
#include "common/pbr/core"
#include "common/pbr/brdf"
#include "common/lighting/shadows"
```

This allows gradual migration without breaking existing shaders.

---

## 📋 Refactoring Checklist

### Per Function:

- [ ] Identify dependencies
- [ ] Determine new file location
- [ ] Move function with documentation
- [ ] Update dependent files
- [ ] Test in actual shader
- [ ] Update migration guide

### Per File:

- [ ] List all functions
- [ ] Map to new structure
- [ ] Create new file
- [ ] Add header comment
- [ ] Add include guards (if needed)
- [ ] Update index

### Per Shader:

- [ ] Identify used functions
- [ ] Map to new includes
- [ ] Update includes
- [ ] Test compilation
- [ ] Test visual output
- [ ] Document changes

---

## 🎓 Function Documentation Template

```wgsl
/**
 * @brief Brief description of function purpose
 * @param paramName Description of parameter
 * @return Description of return value
 * @dependencies List of required includes
 * @usage Example usage
 * @performance Performance notes (if applicable)
 */
fn functionName(params) -> ReturnType {
    // Implementation
}
```

### Example:

```wgsl
/**
 * @brief Calculates Normal Distribution Function using GGX/Trowbridge-Reitz
 * @param NdotH Dot product between normal and half vector [0-1]
 * @param roughness Surface roughness parameter [0-1]
 * @return Microfacet distribution value
 * @dependencies common/core/constants.wgsl (PI)
 * @usage let ndf = NormalDistribution_GGX(dot(N, H), material.roughness);
 * @performance Heavily used in lighting calculations - should be inlined
 */
fn NormalDistribution_GGX(NdotH: f32, roughness: f32) -> f32 {
    let a2 = roughness * roughness;
    let NdotH2 = NdotH * NdotH;
    let num = a2;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    return num / denom;
}
```

---

**Status**: Analysis Complete (Updated with .wgsl files)
**Next Step**: Begin Phase 2 - File splitting and reorganization

---

## 🚨 CRITICAL: Code Duplication in .wgsl Files

### Froxel System Duplication (URGENT)

**Files Affected**: All froxel compute shaders

- `froxel_density.compute.wgsl`
- `froxel_light_injection_ambient.compute.wgsl`
- `froxel_light_injection_point.compute.wgsl`
- `froxel_volumetric_integration.compute.wgsl`

#### Duplicated Structs (Must move to `common/structs.wgsl`):

```wgsl
// ❌ DUPLICATED 4 times
struct FroxelUniforms {
  dimensions: vec4<f32>,
  nearPlane: f32,
  farPlane: f32
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
  stepSize: f32  // Only in some files
}
```

#### Duplicated Functions (Must move to `common/volumetric/froxel.wgsl`):

```wgsl
// ❌ DUPLICATED 4 times (slightly different implementations!)
fn froxelZToViewZLinear(zSlice, slices, nearZ, farZ) -> f32
fn froxelZToViewZLog(z, slices, nearZ, farZ) -> f32
fn computeViewRayFromUV(uv) -> vec3<f32>
fn froxelToViewSpace(froxel) -> vec3<f32>
```

**DANGER**: Each file has **slightly different implementations** - needs consolidation!

---

### Shadow System Duplication

#### In `froxel_light_injection_ambient.compute.wgsl`:

```wgsl
// ❌ Full shadow system duplicated (150+ lines)
fn getShadowFactorCSMBlended(worldPos, viewSpaceDepth) -> f32
fn selectCascade(viewSpaceDepth) -> i32
fn getShadowFactorCSM(worldPos, normal, lightDir, cascadeIndex) -> f32
fn shadowsTapCSM(coord, depth, shadowMap, sampler, cascadeIndex) -> f32
```

**Problem**: This is ~150 lines of shadow code **duplicated** from lighting shaders!

---

### IBL/Cubemap Math Duplication

#### In `irradiance_convolution.wgsl`:

```wgsl
// ❌ Constants duplicated
const PI: f32 = 3.14159265359;
const SAMPLE_COUNT: u32 = 1024u;

// ❌ Functions that should be in common/math/
fn uvToDirection(uv, face) -> vec3<f32>
fn generateTBN(normal) -> mat3x3<f32>
fn radicalInverseVdC(bits) -> f32
fn hammersley(i, N) -> vec2<f32>
fn importanceSampleCosine(xi) -> vec3<f32>
```

**Problem**: IBL sampling code should be shared with other IBL systems!

---

### SMAA Helper Library

#### In `smaa_diagonal_helpers.wgsl` (447 lines!):

```wgsl
// ❌ Massive helper library (should be in common/post/smaa/)
fn mad_f32, mad_vec2, mad_vec4
fn SMAASampleLevelZeroOffset
fn SMAAMovc_vec2, SMAAMovc_vec4
// ... 400+ more lines
```

**Problem**: This is a complete SMAA implementation library - needs proper organization!

---

## 📦 New Includes Required

### `common/volumetric/` (NEW FOLDER)

#### `common/volumetric/froxel.wgsl`

```wgsl
#include "common/core/uniforms"

// Canonical implementations (fix inconsistencies!)
fn froxelZToViewZLinear(zSlice: u32, slices: u32, nearZ: f32, farZ: f32) -> f32
fn froxelZToViewZLog(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32
fn computeViewRayFromUV(uv: vec2<f32>) -> vec3<f32>
fn froxelToViewSpace(froxel: vec3<u32>, froxelParams: FroxelUniforms) -> vec3<f32>
fn worldToView(pWS: vec3<f32>, camera: CameraUniforms) -> vec3<f32>
fn sliceToDepthLinear(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32
fn sliceToDepthLog(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32
fn sliceDzLinear(z: u32, slices: u32, nearZ: f32, farZ: f32) -> f32
```

#### `common/volumetric/structs.wgsl`

```wgsl
struct FroxelUniforms {
  dimensions: vec4<f32>,
  nearPlane: f32,
  farPlane: f32
}

struct VolumetricUniforms {
  fogDensity: f32,
  scatteringCoeff: f32,
  absorptionCoeff: f32,
  stepSize: f32
}
```

---

### `common/lighting/csm.wgsl` (NEW FILE)

```wgsl
#include "common/lighting/shadows"

struct DirectionalLightUniforms {
    color: vec3<f32>,
    hasShadows: f32,
    position: vec3<f32>,
    intensity: f32,
    viewProjOffset0: mat4x4<f32>,
    viewProjOffset1: mat4x4<f32>,
    viewProjOffset2: mat4x4<f32>,
    cascadeSplits: vec4<f32>,
    shadowParams: vec4<f32>,
}

fn selectCascade(viewSpaceDepth: f32, splits: vec4<f32>) -> i32
fn getShadowFactorCSM(worldPos: vec3<f32>, ...) -> f32
fn getShadowFactorCSMBlended(worldPos: vec3<f32>, ...) -> f32
```

---

### `common/ibl/` (NEW FOLDER)

#### `common/ibl/sampling.wgsl`

```wgsl
#include "common/core/constants"
#include "common/math/matrices"

fn radicalInverseVdC(bits: u32) -> f32
fn hammersley(i: u32, N: u32) -> vec2<f32>
fn importanceSampleCosine(xi: vec2<f32>) -> vec3<f32>
fn importanceSampleGGX(xi: vec2<f32>, roughness: f32) -> vec3<f32>
```

#### `common/ibl/cubemap.wgsl`

```wgsl
fn uvToDirection(uv: vec2<f32>, face: u32) -> vec3<f32>
fn directionToUV(dir: vec3<f32>) -> vec2<f32>
fn getCubemapFace(dir: vec3<f32>) -> u32
```

---

### `common/post/smaa/` (NEW FOLDER)

#### `common/post/smaa/helpers.wgsl`

```wgsl
// Move 447 lines from smaa_diagonal_helpers.wgsl
fn mad_f32, mad_vec2, mad_vec4
fn SMAASampleLevelZeroOffset
fn SMAAMovc_vec2, SMAAMovc_vec4
// ... all SMAA helper functions
```

Split into sub-files:

- `helpers_basic.wgsl` - Basic math helpers
- `helpers_sampling.wgsl` - Texture sampling helpers
- `helpers_diagonal.wgsl` - Diagonal detection
- `helpers_blending.wgsl` - Blending weight calculation

---

## 📊 Updated Function Inventory

### Functions Needing New Homes

#### Volumetric/Froxel Functions (8 functions):

- ✅ Move to `common/volumetric/froxel.wgsl`
- Status: HIGH PRIORITY (duplicated 4x)

#### CSM Shadow Functions (4 functions):

- ✅ Move to `common/lighting/csm.wgsl`
- Status: HIGH PRIORITY (duplicated 150+ lines)

#### IBL Sampling Functions (5 functions):

- ✅ Move to `common/ibl/sampling.wgsl`
- Status: MEDIUM PRIORITY (could be reused)

#### Cubemap Utilities (3 functions):

- ✅ Move to `common/ibl/cubemap.wgsl`
- Status: MEDIUM PRIORITY

#### SMAA Helpers (50+ functions):

- ✅ Move to `common/post/smaa/helpers.wgsl`
- Status: MEDIUM PRIORITY (already self-contained)

---

## 🎯 Updated Refactoring Priority

### URGENT (Do First):

1. **Froxel System** - Remove 4x duplication
2. **CSM Shadows** - Consolidate 150+ duplicated lines
3. **Volumetric Structs** - Add to common/structs.wgsl

### HIGH (Do Second):

4. **Split utils.wgsl** - Original plan
5. **IBL System** - Consolidate sampling code
6. **Organize SMAA** - Move to proper folder

### MEDIUM (Do Third):

7. **Generate Mipmap** - Already clean, no changes needed
8. **Documentation** - Update all references
