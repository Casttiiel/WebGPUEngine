# Shader System Refactorization Roadmap

## 📊 Current State Analysis

### Existing Structure

```
public/assets/shaders/
├── common/
│   ├── uniforms.wgsl      # Uniform structs (Camera, Object)
│   ├── structs.wgsl       # Vertex/Fragment I/O structs, GBuffer
│   ├── utils.wgsl         # PBR functions, math utilities, shadows
│   ├── octahedral.wgsl    # Normal encoding/decoding
│   └── gbuffer.wgsl       # GBuffer decoding logic
├── *.vs                   # Vertex shaders
├── *.fs                   # Fragment shaders
└── *.cs / *.compute.wgsl  # Compute shaders
```

### Current Include Pattern

Most shaders include:

```wgsl
#include "common/uniforms"
#include "common/structs"
#include "common/utils"
#include "common/octahedral"
#include "common/gbuffer"
```

### Problems Identified

1. **Monolithic `utils.wgsl` (209 lines)**

   - PBR functions mixed with math utilities
   - Shadow functions mixed with coordinate transformations
   - IBL functions alongside general helpers
   - Hard to find specific functions

2. **Circular Dependencies Risk**

   - `gbuffer.wgsl` depends on `utils.wgsl`
   - Both contain interdependent functions
   - Could cause issues with complex includes

3. **Redundant Includes**

   - Shaders include files they don't use
   - No granular control over what functions are imported
   - Increases shader compilation size

4. **No Logical Grouping**

   - PBR functions scattered
   - Lighting calculations mixed with utilities
   - No clear separation by functionality

5. **Limited ShaderPreprocessor**
   - Only handles `#include` directives
   - No conditional compilation
   - No macro system
   - No optimization of unused code

---

## 🎯 Refactorization Goals

1. **Modular Organization**: Split by functionality, not by file count
2. **Clear Dependencies**: Well-defined dependency tree
3. **Selective Imports**: Include only what you need
4. **Better Discoverability**: Easy to find specific functions
5. **Enhanced Preprocessor**: Support for more advanced features
6. **Performance**: Reduce final shader size through dead code elimination

---

## 📋 Roadmap Phases

### **Phase 1: Analysis & Documentation** ✅ (COMPLETE)

**Goal**: Understand current usage patterns

#### Tasks:

- [x] Audit all shader files (.fs, .vs, .cs, .wgsl)
- [x] Map include dependencies
- [x] Categorize functions by purpose
- [x] Document current ShaderPreprocessor capabilities
- [x] Analyze .wgsl compute shaders for duplication

#### Deliverables:

- Function categorization document
- Dependency graph
- Usage frequency analysis
- **🚨 CRITICAL: Discovered 800+ lines of code duplication in froxel system**
- **🚨 CRITICAL: Discovered 150+ lines of CSM shadow duplication**

---

### **Phase 1.5: URGENT - Fix Critical .wgsl Duplications** ✅ COMPLETE

**Goal**: Eliminate critical code duplication discovered in compute shaders

**Priority**: **COMPLETE** - Fixed critical duplications:

- 4x duplication in froxel system (800+ lines eliminated)
- CSM shadow duplication between shaders (150+ lines eliminated)
- Fixed ShaderPreprocessor visited set mutation bug
- Engine reliability and maintainability significantly improved

#### Tasks:

**1. Create Volumetric System Includes** (Highest Priority) ✅ COMPLETE

- [x] Create `common/volumetric/` folder
- [x] Create `common/volumetric/structs.wgsl`:
  - Move `FroxelUniforms` struct (from 4 files)
  - Move `VolumetricUniforms` struct (from 4 files)
- [x] Create `common/volumetric/froxel.wgsl`:
  - Move `froxelZToViewZLog()` (from 4 files)
  - Move `froxelZToViewZLinear()` (from 4 files)
  - Move `computeViewRayFromUV()` (from 4 files)
  - Move `froxelToViewSpace()` (from 4 files)
  - Consolidate inconsistent depth functions (`sliceToDepthLinear`, etc.)
