#include "common/structs"
#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txNoise1: texture_2d<f32>;
@group(1) @binding(1) var txNoise2: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

// Water scene bindings (group 3): linear depth + env cubemap for foam and reflections
@group(3) @binding(0) var sceneSampler: sampler;
@group(3) @binding(1) var txSceneDepth: texture_2d<f32>;
@group(3) @binding(2) var txEnvCubemap: texture_cube<f32>;
@group(3) @binding(3) var envSampler: sampler;

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let t = camera.time;

    // ── Animated noise UVs ────────────────────────────────────────────────────
    let noiseUV1 = input.Uv * vec2<f32>(factors.uvXScale) + vec2<f32>(t * 0.06, t * 0.04);
    let noiseUV2 = input.Uv * vec2<f32>(factors.uvYScale) + vec2<f32>(-t * 0.03, t * 0.08);

    let n1 = textureSample(txNoise1, samplerState, noiseUV1).rgb * 2.0 - 1.0;
    let n2 = textureSample(txNoise2, samplerState, noiseUV2).rgb * 2.0 - 1.0;

    // ── Perturbed surface normal ──────────────────────────────────────────────
    // Blend two noise layers and nudge the interpolated geometric normal
    let perturbation = normalize(n1 * 0.65 + n2 * 0.35) * 0.15;
    let N = normalize(input.N + perturbation);

    // ── Fresnel (Schlick) ─────────────────────────────────────────────────────
    let V = normalize(camera.cameraPosition.xyz - input.WorldPos);
    let NdotV = max(dot(N, V), 0.0);
    let F0 = 0.04; // Water reflectance at normal incidence
    let fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);

    // ── Environment reflection ────────────────────────────────────────────────
    let R = reflect(-V, N);
    let envColor = textureSample(txEnvCubemap, envSampler, R).rgb;

    // ── Foam edge detection ───────────────────────────────────────────────────
    // Compare the scene's opaque linear depth (from G-Buffer) with this fragment's
    // linear depth.  A small difference means an object is just below the surface
    // → add white foam at the intersection edge.
    let screenUV = input.position.xy / camera.screenSize;
    let sceneLinearDepth = textureSample(txSceneDepth, sceneSampler, screenUV).r;

    // Reconstruct the water fragment's linear depth in the same normalised space
    // used by gbuffer.fs: dot(worldPos - camPos, cameraFront) / cameraFar
    let camb2frag = input.WorldPos - camera.cameraPosition.xyz;
    let waterLinearDepth = dot(camb2frag, camera.cameraFront.xyz) / camera.cameraFar;

    // depthDiff > 0 means the opaque scene is behind the water surface
    let depthDiff = sceneLinearDepth - waterLinearDepth;
    let foamRange = 0.5 / camera.cameraFar; // 0.5 world units in normalised depth
    let foamMask = 1.0 - smoothstep(0.0, foamRange, depthDiff);

    // ── Final colour ─────────────────────────────────────────────────────────
    let waterColor = factors.baseColorFactor.rgb;

    // Diffuse tint lerped with env reflection by Fresnel
    let surfaceColor = mix(waterColor, envColor, clamp(fresnel, 0.0, 1.0));

    // Foam blended on top
    let finalColor = mix(surfaceColor, vec3<f32>(1.0), foamMask * 0.85);

    // Alpha: base transparency boosted by Fresnel and foam
    let alpha = clamp(factors.baseColorFactor.a + fresnel * 0.3 + foamMask * 0.5, 0.0, 1.0);

    return vec4<f32>(finalColor, alpha);
}
