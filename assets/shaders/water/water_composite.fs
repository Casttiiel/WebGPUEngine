// Single Layer Water – Composite Pass
// Implements a UE5-style Single Layer Water approximation:
//   1. Beer–Lambert absorption  — volume colour/depth
//   2. Scattering               — subsurface tint
//   3. Screen-space refraction  — UV offset from surface normal
//   4. Fresnel (Schlick)        — reflection vs. transmission weight
//   5. IBL env cubemap          — specular reflection
//
// The water fragment shader (water_gbuffer.fs) runs first and writes raw PBR
// properties into the dedicated water GBuffer.  This fullscreen pass then reads
// those properties together with a pre-water scene snapshot and composites the
// final result back into the main accLight buffer.
//
//   group(0) binding 0 — CameraUniforms
//   group(1) binding 0 — txSceneBeforeWater   lit scene snapshot (no water)
//   group(1) binding 1 — txWaterAlbedo        base colour (RGB) + metallic (A)
//   group(1) binding 2 — txWaterNormal        oct-encoded normal (RG) + roughness (B)
//   group(1) binding 3 — txWaterDepth         water surface linear depth (0 = no water)
//   group(1) binding 4 — txSolidDepth         opaque scene linear depth
//   group(1) binding 5 — txEnvCubemap         IBL environment cubemap
//   group(1) binding 6 — samplerState         bilinear / trilinear sampler
//   group(1) binding 7 — envSampler           cubemap sampler
//   group(1) binding 8 — txWaterLit           water surface after ambient + directional lighting

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


@group(0) @binding(0) var<uniform> camera:          CameraUniforms;