- [x] Update 4 compute shaders to use new includes:
  - `froxel_density.compute.wgsl`
  - `froxel_light_injection_ambient.compute.wgsl`
  - `froxel_light_injection_point.compute.wgsl`
  - `froxel_volumetric_integration.compute.wgsl`
- [x] Test volumetric lighting still works correctly

**2. Consolidate CSM Shadow System** ✅ COMPLETE

- [x] Create `common/lighting/csm.wgsl`:
  - Move `DirectionalLightCSMUniforms` struct
  - Move `getShadowFactorCSMBlended()` function
  - Move `selectCascadeCSM()` function
  - Move `getShadowFactorForCascade()` function
  - Move `shadowsTapCSM()` function
  - Move `getCascadeDebugColorCSM()` function
- [x] Update `directional_light_csm.fs` to use new include
- [x] Update `froxel_light_injection_ambient.compute.wgsl` to use new include
- [x] Test CSM shadows work in both lighting and volumetrics
- [x] Fix ShaderPreprocessor visited set mutation bug

**3. IBL Sampling Includes** ✅ COMPLETE

- [x] ✅ Created `common/ibl/sampling.wgsl` with importance sampling functions
- [x] ✅ Created `common/ibl/cubemap.wgsl` with cubemap utilities
- [x] ✅ Updated `irradiance_convolution.wgsl` to use new includes
- [x] ✅ Eliminated ~80 lines of potential duplication
- [x] ✅ Functions now reusable for future IBL features (specular convolution, BRDF LUT, etc.)

#### Results: ✅

- **✅ ShaderPreprocessor Fixed**: Solved visited set mutation bug + duplicate include prevention
- **✅ 1030+ lines of code duplication eliminated** (950 froxel/CSM + 80 IBL)
- **✅ Consistency**: Single source of truth for froxel, CSM, and IBL calculations
- **✅ Bug Prevention**: No more implementation drift between files
- **✅ Maintainability**: Changes to systems only need one edit each
- **✅ Extensibility**: IBL functions ready for future features (specular convolution, BRDF LUT)

---

### **Phase 2: Restructure Common Includes** (DO SECOND)

**Goal**: Break down monolithic files into focused modules

#### New Structure Proposal:

```
public/assets/shaders/
├── common/
│   ├── core/
│   │   ├── uniforms.wgsl          # Uniform structs (no deps)
│   │   ├── structs.wgsl           # Core structs (no deps)
│   │   └── constants.wgsl         # PI, epsilon, etc (no deps)
│   │
│   ├── math/
│   │   ├── coordinates.wgsl       # UV/NDC/World transformations
│   │   ├── matrices.wgsl          # Matrix utilities
│   │   ├── noise.wgsl             # Noise functions
│   │   └── sampling.wgsl          # Sampling patterns (Poisson, etc)
│   │
│   ├── encoding/
│   │   ├── octahedral.wgsl        # Normal encoding/decoding
│   │   ├── depth.wgsl             # Depth encoding utilities
│   │   └── color.wgsl             # Color space conversions
│   │
│   ├── pbr/
│   │   ├── core.wgsl              # NDF, Geometry, Fresnel
│   │   ├── brdf.wgsl              # Full BRDF calculations
│   │   ├── ibl.wgsl               # Image-Based Lighting
│   │   └── material.wgsl          # Material property helpers
│   │
│   ├── lighting/
│   │   ├── common.wgsl            # Shared lighting functions
│   │   ├── shadows.wgsl           # Shadow mapping & PCF
│   │   ├── csm.wgsl               # 🆕 Cascaded Shadow Maps (Phase 1.5)
│   │   ├── point_light.wgsl       # Point light calculations
│   │   ├── spot_light.wgsl        # Spot light calculations
│   │   └── directional.wgsl       # Directional light calculations
│   │
│   ├── gbuffer/
│   │   ├── encode.wgsl            # GBuffer encoding
│   │   ├── decode.wgsl            # GBuffer decoding
│   │   └── structs.wgsl           # GBuffer-specific structs
│   │
│   ├── volumetric/                # 🆕 NEW (Phase 1.5)
│   │   ├── structs.wgsl           # 🆕 Froxel/Volumetric structs
│   │   └── froxel.wgsl            # 🆕 Froxel coordinate functions
│   │
│   ├── ibl/                       # 🆕 NEW (Phase 1.5 optional)
│   │   ├── sampling.wgsl          # 🆕 Importance sampling
│   │   └── cubemap.wgsl           # 🆕 Cubemap utilities
│   │
│   └── post/
│       ├── tonemapping.wgsl       # Tone mapping operators
│       ├── blur.wgsl              # Blur kernels
│       ├── aa.wgsl                # Anti-aliasing helpers
│       ├── dof.wgsl               # Depth of field helpers
│       └── smaa/                  # 🆕 SMAA subfolder (Phase 2)
│           ├── helpers_basic.wgsl      # Basic math helpers
│           ├── helpers_sampling.wgsl   # Texture sampling
│           ├── helpers_diagonal.wgsl   # Diagonal detection
│           └── helpers_blending.wgsl   # Blending weights
```

