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
// Matrix utility functions
// Level 1: No dependencies

// Extract 3x3 rotation/scale from 4x4 transformation matrix
fn get3x3From4x4(mat: mat4x4<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(
        mat[0].xyz,
        mat[1].xyz,
        mat[2].xyz
    );
}

// Compute TBN (Tangent-Bitangent-Normal) matrix for normal mapping
fn computeTBN(inputN: vec3<f32>, inputT: vec4<f32>) -> mat3x3<f32> {
    let N = inputN;
    let T = inputT.xyz;
    let B = cross(N, T) * inputT.w;
    return mat3x3<f32>(T, B, N);
}

// Coordinate transformation utilities
// Level 1: Depends on core/constants, core/uniforms

// Mathematical constants used throughout shaders
// Level 0: No dependencies

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;

// Basic math utility functions
// Level 0: No dependencies

// Helper function for saturate (clamp to 0-1)
fn saturate(x: f32) -> f32 {
    return clamp(x, 0.0, 1.0);
}


// Reconstruct world position from UV, depth, and camera
fn getWorldCoords(uv: vec2<f32>, zlinear: f32, camera: CameraUniforms) -> vec3<f32> {
    // Convert UV coordinates (0-1) to NDC coordinates (-1 to 1)
    let coords = vec2<f32>(uv.x, 1.0 - uv.y);
    let ndc_coords = (coords * 2.0) - 1.0;
    
    // Get the ray direction by transforming NDC coordinates
    let near_ndc = vec4<f32>(ndc_coords.x, ndc_coords.y, 1.0, 1.0);
    let near_world_homogeneous = camera.invViewProjection * near_ndc;
    let near_world = near_world_homogeneous.xyz / near_world_homogeneous.w;

    // Calculate the ray direction from camera to the point (in WORLD coordinates)
    let ray_direction = normalize(near_world - camera.cameraPosition.xyz);
    
    // zlinear was calculated as: dot(worldPos - cameraPos, cameraFront) / zFar
    // So: distance_along_front = zlinear * zFar
    // But we need distance_along_ray = distance_along_front / dot(ray_direction, cameraFront)
    let distance_along_front = zlinear * camera.cameraFar;
    let distance_along_ray = distance_along_front / dot(ray_direction, camera.cameraFront.xyz);
    
    // Calculate final world position
    return camera.cameraPosition.xyz + ray_direction * distance_along_ray;
}

// Get view space direction from clip space position
fn get_view_dir(clip_pos: vec3<f32>, camera: CameraUniforms) -> vec3<f32> {
    // Extract FOV and aspect ratio from projection matrix
    let fov = atan(1.0 / camera.projectionMatrix[1][1]);
    let aspect = camera.projectionMatrix[1][1] / camera.projectionMatrix[0][0];
    
    // Reconstruct view space direction
    var view_dir = vec3<f32>(
        clip_pos.x * tan(fov) * aspect,
        clip_pos.y * tan(fov),
        -1.0
    );
    
    return normalize(view_dir);
}

// Transform view space direction to world space
fn get_world_dir(view_dir: vec3<f32>, camera: CameraUniforms) -> vec3<f32> {
    // Inverse rotation = transpose of upper 3x3 view matrix
    let rotation = transpose(mat3x3<f32>(
        camera.viewMatrix[0].xyz,
        camera.viewMatrix[1].xyz,
        camera.viewMatrix[2].xyz
    ));
    
    return rotation * view_dir;
}

// Convert 3D direction to equirectangular UV coordinates
fn direction_to_equirect_uv(dir: vec3<f32>) -> vec2<f32> {
    let theta = atan2(dir.x, dir.z); // [-PI, PI]
    let phi = acos(clamp(dir.y, -1.0, 1.0)); // [0, PI]
    let u = (theta + PI) / TWO_PI; // [0, 1]
    let v = phi / PI; // [0, 1]
    return vec2<f32>(u, v);
}

fn sign_nonzero_f(v: f32) -> f32 {
    return select(-1.0, 1.0, v >= 0.0);
}



fn encodeOctahedral(n: vec3<f32>) -> vec2<f32> {
    // Proyección octahedral: divide por la norma L1
    var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
    // Wrap para hemisferio negativo Z
    if (n.z < 0.0) {
        p = (1.0 - abs(p.yx)) * sign_nonzero(p);
    }
    return p;  // rango [-1, 1]
}

fn decodeOctahedral(p: vec2<f32>) -> vec3<f32> {
    var n = vec3<f32>(p.x, p.y, 1.0 - abs(p.x) - abs(p.y));
    if (n.z < 0.0) {
        let tmp = n.xy;
        n.x = (1.0 - abs(tmp.y)) * sign_nonzero_f(tmp.x);
        n.y = (1.0 - abs(tmp.x)) * sign_nonzero_f(tmp.y);
    }
    return normalize(n);
}

