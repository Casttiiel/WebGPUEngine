#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/math/coordinates"
#include "common/octahedral"

// Salpicadura de sangre procedural (BloodFX). Cada mancha es distinta (azar = su posición):
// un charco de metaballs, gotas lanzadas en abanico hacia +X del decal (la dirección del
// golpe), alargadas en su dirección, y salpicaduras sueltas. Del grosor salen el color (fina
// = roja, gruesa = casi negra), el relieve del borde y lo mojada que está (rugosidad).
//
// La edad va en la altura del decal (eje Y): altura = 0.5 + 0.5·edad (m), edad 0 (recién
// caída) → 1 (seca y desaparecida). Así BloodFX la envejece sin uniforms propios.

struct DecalFragmentOutput {
  @location(0) albedo: vec4<f32>,     // RGB: albedo, A: metallic
  @location(1) normal: vec4<f32>,     // RG: normal octaédrica, B: roughness, A: (se conserva)
}

struct DecalVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) decal_top_left: vec3<f32>,
    @location(1) decal_axis_x: vec3<f32>,
    @location(2) decal_axis_z: vec3<f32>,
    @location(3) decal_axis_y: vec3<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(5) var samplerState: sampler;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var gBufferAlbedo: texture_2d<f32>;
@group(3) @binding(1) var gBufferNormals: texture_2d<f32>;
@group(3) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(3) @binding(3) var samplerState2: sampler;

/// Espesor de la película de sangre (m) para el relieve: exagerado para que se vea desde lejos.
const FILM_HEIGHT: f32 = 0.006;