#### Dependency Hierarchy:

```
Level 0 (No dependencies):
├── core/uniforms.wgsl
├── core/structs.wgsl
└── core/constants.wgsl

Level 1 (Depends on Level 0):
├── math/coordinates.wgsl
├── math/matrices.wgsl
├── math/noise.wgsl
├── encoding/octahedral.wgsl
└── encoding/color.wgsl

Level 2 (Depends on Level 0-1):
├── encoding/depth.wgsl
├── pbr/core.wgsl
└── lighting/common.wgsl

Level 3 (Depends on Level 0-2):
├── pbr/brdf.wgsl
├── pbr/ibl.wgsl
├── lighting/shadows.wgsl
├── gbuffer/encode.wgsl
└── gbuffer/decode.wgsl

Level 4 (High-level functions):
├── lighting/point_light.wgsl
├── lighting/spot_light.wgsl
├── lighting/directional.wgsl
└── post/*.wgsl
```

#### Migration Strategy:

1. Create new folder structure
2. Split `utils.wgsl` into new modules
3. Create legacy `utils.wgsl` that includes all new modules (backwards compatibility)
4. Migrate shaders one by one to new includes
5. Remove legacy files once migration complete

#### Tasks:

- [ ] Create new folder structure
- [ ] Split `utils.wgsl` by function category
- [ ] Create dependency-free core files
- [ ] Implement legacy compatibility layer
- [ ] Document new include patterns

---

### **Phase 3: Enhanced ShaderPreprocessor**

**Goal**: Add advanced preprocessing capabilities

#### New Features:

##### 3.1 Conditional Compilation

```wgsl
#ifdef SHADOWS_ENABLED
    shadow = calculateShadows(...);
#endif

#if QUALITY_LEVEL >= 2
    applyHighQualityEffects();
#endif
```

##### 3.2 Macro System

```wgsl
#define MAX_LIGHTS 8
#define SAMPLE_COUNT 16
```

##### 3.3 Function Includes (Selective Import)

```wgsl
#include "pbr/core.wgsl" only(NormalDistribution_GGX, Fresnel_Schlick)
```

##### 3.4 Dead Code Elimination

- Parse shader AST
- Identify used functions
- Remove unused function definitions
- Optimize final output

##### 3.5 Include Guards

```wgsl
#ifndef _PBR_CORE_WGSL_
#define _PBR_CORE_WGSL_
// ... content ...
#endif
```

#### Implementation Plan:

**ShaderPreprocessor Enhancements:**

```typescript
export class ShaderPreprocessor {
  // Existing functionality
  private static cache: Map<string, string>;

  // New capabilities
  private static defines: Map<string, string | number>;
  private static conditionalStack: boolean[];

  // New methods
  public static setDefine(name: string, value: string | number): void;
  public static processConditionals(content: string): string;
  public static processDefines(content: string): string;
  public static selectiveInclude(path: string, functions: string[]): string;
  public static eliminateDeadCode(content: string, entryPoint: string): string;

  // Enhanced preprocessing pipeline
  public static async preprocessShader(
    shaderPath: string,
    defines?: Map<string, any>,
    options?: PreprocessOptions,
  ): Promise<string>;
}
```