// sign que devuelve +1 cuando x=0 (necesario para el wrap)
fn sign_nonzero(v: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        select(-1.0, 1.0, v.x >= 0.0),
        select(-1.0, 1.0, v.y >= 0.0)
    );
}

fn normalToOctahedral01(n: vec3<f32>) -> vec2<f32> {
    return encodeOctahedral(n) * 0.5 + 0.5;
}

fn octahedral01ToNormal(enc: vec2<f32>) -> vec3<f32> {
    return decodeOctahedral(enc * 2.0 - 1.0);
}

struct DecalFragmentOutput {
  @location(0) albedo: vec4<f32>,
  @location(1) normal: vec4<f32>,
}

struct DecalVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) decal_top_left: vec3<f32>,
    @location(1) decal_axis_x: vec3<f32>,
    @location(2) decal_axis_z: vec3<f32>,
    @location(3) decal_axis_y: vec3<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var gBufferAlbedo: texture_2d<f32>;
@group(3) @binding(1) var gBufferNormals: texture_2d<f32>;
@group(3) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(3) @binding(3) var samplerState2: sampler;

@fragment
fn fs(input: DecalVertexOutput) -> DecalFragmentOutput {
    let screen_pos = input.position.xy / camera.screenSize;

    let depth = textureSample(gLinearDepth, samplerState, screen_pos).x;
    let world_pos = getWorldCoords(screen_pos, depth, camera);

    let decal_to_wpos = world_pos - input.decal_top_left;
    let axis_x_len = length(input.decal_axis_x);
    let axis_z_len = length(input.decal_axis_z);
    let axis_y_len = length(input.decal_axis_y);
    let amount_of_x = dot(decal_to_wpos, input.decal_axis_x) / (axis_x_len * axis_x_len);
    let amount_of_z = dot(decal_to_wpos, input.decal_axis_z) / (axis_z_len * axis_z_len);
    let amount_of_y = dot(decal_to_wpos, input.decal_axis_y) / (axis_y_len * axis_y_len);

    // Discard fragments outside the decal cube volume.
    // All three axes are now [0, 1] from the minimum corner (decal_multiface.vs
    // subtracts decal_y * 0.5 from decal_top_left, unlike the original decal.vs).
    if (amount_of_x < 0.0 || amount_of_x > 1.0 ||
        amount_of_z < 0.0 || amount_of_z > 1.0 ||
        amount_of_y < 0.0 || amount_of_y > 1.0) {
        discard;
    }

    // Surface normal from GBuffer
    let orig_NRoughnessEmissive = textureSample(gBufferNormals, samplerState, screen_pos);
    let surface_normal = normalize(octahedral01ToNormal(orig_NRoughnessEmissive.xy));

    // Normalized face directions in world space
    let face_xp = normalize(input.decal_axis_x);
    let face_xn = -face_xp;
    let face_yp = normalize(input.decal_axis_y);
    let face_yn = -face_yp;
    let face_zp = normalize(input.decal_axis_z);
    let face_zn = -face_zp;

    // Per-face weight: raised to power 4 so each face wins clearly in its zone
    // and transitions at corners are sharp rather than blurry 50/50 blends.
    let w_xp = pow(max(0.0, dot(surface_normal, face_xp)), 4.0);
    let w_xn = pow(max(0.0, dot(surface_normal, face_xn)), 4.0);
    let w_yp = pow(max(0.0, dot(surface_normal, face_yp)), 4.0);
    let w_yn = pow(max(0.0, dot(surface_normal, face_yn)), 4.0);
    let w_zp = pow(max(0.0, dot(surface_normal, face_zp)), 4.0);
    let w_zn = pow(max(0.0, dot(surface_normal, face_zn)), 4.0);

    let total_weight = w_xp + w_xn + w_yp + w_yn + w_zp + w_zn;
    if (total_weight < 0.001) { discard; }

    // UVs for each of the 6 face projections
    // X faces: project along X → UV from (Z, Y)
    let uv_xp = vec2<f32>(amount_of_z,       amount_of_y);
    let uv_xn = vec2<f32>(1.0 - amount_of_z, amount_of_y);
    // Y faces: project along Y → UV from (X, Z)
    let uv_yp = vec2<f32>(amount_of_x,       amount_of_z);
    let uv_yn = vec2<f32>(amount_of_x,       1.0 - amount_of_z);
    // Z faces: project along Z → UV from (X, Y)
    let uv_zp = vec2<f32>(amount_of_x,       amount_of_y);
    let uv_zn = vec2<f32>(1.0 - amount_of_x, amount_of_y);

    // Albedo blend
    let albedo_xp = textureSample(txAlbedo, samplerState, uv_xp);
    let albedo_xn = textureSample(txAlbedo, samplerState, uv_xn);
    let albedo_yp = textureSample(txAlbedo, samplerState, uv_yp);
    let albedo_yn = textureSample(txAlbedo, samplerState, uv_yn);
    let albedo_zp = textureSample(txAlbedo, samplerState, uv_zp);
    let albedo_zn = textureSample(txAlbedo, samplerState, uv_zn);

    let decal_albedo = (
        albedo_xp * w_xp + albedo_xn * w_xn +
        albedo_yp * w_yp + albedo_yn * w_yn +
        albedo_zp * w_zp + albedo_zn * w_zn
    ) / total_weight;

    // Per-axis edge softness in [0,1]: 1 at cube centre along that axis, 0 at the face.
    let edge_x = 1.0 - abs((amount_of_x - 0.5) * 2.0);
    let edge_y = 1.0 - abs((amount_of_y - 0.5) * 2.0);
    let edge_z = 1.0 - abs((amount_of_z - 0.5) * 2.0);

    // Each face's fade must only use its two UV axes — NOT its own depth axis.
    // Including the depth axis would zero-out surfaces sitting right on that face
    // (e.g. a floor at amount_of_y ≈ -0.5 would get edge_y ≈ 0 and never render).
    //   X-faces project along X  → UV axes are Z and Y
    //   Y-faces project along Y  → UV axes are X and Z
    //   Z-faces project along Z  → UV axes are X and Y
    let edge_fade_x = min(edge_y, edge_z);
    let edge_fade_y = min(edge_x, edge_z);
    let edge_fade_z = min(edge_x, edge_y);

    let edge_fade = (
        edge_fade_x * (w_xp + w_xn) +
        edge_fade_y * (w_yp + w_yn) +
        edge_fade_z * (w_zp + w_zn)
    ) / total_weight;

    let final_alpha = decal_albedo.a * edge_fade;
    if (final_alpha < 0.01) { discard; }

    // Roughness blend
    let rough_xp = textureSample(txRoughness, samplerState, uv_xp).g;
    let rough_xn = textureSample(txRoughness, samplerState, uv_xn).g;
    let rough_yp = textureSample(txRoughness, samplerState, uv_yp).g;
    let rough_yn = textureSample(txRoughness, samplerState, uv_yn).g;
    let rough_zp = textureSample(txRoughness, samplerState, uv_zp).g;
    let rough_zn = textureSample(txRoughness, samplerState, uv_zn).g;

    let decal_roughness = (
        rough_xp * w_xp + rough_xn * w_xn +
        rough_yp * w_yp + rough_yn * w_yn +
        rough_zp * w_zp + rough_zn * w_zn
    ) / total_weight;

    // Normal map blend in tangent space
    let nm_xp = textureSample(txNormal, samplerState, uv_xp).xyz * 2.0 - 1.0;
    let nm_xn = textureSample(txNormal, samplerState, uv_xn).xyz * 2.0 - 1.0;
    let nm_yp = textureSample(txNormal, samplerState, uv_yp).xyz * 2.0 - 1.0;
    let nm_yn = textureSample(txNormal, samplerState, uv_yn).xyz * 2.0 - 1.0;
    let nm_zp = textureSample(txNormal, samplerState, uv_zp).xyz * 2.0 - 1.0;
    let nm_zn = textureSample(txNormal, samplerState, uv_zn).xyz * 2.0 - 1.0;

    // Build TBN from the underlying surface normal once.
    let orig_normal = octahedral01ToNormal(orig_NRoughnessEmissive.xy);
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(orig_normal.y) > 0.99);
    let tangent   = normalize(cross(up, orig_normal));
    let bitangent = cross(orig_normal, tangent);
    let TBN = mat3x3<f32>(tangent, bitangent, orig_normal);

    // Each face's tangent-space normal lives in a different tangent space, so
    // transform each one to world space individually before blending.
    // Mixing raw tangent-space vectors from different projections is incorrect.
    let ws_xp = normalize(TBN * nm_xp);
    let ws_xn = normalize(TBN * nm_xn);
    let ws_yp = normalize(TBN * nm_yp);
    let ws_yn = normalize(TBN * nm_yn);
    let ws_zp = normalize(TBN * nm_zp);
    let ws_zn = normalize(TBN * nm_zn);

    let decal_normal_ws = normalize(
        ws_xp * w_xp + ws_xn * w_xn +
        ws_yp * w_yp + ws_yn * w_yn +
        ws_zp * w_zp + ws_zn * w_zn
    );
    let encoded_normal  = normalToOctahedral01(decal_normal_ws);

    // Blend onto GBuffer
    let orig_albedo = textureSample(gBufferAlbedo, samplerState, screen_pos);
    let out_albedo_rgb = mix(orig_albedo.rgb, decal_albedo.rgb, final_alpha);
    let out_albedo_a   = mix(orig_albedo.a,   decal_albedo.a,   final_alpha);
    let blended_roughness = mix(orig_NRoughnessEmissive.z, decal_roughness, final_alpha);

    var output: DecalFragmentOutput;
    output.albedo = vec4<f32>(out_albedo_rgb, out_albedo_a);
    output.normal = vec4<f32>(encoded_normal.xy, blended_roughness, orig_NRoughnessEmissive.a);
    return output;
}
