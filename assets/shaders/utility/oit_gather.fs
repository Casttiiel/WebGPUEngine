// Weighted Blended Order-Independent Transparency — Gather Pass
// McGuire & Bavoil (2013): http://jcgt.org/published/0002/02/09/
//
// Renders GLASS geometry into two accumulation targets:
//   @location(0) accumulation (RGBA16F) — additive blend
//   @location(1) revealage    (RGBA8)   — multiplicative (1-alpha) blend
//
// A second compose pass resolves these over the opaque accLight buffer.
//
// Screen-space refraction (Uncharted 4 style):
//   Before this pass, accLight is copied to txRefraction (binding 3).
//   The gather shader offsets the sample UV by the view-space surface normal,
//   so the background seen through the glass appears distorted. Rougher
//   materials (e.g. frosted glass) produce a stronger distortion.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
}

struct VertexOutputTriplanarLocal {
    @builtin(position) position: vec4<f32>,

    @location(0) @interpolate(perspective, centroid) localNormal: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) localPos: vec3<f32>,
    @location(2) @interpolate(perspective, centroid) worldPos: vec3<f32>,

    // Normal matrix como 3 columnas (col0, col1, col2)
    @location(3) @interpolate(perspective, centroid) normalMatrix0: vec3<f32>,
    @location(4) @interpolate(perspective, centroid) normalMatrix1: vec3<f32>,
    @location(5) @interpolate(perspective, centroid) normalMatrix2: vec3<f32>,
}

struct ShadowsVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) worldPos: vec3<f32>,
}

struct FragmentOutput {
    @location(0) albedo: vec4<f32>,     // RGB: albedo, A: metallic
    @location(1) normal: vec4<f32>,     // RG: octahedral normal, BA: roughness + emissive
    @location(2) depth: f32,      // Linear depth (view space)
}

struct GBuffer {
    worldPos: vec3<f32>,
    normal: vec3<f32>,
    albedo: vec3<f32>,
    specularColor: vec3<f32>,
    roughness: f32,
    selfIllum: vec3<f32>,
    emissive: f32,
    reflectedDir: vec3<f32>,
    viewDir: vec3<f32>,
    metallic: f32,
    zlinear: f32,
}

struct MaterialFactors {
    baseColorFactor: vec4<f32>,
    roughnessFactor: f32,
    metallicFactor: f32,
    emissiveFactor: f32,
    appearanceBlend: f32,  // decal: blend weight for albedo+normal (1=full, 0=no change)
    uvXScale: f32,
    uvYScale: f32,
    surfaceBlend: f32,     // decal: blend weight for roughness+metallic (1=full, 0=no change)
    pomScale: f32          // POM height scale (0 = disabled, typical 0.01-0.1)
}

struct SSRUniforms {
    globalAmbientBoost: f32,
    stepSize: f32,
    maxSteps: f32,
    maxDistance: f32,
    thickness: f32,
    enabled: f32,
    specularBoost: f32,
    diffuseBoost: f32,
    metallicMin: f32,
    roughnessMax: f32,
    temporalMode: f32,  // 1.0 = TAA active (halve march steps), 0.0 = standalone
    frameIndex: f32,    // incremented each frame — drives blue-noise temporal animation
}
struct CameraUniforms {
    // All matrices first for better memory layout
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    invViewProjection: mat4x4<f32>,
    invProjection: mat4x4<f32>,
    invView: mat4x4<f32>,
    // Scalar data after matrices
    cameraPosition: vec4<f32>,
    screenSize: vec2<f32>,
    time: f32,
    timeDelta: f32,
    cameraFront: vec3<f32>,
    cameraFar: f32,
    // Sub-pixel jitter offset in UV space: (pattern - 0.5) / screenSize
    // Used by GBuffer shaders to unjitter texture UVs and prevent TAA-induced texture blur.
    // Multiply by screenSize to get pixel-space offsets.
    jitterOffset: vec2<f32>,
    // Jitter offset from the previous frame (UV space). Used by TAA to remove
    // the jitter contribution from static-geometry motion vectors.
    prevJitterOffset: vec2<f32>,
    // Negative mip bias applied to all GBuffer texture samples when camera jitter is
    // active (TAA enabled).  Value = -0.5 → one half mip sharper per frame; the TAA
    // accumulation then converges to a result that is net-sharper than no jitter.
    // Reads 0.0 when jitter is disabled so non-TAA paths are unaffected.
    mipBias: f32,
    _pad_mip: f32,  // align to vec2 boundary
    // Projection matrix WITHOUT jitter — used by SSR viewToScreen() to project 3D hits
    // into stable screen UVs without relying on manual jitter-offset sign arithmetic.
    // Uploading the pre-built matrix avoids any sign convention confusion.
    unjitteredProjectionMatrix: mat4x4<f32>,
    // Integer frame counter stored as f32 (offset 114 = byte 456).
    // Incremented by 1 each frame. Used with golden-ratio increment for
    // quasi-Monte Carlo temporal sample patterns (IGN, blue noise, etc.).
    frameIndex: f32,
}

struct OldCameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct ObjectUniforms {
    modelMatrix:         mat4x4<f32>, // current world matrix  (offset   0, 64 bytes)
    previousModelMatrix: mat4x4<f32>, // previous-frame world  (offset  64, 64 bytes)
}


@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;
// Environment cubemap + BRDF LUT for IBL specular (injected by GlassOITGatherRenderPass)
@group(3) @binding(0) var txEnv:        texture_cube<f32>;
@group(3) @binding(1) var envSampler:   sampler;
@group(3) @binding(2) var txBRDF:       texture_2d<f32>;  // split-sum LUT: U=NdotV, V=roughness
@group(3) @binding(3) var txRefraction: texture_2d<f32>;  // accLight snapshot before glass pass