@group(1) @binding(0) var txSceneBeforeWater: texture_2d<f32>;
@group(1) @binding(1) var txWaterAlbedo:      texture_2d<f32>;
@group(1) @binding(2) var txWaterNormal:      texture_2d<f32>;
@group(1) @binding(3) var txWaterDepth:       texture_2d<f32>;
@group(1) @binding(4) var txSolidDepth:       texture_2d<f32>;
@group(1) @binding(5) var txEnvCubemap:       texture_cube<f32>;
@group(1) @binding(6) var samplerState:       sampler;
@group(1) @binding(7) var envSampler:         sampler;
@group(1) @binding(8) var txWaterLit:         texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {

    // textureSampleLevel (explicit LOD) does not require uniform control flow, so
    // all texture reads below are safe inside non-uniform branches.

    let waterLinDepth = textureSampleLevel(txWaterDepth, samplerState, uv, 0.0).r;

    // ── Passthrough for non-water pixels ─────────────────────────────────────
    // Water depth clears to 1.0; water pixels write values in (0, 1).
    if (waterLinDepth >= 1.0) {
        return textureSampleLevel(txSceneBeforeWater, samplerState, uv, 0.0);
    }

    // ── Unpack water GBuffer ──────────────────────────────────────────────────
    let albedoData     = textureSampleLevel(txWaterAlbedo, samplerState, uv, 0.0);
    let waterBaseColor = albedoData.rgb;  // water tint / foam colour

    let normalData = textureSampleLevel(txWaterNormal, samplerState, uv, 0.0);
    let surfNormal = octahedral01ToNormal(normalData.xy);
    let roughness  = normalData.z;

    // ── Volume depth (world-space distance beneath the surface) ───────────────
    // solidLinDepth = depth of the opaque scene behind the water surface
    let solidLinDepth = textureSampleLevel(txSolidDepth, samplerState, uv, 0.0).r;
    let waterVolDepth = max(0.0, solidLinDepth - waterLinDepth) * camera.cameraFar;

    // ── Beer-Lambert absorption ───────────────────────────────────────────────
    // Each channel decays at a different rate: red absorbed fastest, blue slowest.
    // This produces the characteristic blue-green tint of deep water.
    let absorptionCoeff = vec3<f32>(0.45, 0.15, 0.05);
    let absorption      = exp(-absorptionCoeff * waterVolDepth);

    // ── Scattering (exponential, not linear) ─────────────────────────────────
    // Models how light scatters inside the volume before reaching the camera.
    // Using 1 - exp(-k*d) gives a smooth shallow→deep transition without the
    // hard knee that saturate(d/maxD) produces at the threshold.
    let scatterCoeff    = 0.35;
    let scatterAmount   = 1.0 - exp(-scatterCoeff * waterVolDepth);
    let scatterTint     = waterBaseColor * scatterAmount;

    // ── Screen-space refraction ───────────────────────────────────────────────
    // Offset the background sample UV by the surface normal (XY component only).
    // Guard: only apply offset if the refracted pixel is actually behind the surface
    // (avoids sampling above-water geometry through the water plane).
    let refractionStrength = 0.025;
    let refractUV          = clamp(uv + surfNormal.xy * refractionStrength,
                                   vec2<f32>(0.001), vec2<f32>(0.999));
    let refractedSolidDepth = textureSampleLevel(txSolidDepth, samplerState, refractUV, 0.0).r;
    let finalBGUV  = select(uv, refractUV, refractedSolidDepth >= waterLinDepth);
    let sceneColor = textureSampleLevel(txSceneBeforeWater, samplerState, finalBGUV, 0.0).rgb;

    // ── Transmitted background ────────────────────────────────────────────────
    // Beer-Lambert attenuates what reaches us; scattering adds the water tint.
    // (1 - scatterAmount) ensures energy conservation: more scatter → less bg.
    let transmitted = sceneColor * absorption * (1.0 - scatterAmount) + scatterTint;

    // ── Fresnel (Schlick approximation) ───────────────────────────────────────
    // Water IOR ≈ 1.33  →  F0 = ((n-1)/(n+1))^2 ≈ 0.02
    let worldPos = getWorldCoords(uv, waterLinDepth, camera);
    let V        = normalize(camera.cameraPosition.xyz - worldPos);
    let NdotV    = max(dot(surfNormal, V), 0.0);
    let fresnel  = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

    // ── IBL environment reflection ────────────────────────────────────────────
    // Use actual cubemap mip count so roughness maps correctly across all presets.
    let R      = reflect(-V, surfNormal);
    let envMip = roughness * f32(textureNumLevels(txEnvCubemap) - 1u);
    let reflColor = textureSampleLevel(txEnvCubemap, envSampler, R, envMip).rgb;

    // ── Foam / shoreline ─────────────────────────────────────────────────────
    // Thin water (<0.3 world units) gets a white foam overlay, matching the
    // shoreline break where turbulence aerates the water surface.
    let foamColor    = vec3<f32>(0.95, 0.97, 1.0);
    let foamStrength = smoothstep(0.3, 0.0, waterVolDepth);
    let foamMask     = foamStrength * 0.85; // max opacity cap

    // ── Composite ─────────────────────────────────────────────────────────────
    // Fresnel-blend: normal incidence → see transmitted background, grazing → mirror reflection.
    var finalColor = mix(transmitted, reflColor, clamp(fresnel,0.0,1.0));

    // Add the fully-lit water surface (ambient IBL diffuse + directional light diffuse+specular).
    // This is the deferred lighting result evaluated on the water GBuffer, equivalent to what
    // opaque surfaces receive.  It is added on top of the Fresnel blend because the surface
    // PBR terms (NdL, VdH Fresnel, GGX specular) have already been computed in the lighting
    // passes and are independent of the view-angle Fresnel transmission/reflection split.
    // Use textureLoad (nearest texel, no filter) to avoid bilinear bleeding of
    // invalid values from non-water pixels at the water/land boundary.
    let litTexel   = vec2<i32>(floor(uv * camera.screenSize));
    let litSurface = textureLoad(txWaterLit, litTexel, 0).rgb;
    finalColor += litSurface;

    // Foam / shoreline on top of everything.
    finalColor = mix(finalColor, foamColor, foamMask);

    return vec4<f32>(finalColor,1.0);
}