fn hash11(n: f32) -> f32 {
    return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

fn hash21(p: vec2<f32>) -> f32 {
    let q = fract(p * vec2<f32>(123.34, 456.21));
    return fract((q.x + 45.32) * (q.y + 45.32) * 33.7 + dot(q, q + 45.32));
}

fn valueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

/// Suma de metaballs (1 en el borde, más dentro). `p` en [-1, 1], +X = hacia donde salió.
fn splatField(p: vec2<f32>, seed: f32) -> f32 {
    var f = 0.0;
    // Charco principal: algo retrasado respecto al centro (lo más grueso cae primero).
    for (var i = 0; i < 6; i++) {
        let s = seed + f32(i) * 7.31;
        let c = vec2<f32>(mix(-0.45, 0.1, hash11(s)), (hash11(s + 1.0) - 0.5) * 0.5);
        let r = mix(0.1, 0.22, hash11(s + 2.0));
        let d = p - c;
        f += r * r / max(dot(d, d), 1e-5);
    }
    // Gotas lanzadas en abanico: más lejos, más pequeñas y más alargadas.
    for (var i = 0; i < 11; i++) {
        let s = seed + 100.0 + f32(i) * 5.17;
        let a = (hash11(s) - 0.5) * 1.3;
        let dir = vec2<f32>(cos(a), sin(a));
        let k = hash11(s + 1.0);
        let dist = mix(0.3, 0.93, k);
        let r = mix(0.06, 0.018, k) * mix(0.6, 1.25, hash11(s + 2.0));
        let elong = mix(1.4, 3.4, k);
        let d = p - dir * dist;
        let local = vec2<f32>(dot(d, dir) / elong, dot(d, vec2<f32>(-dir.y, dir.x)));
        f += r * r / max(dot(local, local), 1e-6);
    }
    // Salpicaduras sueltas alrededor.
    for (var i = 0; i < 14; i++) {
        let s = seed + 200.0 + f32(i) * 3.91;
        let a = (hash11(s) - 0.5) * 3.6;
        let c = vec2<f32>(cos(a), sin(a)) * mix(0.35, 0.95, hash11(s + 1.0));
        let r = mix(0.008, 0.022, hash11(s + 2.0));
        let d = p - c;
        f += r * r / max(dot(d, d), 1e-6);
    }
    return f;
}

@fragment
fn fs(input: DecalVertexOutput) -> DecalFragmentOutput {
    let screen_pos = input.position.xy / camera.screenSize;
    let depth = textureSample(gLinearDepth, samplerState, screen_pos).x;
    let world_pos = getWorldCoords(screen_pos, depth, camera);

    let rel = world_pos - input.decal_top_left;
    let axis_x_len = length(input.decal_axis_x);
    let axis_z_len = length(input.decal_axis_z);
    let axis_y_len = length(input.decal_axis_y);
    let amount_of_x = dot(rel, input.decal_axis_x) / (axis_x_len * axis_x_len);
    let amount_of_z = dot(rel, input.decal_axis_z) / (axis_z_len * axis_z_len);
    let amount_of_y = dot(rel, input.decal_axis_y) / (axis_y_len * axis_y_len);
    if (amount_of_x < 0.0 || amount_of_x > 1.0 || amount_of_z < 0.0 || amount_of_z > 1.0) {
        discard;
    }
    if (abs(amount_of_y) > 0.5) { discard; }

    let orig_N = textureSample(gBufferNormals, samplerState, screen_pos);
    let surface_normal = normalize(octahedral01ToNormal(orig_N.xy));
    if (abs(dot(surface_normal, normalize(input.decal_axis_y))) < 0.3) { discard; }

    let age = saturate((axis_y_len - 0.5) * 2.0);
    let center = input.decal_top_left + (input.decal_axis_x + input.decal_axis_z) * 0.5;
    let seed = fract(dot(floor(center * 37.0), vec3<f32>(0.1031, 0.1137, 0.0973))) * 1000.0;

    // Borde irregular: el punto se desplaza un poco con ruido antes de evaluar el campo.
    var p = vec2<f32>(amount_of_x, amount_of_z) * 2.0 - 1.0;
    p += (vec2<f32>(valueNoise(p * 9.0 + seed), valueNoise(p * 9.0 - seed)) - 0.5) * 0.05;
    let g = log(splatField(p, seed)); // 0 en el borde
    let aa = max(fwidth(g), 1e-3);
    let coverage = smoothstep(-aa, aa, g);
    let vertical = 1.0 - smoothstep(0.35, 0.5, abs(amount_of_y));
    let fade = 1.0 - smoothstep(0.8, 1.0, age);
    let alpha = coverage * vertical * fade;
    if (alpha < 0.01) { discard; }

    // Grosor: sube rápido en el borde (menisco) y se aplana dentro.
    let thickness = smoothstep(0.0, 1.0, g);
    let wet = 1.0 - smoothstep(0.15, 0.7, age);

    // Fresca: fina roja, gruesa casi negra. Seca: marrón oscuro mate.
    let fresh = mix(vec3<f32>(0.1, 0.004, 0.003), vec3<f32>(0.022, 0.001, 0.0008), thickness);
    let dried = mix(vec3<f32>(0.07, 0.016, 0.01), vec3<f32>(0.028, 0.008, 0.005), thickness);
    let albedo = mix(dried, fresh, wet);
    let roughness = mix(0.65, mix(0.3, 0.16, thickness), wet);

    // Relieve (gradiente de superficie de Mikkelsen) de la altura de la película.
    let height = smoothstep(0.0, 0.5, g) * FILM_HEIGHT * mix(0.4, 1.0, wet);
    let dPdx = dpdx(world_pos);
    let dPdy = dpdy(world_pos);
    let r1 = cross(dPdy, surface_normal);
    let r2 = cross(surface_normal, dPdx);
    let det = dot(dPdx, r1);
    let grad = sign(det) * (dpdx(height) * r1 + dpdy(height) * r2);
    let bumped = normalize(abs(det) * surface_normal - grad);
    let N = normalize(mix(surface_normal, bumped, alpha));

    let orig_albedo = textureSample(gBufferAlbedo, samplerState, screen_pos);
    var output: DecalFragmentOutput;
    output.albedo = vec4<f32>(mix(orig_albedo.rgb, albedo, alpha), mix(orig_albedo.a, 0.0, alpha));
    let encoded = normalToOctahedral01(N);
    output.normal = vec4<f32>(encoded.xy, mix(orig_N.z, roughness, alpha), orig_N.a);
    return output;
}