struct OITOutput {
    @location(0) accumulation: vec4<f32>,
    @location(1) revealage:    vec4<f32>,
};

@fragment
fn fs(input: VertexOutput) -> OITOutput {
    let texColor  = textureSample(txAlbedo, samplerState, input.Uv);
    let baseColor = texColor.rgb * factors.baseColorFactor.rgb;
    var baseAlpha = texColor.a * factors.baseColorFactor.a;
    // Roughness from txRoughness.g (GBuffer convention)
    let roughness = textureSample(txRoughness, samplerState, input.Uv).g * factors.roughnessFactor;

    // ── View vector (must be computed before TBN to orient the geometric normal) ─
    let V = normalize(camera.cameraPosition.xyz - input.WorldPos);

    // ── Normal mapping ─────────────────────────────────────────────────────────
    let normalSample = textureSample(txNormal, samplerState, input.Uv).rgb * 2.0 - 1.0;
    let N_geo = normalize(input.N);
    // Face-forward: for double-sided glass the back-face interpolated normal points
    // away from the camera → dot(N,V) < 0 → saturate gives 0 → Fresnel = 1 always.
    // Flip N to always face the viewer so Fresnel varies correctly on both sides.
    let N = select(N_geo, -N_geo, dot(N_geo, V) < 0.0);
    // Gram-Schmidt re-orthogonalise T against the corrected N.
    let T = normalize(input.T.xyz - dot(input.T.xyz, N) * N);
    let B = cross(N, T) * input.T.w;
    let worldNormal = normalize(T * normalSample.x + B * normalSample.y + N * normalSample.z);

    // ── Fresnel (Schlick, glass IOR 1.5 → F0 = 0.04) ──────────────────────────
    let NdotV  = saturate(dot(worldNormal, V));
    let fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);

    // ── IBL specular con split-sum BRDF (Karis / UE4 2013) ────────────────────
    let R        = reflect(-V, worldNormal);
    let envMip   = roughness * 10.0;
    let envColor = textureSampleLevel(txEnv, envSampler, R, envMip).rgb;

    // BRDF LUT: U = NdotV, V = roughness  →  .r = F0 scale,  .g = additive bias
    let brdf        = textureSampleLevel(txBRDF, samplerState, vec2<f32>(NdotV, roughness), 0.0).rg;
    let F0          = vec3<f32>(0.04);
    let envStrength = F0 * brdf.r + brdf.g;

    // ── Screen-space refraction ────────────────────────────────────────────────
    // Project the fragment world position into clip space to get the base screen UV.
    let clipPos4   = camera.projectionMatrix * camera.viewMatrix * vec4<f32>(input.WorldPos, 1.0);
    let ndcPos     = clipPos4.xyz / clipPos4.w;
    // WebGPU UV: x = 0.5 + ndcX*0.5, y = 0.5 - ndcY*0.5 (Y flipped vs NDC)
    let baseUV     = vec2<f32>(ndcPos.x * 0.5 + 0.5, 0.5 - ndcPos.y * 0.5);

    // Use the view-space normal's XY as the screen-space displacement vector.
    // View-space Z (depth) doesn't affect left/right or up/down on screen.
    // Multiply by (1 + roughness) so frosted glass distorts more than clear glass.
    let viewNormal       = (camera.viewMatrix * vec4<f32>(worldNormal, 0.0)).xy;
    let refractionStrength = 0.05 * (1.0 + roughness);
    let refrUV           = clamp(
        baseUV + viewNormal * refractionStrength,
        vec2<f32>(0.001, 0.001),
        vec2<f32>(0.999, 0.999),
    );
    // Sample the pre-glass scene — this is what we see *through* the glass (distorted).
    let refractionColor = textureSample(txRefraction, samplerState, refrUV).rgb;

    // ── Color mixing ───────────────────────────────────────────────────────────
    // Transmission: distorted background tinted by the glass's base color.
    // Reflection: environment cubemap weighted by the split-sum Fresnel term.
    // At face-on (NdotV≈1 → fresnel≈0.04): mostly shows the refracted background.
    // At grazing (NdotV≈0 → fresnel≈1.00): mostly shows the environment reflection.
    let transmitted = refractionColor * baseColor;
    let color = transmitted * (1.0 - envStrength) + envColor * envStrength;

    // ── Alpha with Fresnel coupling ────────────────────────────────────────────
    let fresnelAlphaBoost = fresnel * (1.0 - baseAlpha) * 0.6;
    let alpha = clamp(baseAlpha + fresnelAlphaBoost, 0.0, 1.0);

    // ── OIT weight function — near-range aware ─────────────────────────────────
    let viewDepth = -(camera.viewMatrix * vec4<f32>(input.WorldPos, 1.0)).z;
    let nearRange = 5.0;
    let z_near    = clamp(viewDepth / nearRange,        0.0, 1.0);
    let z_far     = clamp(viewDepth / camera.cameraFar, 0.0, 1.0);
    let z_blend   = max(z_near, z_far * 0.1);
    let depthTerm = 10.0 / (1e-5 + pow(z_blend / 0.1, 2.0) + pow(z_blend / 0.5, 6.0));
    let w = clamp(alpha * clamp(depthTerm, 1e-2, 3e3), 1e-2, 3e3);

    var output: OITOutput;
    output.accumulation = vec4<f32>(color * alpha * w, alpha * w);
    output.revealage    = vec4<f32>(alpha, 0.0, 0.0, alpha);
    return output;
}