#### Tasks:

- [ ] Implement conditional compilation (`#ifdef`, `#if`, `#else`, `#endif`)
- [ ] Implement macro system (`#define`, `#undef`)
- [ ] Add selective import support
- [ ] Implement include guards
- [ ] Add dead code elimination (optional, performance feature)
- [ ] Create preprocessor unit tests
- [ ] Update documentation

---

### **Phase 4: Quality Settings Integration**

**Goal**: Use preprocessor defines for quality-based compilation

#### Concept:

```typescript
// In QualitySettings
const shaderDefines = {
  LOW: {
    SHADOW_PCF_SAMPLES: 4,
    MAX_LIGHTS: 4,
    USE_SSAO: 0,
    USE_SSR: 0,
  },
  MEDIUM: {
    SHADOW_PCF_SAMPLES: 9,
    MAX_LIGHTS: 8,
    USE_SSAO: 1,
    USE_SSR: 0,
  },
  HIGH: {
    SHADOW_PCF_SAMPLES: 16,
    MAX_LIGHTS: 16,
    USE_SSAO: 1,
    USE_SSR: 1,
  },
};
```

#### Shader Usage:

```wgsl
#include "lighting/shadows.wgsl"

fn calculateShadows(...) -> f32 {
  var shadow = 0.0;

  #for i in 0..SHADOW_PCF_SAMPLES
    shadow += sampleShadowMap(...);
  #endfor

  return shadow / f32(SHADOW_PCF_SAMPLES);
}
```

#### Tasks:

- [ ] Define quality-based shader constants
- [ ] Integrate with QualitySettings system
- [ ] Update Technique loader to pass defines
- [ ] Create quality-specific shader variants
- [ ] Test performance impact per quality level

---

### **Phase 5: Shader Validation & Testing**

**Goal**: Ensure correctness and catch errors early

#### Features:

- Syntax validation before GPU compilation
- Dependency cycle detection
- Unused include warnings
- Function signature validation
- Binding point conflict detection

#### Tasks:

- [ ] Implement WGSL syntax validator
- [ ] Add circular dependency detection
- [ ] Create shader linter
- [ ] Add warning system for unused includes
- [ ] Implement binding validation
- [ ] Create shader unit test framework

---

### **Phase 6: Migration & Cleanup**

**Goal**: Complete transition to new system

#### Migration Steps:

1. **Phase 6.1**: Migrate core rendering shaders

   - GBuffer shaders (gbuffer.vs, gbuffer.fs)
   - Lighting shaders (ambient.fs, directional_light.fs, pbr.fs)
   - Shadow shaders (shadows.vs, shadows.fs)

2. **Phase 6.2**: Migrate post-processing shaders

   - Bloom (bloom\*.fs/cs)
   - SSAO (ssao.fs, ao_bilateral_filter.fs)
   - SSR (ssr.fs)
   - Tone mapping (tone_mapping.fs)
   - Anti-aliasing (antialiasing.fs, fxaa.fs, smaa\*.fs)

3. **Phase 6.3**: Migrate specialized shaders

   - Particle systems
   - Decals
   - Distortion
   - Height fog
   - Volumetric lighting (froxel\_\*.wgsl)

4. **Phase 6.4**: Remove legacy files
   - Delete old `common/utils.wgsl`
   - Remove compatibility layer
   - Clean up unused includes

#### Tasks:

- [ ] Create migration checklist
- [ ] Migrate shaders in order
- [ ] Test each migration
- [ ] Update technique files
- [ ] Remove legacy includes
- [ ] Final cleanup and optimization

---

### **Phase 7: Documentation & Best Practices**

**Goal**: Ensure maintainability and knowledge transfer

#### Documentation Needed:

