#include "common/uniforms"
#include "common/particles"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(5) var txSampler: sampler;
@group(3) @binding(1) var<uniform> renderParams: ParticleRenderParams;
@group(3) @binding(11) var gLinearDepth: texture_2d<f32>; // profundidad de vista / cameraFar

@fragment
fn fs(
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) particleColor: vec4<f32>,
#ifdef LIT
    @location(2) fog: vec4<f32>,
#endif
    @location(6) extra: vec4<f32>,
) -> @location(0) vec4<f32> {
    // Flipbook: frame actual, fundido con el siguiente.
    var texColor = textureSample(txAlbedo, txSampler, uv);
    let nextColor = textureSample(txAlbedo, txSampler, extra.xy);
    texColor = mix(texColor, nextColor, extra.z);

    var color = texColor * particleColor;

    // Soft particles: se funden donde se acercan a la escena (sin corte duro al cruzarla).
    if (renderParams.softDistance > 0.0) {
        let dims = vec2<f32>(textureDimensions(gLinearDepth));
        let pixel = vec2<i32>(clamp(fragCoord.xy / camera.screenSize * dims, vec2<f32>(0.0), dims - 1.0));
        let sceneDepth = textureLoad(gLinearDepth, pixel, 0).x * camera.cameraFar;
        color.a *= saturate((sceneDepth - extra.w) / renderParams.softDistance);
    }
#ifdef LIT
    // La niebla entre la cámara y la partícula (se dibuja después de la composición de niebla).
    color = vec4<f32>(color.rgb * fog.a + fog.rgb, color.a);
#endif
    return color;
}
