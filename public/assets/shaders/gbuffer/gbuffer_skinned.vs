#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Material group (same layout as static GBuffer)
@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

// Per-object model matrix
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

// Joint palette — array of world-space skinning matrices.
// Layout: finalJointMatrix[i] = globalJointMatrix[i] * inverseBindMatrix[i]
@group(3) @binding(0) var<storage, read> jointMatrices: array<mat4x4<f32>>;

@vertex
fn vs(
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
    @location(4) joints:   vec4<u32>,
    @location(5) weights:  vec4<f32>,
) -> VertexOutput {

    // ── Skinning ──────────────────────────────────────────────────────────
    // Compute the blended skin matrix from up to 4 joint influences.
    var skinMatrix = mat4x4<f32>(
        vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0)
    );
    skinMatrix += weights.x * jointMatrices[joints.x];
    skinMatrix += weights.y * jointMatrices[joints.y];
    skinMatrix += weights.z * jointMatrices[joints.z];
    skinMatrix += weights.w * jointMatrices[joints.w];

    // ── Transform ─────────────────────────────────────────────────────────
    // skinMatrix already brings the vertex from bind-pose local space into world space.
    // object.modelMatrix handles any additional entity-level transform (position/rotation/scale).
    let skinnedPos    = skinMatrix * vec4<f32>(position, 1.0);
    let worldPos      = object.modelMatrix * skinnedPos;

    // Normal/tangent: use the inverse-transpose of the skin matrix for correctness.
    // For uniform scale skins the 3×3 is sufficient; we normalise after.
    let skinMat3   = mat3x3<f32>(skinMatrix[0].xyz, skinMatrix[1].xyz, skinMatrix[2].xyz);
    let modelMat3  = get3x3From4x4(object.modelMatrix);
    let normalMat  = modelMat3 * skinMat3;

    var output: VertexOutput;
    output.N        = normalize(normalMat * normal);
    output.T        = vec4<f32>(normalize(normalMat * tangent.xyz), tangent.w);
    output.WorldPos = worldPos.xyz;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;
    output.Uv       = uv;

    return output;
}
