#include "common/uniforms"
#include "common/structs"
#include "common/pbr/brdf"
#include "common/octahedral"
#include "common/gbuffer"

// ─── Uniform structs ──────────────────────────────────────────────────────────
// Layout (80 bytes, 5 × vec4):
//   colorIntensity: vec4  – rgb = HDR color, w = intensity          offset  0
//   position:       vec4  – xyz = world-space centre, w = pad       offset 16
//   right:          vec4  – xyz = normalised right axis, w = halfW  offset 32
//   up:             vec4  – xyz = normalised up axis,    w = halfH  offset 48
//   params:         vec4  – x = radius, y = twoSided(0/1),         offset 64
//                           z = startFalloff, w = pad
struct AreaLightUniforms {
    colorIntensity: vec4<f32>,
    position:       vec4<f32>,
    right:          vec4<f32>,
    up:             vec4<f32>,
    params:         vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// group(1): GBuffer + AO  (GBufferWithAOUniforms layout)
@group(1) @binding(0) var gAlbedo:              texture_2d<f32>;
@group(1) @binding(1) var gNormals:             texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth:         texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer:       sampler;
@group(1) @binding(4) var gAOMicroShadow:       texture_2d<f32>;
@group(1) @binding(5) var aoMicroShadowSampler: sampler;

@group(2) @binding(0) var<uniform> light: AreaLightUniforms;

// ─── Most Representative Point: specular ─────────────────────────────────────
// Reflects the view direction and finds the closest point on the rectangle to
// that reflection ray (Karis 2013, UE4 physically-based shading).
fn rectRepPoint(worldPos: vec3<f32>, R: vec3<f32>) -> vec3<f32> {
    let center  = light.position.xyz;
    let halfW   = light.right.w;
    let halfH   = light.up.w;
    let lRight  = light.right.xyz;
    let lUp     = light.up.xyz;
    let lNormal = normalize(cross(lRight, lUp));

    // Intersection of reflection ray with the light's infinite plane
    let d     = dot(center - worldPos, lNormal);
    let denom = dot(R, lNormal);
    // If the ray is (nearly) parallel to the plane, t = very large → clamp handles it
    let t     = d / (denom + sign(denom) * 0.0001);
    // Only consider hits in front of the surface; for t < 0 use closest edge
    let hit   = worldPos + R * max(t, 0.0);

    // Project onto the rect's local axes and clamp to bounds
    let local = hit - center;
    let u     = clamp(dot(local, lRight), -halfW, halfW);
    let v     = clamp(dot(local, lUp),    -halfH, halfH);
    return center + lRight * u + lUp * v;
}

// ─── Fragment ─────────────────────────────────────────────────────────────────
@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);
    if (g.zlinear >= 1.0) { discard; }

    let center   = light.position.xyz;
    let toCenter = center - g.worldPos;
    let dist     = length(toCenter);
    let radius   = light.params.x;
    if (dist >= radius) { discard; }

    // Smooth distance attenuation (cubic hermite)
    let r0  = light.params.z; // start-falloff distance
    var att = 1.0;
    if (dist > r0) {
        let t = saturate((dist - r0) / max(radius - r0, 0.001));
        att = 1.0 - t * t * (3.0 - 2.0 * t);
    }

    let halfW = light.right.w;
    let halfH = light.up.w;

    let ao = textureSampleLevel(gAOMicroShadow, aoMicroShadowSampler, uv, 0.0).b;

    // ── SPECULAR — Most Representative Point ─────────────────────────────────
    let R        = reflect(-g.viewDir, g.normal);
    let repPoint = rectRepPoint(g.worldPos, R);
    let toRep    = repPoint - g.worldPos;
    let distRep  = max(length(toRep), 0.001);
    let Lspec    = toRep / distRep;

    // Sphere-cap normalization: treat rect as disc of equivalent area → effective radius
    // a'   = saturate(roughness + r_sphere / (2 * d))  [Karis 2013]
    let sphereRad  = sqrt(halfW * halfH * 0.31830989); // sqrt(area/PI)
    let roughnessL = g.roughness;
    let aPrime     = saturate(roughnessL + sphereRad / (2.0 * distRep));
    let aPrimeSq   = aPrime * aPrime;

    let NdL_s  = max(dot(g.normal, Lspec), 0.0);
    let NdV    = max(dot(g.normal, g.viewDir), 0.001);
    let h_s    = normalize(Lspec + g.viewDir);
    let NdH_s  = saturate(dot(g.normal, h_s));
    let VdH_s  = saturate(dot(g.viewDir, h_s));
    let LdV_s  = saturate(dot(Lspec, g.viewDir));

    let cSpec = Specular(g.specularColor, h_s, g.viewDir, Lspec, aPrimeSq, NdL_s, NdV, NdH_s, VdH_s, LdV_s);
    let F_s   = Fresnel_Schlick_Roughness(VdH_s, g.specularColor, roughnessL);
    // kD not needed for specular branch — cSpec already integrates Fresnel

    // ── DIFFUSE — direction to rect centre + solid-angle scale ───────────────
    let Ldiff  = normalize(toCenter);
    let NdL_d  = max(dot(g.normal, Ldiff), 0.0);
    let h_d    = normalize(Ldiff + g.viewDir);
    let VdH_d  = saturate(dot(g.viewDir, h_d));
    let F_d    = Fresnel_Schlick_Roughness(VdH_d, g.specularColor, roughnessL);
    let kD     = (vec3<f32>(1.0) - F_d) * (1.0 - g.metallic);

    // Solid-angle of the rect as seen from the surface point, clamped to hemisphere limit (PI)
    let solidAngle = min((4.0 * halfW * halfH) / max(dist * dist, 0.001), 3.14159265);

    // ── Two-sided: cull back-face illumination when disabled ─────────────────
    let lNormal      = normalize(cross(light.right.xyz, light.up.xyz));
    let facingFactor  = dot(-Ldiff, lNormal); // 1 = surface facing front, -1 = facing back
    var backFaceAtt  = 1.0;
    if (light.params.y < 0.5 && facingFactor < 0.0) {
        backFaceAtt = 0.0;
    }

    // ── Combine ───────────────────────────────────────────────────────────────
    let ms       = microShadow(ao, max(NdL_s, NdL_d));
    let col      = light.colorIntensity.rgb * light.colorIntensity.w;

    // Diffuse: scaled by solid angle (normalised so PI sr → full contribution)
    let diffuse  = kD * Diffuse(g.albedo) * halfLambert(NdL_d) * solidAngle;
    // Specular: standard Cook-Torrance with MRP representative point
    let specular = cSpec * NdL_s;

    let finalColor = col * (diffuse + specular) * att * ms * backFaceAtt;
    return vec4<f32>(finalColor, 1.0);
}