1. **Shader Organization Guide**

   - File naming conventions
   - Where to place new functions
   - Include order recommendations

2. **Preprocessor Usage Guide**

   - Conditional compilation examples
   - Macro best practices
   - Selective import patterns

3. **Performance Guidelines**

   - Function inlining recommendations
   - Dead code elimination benefits
   - Quality setting optimization

4. **Migration Examples**
   - Before/after comparisons
   - Common patterns
   - Troubleshooting guide

#### Tasks:

- [ ] Write shader organization guide
- [ ] Create preprocessor documentation
- [ ] Document all common includes
- [ ] Create shader authoring tutorial
- [ ] Write performance best practices
- [ ] Create troubleshooting guide

---

## 🔄 Iterative Approach

Each phase should be:

1. **Planned**: Define clear goals and tasks
2. **Implemented**: Code changes with tests
3. **Validated**: Ensure visual correctness
4. **Documented**: Update relevant docs
5. **Merged**: Integrate into main codebase

### Testing Checklist per Phase:

- [ ] Shaders compile without errors
- [ ] Visual output matches previous version
- [ ] Performance is equal or better
- [ ] No regression in existing features
- [ ] Documentation is updated

---

## 📊 Success Metrics

### Code Quality:

- Reduced average shader size (30% reduction target)
- Fewer lines per include file (< 100 lines ideal)
- Clear dependency graph (max 4 levels deep)
- Zero circular dependencies

### Developer Experience:

- Faster shader compilation (preprocessor optimization)
- Easier to find specific functions
- Less redundant includes
- Better error messages

### Performance:

- Smaller final shader binaries
- Quality-specific optimization
- Reduced GPU compilation time

---

## 🚀 Next Steps

### Immediate Actions (This Week):

1. **Audit Functions**: Create spreadsheet of all functions in `utils.wgsl` with usage count
2. **Create Dependency Graph**: Visual representation of current includes
3. **Prototype New Structure**: Create folder structure without moving files yet

### Short Term (This Month):

1. Complete Phase 2: Restructure common includes
2. Start Phase 3: Basic preprocessor enhancements (#ifdef, #define)
3. Test with a few shaders as pilot

### Medium Term (Next 2 Months):

1. Complete Phase 3: Full preprocessor features
2. Complete Phase 4: Quality settings integration
3. Start Phase 6: Systematic migration

### Long Term (Next 3 Months):

1. Complete migration of all shaders
2. Remove legacy code
3. Full documentation

---

## 🎓 Learning Resources

### WGSL Best Practices:

- [WebGPU Shading Language Spec](https://www.w3.org/TR/WGSL/)
- [WebGPU Best Practices](https://toji.dev/webgpu-best-practices/)

### Shader Organization:

- Unreal Engine shader organization
- Unity shader includes system
- Godot shader preprocessor

### Similar Tools:

- GLSL #include implementations
- HLSL include system
- Shader preprocessing in web engines

---

## 💡 Future Considerations

### Hot Reload:

- Watch shader files for changes
- Automatic recompilation
- Live preview in development

### Shader Variants:

- Automatic variant generation based on defines
- Compile-time optimization per variant
- Variant caching system

### Visual Shader Editor:

- Node-based shader creation
- Automatic include management
- Visual dependency tree

### Cross-Platform:

- WGSL to GLSL transpiler (WebGL fallback)
- Shader optimization per platform
- Automatic feature detection

---

## 📝 Notes

### Migration Priority:

1. **High Priority**: Core rendering (GBuffer, lighting)
2. **Medium Priority**: Post-processing effects
3. **Low Priority**: Specialized/experimental shaders

### Backward Compatibility:

- Maintain legacy `utils.wgsl` during migration
- Create compatibility shims where needed
- Gradual migration, not big bang

### Risk Mitigation:

- Test each change in isolation
- Keep rollback branches
- Extensive visual regression testing
- Performance profiling per phase

---

**Last Updated**: February 2, 2026
**Status**: Phase 1 Complete - Ready for Phase 2
**Next Review**: After Phase 2 completion
