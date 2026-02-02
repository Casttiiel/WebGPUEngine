
struct SpeedUniforms {
    speed: f32,
    strength: f32,
    c: f32,
    time: f32
}

fn inverseLerp(a: f32, b: f32, x: f32) -> f32 {
    return (x - a) / (b - a);
}

fn vectorToRadial(
    uv: vec2<f32>,
    center: vec2<f32>
) -> vec2<f32> {

    let d = uv - center;

    // Ángulo: -PI..PI → 0..1
    let angle = atan2(d.y, d.x);
    let angle01 = angle / (2.0 * 3.14159265) + 0.5;

    // Radio (no normalizado)
    let radius = length(d);

    return vec2<f32>(angle01, radius);
}

fn vectorToRadialNormalized(
    uv: vec2<f32>,
    center: vec2<f32>,
    innerRadius: f32,
    outerRadius: f32
) -> vec2<f32> {

    let d = uv - center;

    let angle = atan2(d.y, d.x);
    let angle01 = angle / (2.0 * 3.14159265) + 0.5;

    let radius = length(d);
    let radius01 = clamp(
        (radius - innerRadius) / (outerRadius - innerRadius),
        0.0,
        1.0
    );

    return vec2<f32>(angle01, radius01);
}

@group(0) @binding(0) var noiseTexture: texture_2d<f32>;
@group(0) @binding(1) var noiseSampler: sampler;
@group(1) @binding(0) var<uniform> params: SpeedUniforms;

@fragment
fn fs(@location(0) uv: vec2<f32>,) -> @location(0) vec4<f32> {

    let center = vec2<f32>(0.5, 0.5);
    let dir = uv - center;
    let dist = length(dir);
    let otherCenter = vec2<f32>(0.5, 0.5);

    let minMask = 0.4;
    let maxMask = 2.0;
    let outterIntensity = 15.0;
    let lineWidth = 20.0;

    let textureScale = vec2<f32>(20.0, 1.0);

    let halo = 1.0 - (outterIntensity * clamp(inverseLerp(minMask, minMask + maxMask, dist), 0.0,1.0));
    let radialUvs = vectorToRadialNormalized(uv, otherCenter, 0.0, 1.0) * textureScale - vec2<f32>(params.time * 0.5, params.time * 2.0);
    let noise = textureSample(noiseTexture, noiseSampler, radialUvs).r;
    let mask = smoothstep(halo, lineWidth + halo, noise) * params.speed;

    let lineColor = vec3<f32>(1.0);

    return vec4<f32>(lineColor, mask);
}