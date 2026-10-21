// Sangre (particle_blood.tech, defines LIT + BLOOD). Forma procedural, sin textura:
//  - gota (shape 0): borde irregular, más fina hacia la estela si va estirada, iluminada
//    como una esfera de líquido: oscura donde es gruesa, el sol la atraviesa por los bordes
//    y un brillo especular húmedo;
//  - neblina (shape 1): mancha de ruido que se erosiona con la edad (no se desvanece plana).
// El color difuso ya viene iluminado del VS (sol + sombra + probes); aquí la forma y el brillo.

@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(5) var txSampler: sampler;

fn hash21(p: vec2<f32>) -> f32 {
    let q = fract(p * vec2<f32>(123.34, 456.21));
    return fract((q.x + 45.32) * (q.y + 45.32) * 33.7 + dot(q, q + 45.32));
}

fn valueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash21(i);
    let b = hash21(i + vec2<f32>(1.0, 0.0));
    let c = hash21(i + vec2<f32>(0.0, 1.0));
    let d = hash21(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2<f32>) -> f32 {
    return valueNoise(p) * 0.55 + valueNoise(p * 2.1 + 17.3) * 0.3 + valueNoise(p * 4.3 + 41.7) * 0.15;
}

@fragment
fn fs(
    @location(0) uv: vec2<f32>,
    @location(1) particleColor: vec4<f32>,
    @location(2) fog: vec4<f32>,
    @location(3) sunLocal: vec3<f32>,
    @location(4) sunLight: vec3<f32>,
    @location(5) misc: vec4<f32>,
) -> @location(0) vec4<f32> {
    let seed = misc.x * 97.0;
    let lifeT = misc.y;
    let p = uv * 2.0 - 1.0; // [-1, 1]; y = dirección de movimiento si va estirada

    var color: vec3<f32>;
    var alpha: f32;

    // Forma de la gota (fuera del if: las derivadas piden flujo de control uniforme).
    // Estirada: cabeza redonda delante (y > 0), se afila hacia la estela.
    let stretched = saturate((misc.w - 1.0) * 0.5);
    let width = mix(1.0, mix(0.3, 1.0, smoothstep(-1.0, 0.5, p.y)), stretched);
    let q = vec2<f32>(p.x / width, p.y);
    let r = length(q);
    let aa = max(fwidth(r) * 1.5, 0.02);

    if (misc.z < 0.5) {
        // ── Gota ─────────────────────────────────────────────────────────────
        // Borde irregular (el líquido no es un círculo perfecto).
        let angle = atan2(q.y, q.x);
        let edge = 0.86 + 0.12 * (valueNoise(vec2<f32>(angle * 1.6 + seed, seed)) - 0.5) * 2.0;
        alpha = 1.0 - smoothstep(edge - aa, edge, r);
        if (alpha <= 0.002) { discard; }

        // Normal de una lente de líquido: más plana que una esfera.
        let rn = saturate(r / edge);
        let nz = sqrt(max(1.0 - rn * rn, 0.0));
        let n = normalize(vec3<f32>(q.x * 0.8, q.y * 0.8, nz + 0.35));
        let L = normalize(sunLocal);
        let V = vec3<f32>(0.0, 0.0, 1.0);

        // Grosor: el centro casi negro, los bordes finos dejan pasar la luz (más rojos).
        let thickness = nz;
        let albedoLit = particleColor.rgb * mix(1.25, 0.45, thickness);
        let rim = pow(1.0 - thickness, 2.0) * saturate(-L.z * 0.5 + 0.5);
        // particleColor ya está iluminado: el borde a contraluz solo se aclara un poco.
        let transmitted = particleColor.rgb * rim * 0.6;

        // Brillo húmedo: Blinn-Phong normalizado con Fresnel de agua (F0 ≈ 0.02).
        let H = normalize(L + V);
        let NdotH = max(dot(n, H), 0.0);
        let NdotV = max(n.z, 0.0);
        let fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
        let gloss = 180.0;
        let spec = pow(NdotH, gloss) * (gloss + 8.0) / 25.13 * fresnel * max(dot(n, L), 0.0);
        color = albedoLit + transmitted + sunLight * spec;
        alpha *= particleColor.a;
    } else {
        // ── Neblina ──────────────────────────────────────────────────────────
        let n = fbm(p * 2.2 + vec2<f32>(seed, seed * 1.7));
        let density = (1.0 - smoothstep(0.15, 1.0, length(p))) * (0.45 + n);
        // Erosión: el umbral sube con la edad y la mancha se deshace por sus zonas finas.
        let threshold = lifeT * 0.85;
        alpha = saturate((density - threshold) / 0.3) * particleColor.a;
        if (alpha <= 0.002) { discard; }
        color = particleColor.rgb * (0.75 + 0.5 * n);
    }

    // La niebla entre la cámara y la partícula.
    color = color * fog.a + fog.rgb;
    return vec4<f32>(color, alpha);
}
