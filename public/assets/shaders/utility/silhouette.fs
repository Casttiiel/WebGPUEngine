// ─── Silueta de personaje ocluido ─────────────────────────────────────────────
//
// Segunda pasada de un personaje (categoría transparent, después de la iluminación).
// Solo pinta los píxeles del personaje que tienen algo delante en la escena: compara su
// profundidad con la del G-buffer (linear_depth). Si la escena está más de `minGap` metros
// por delante, está tapado → color plano con el borde más intenso. Si no, descarta: así
// un muro que tapa medio cuerpo deja silueta solo en esa mitad, y el propio brazo del
// personaje (que está a pocos centímetros) no cuenta como oclusor.

#include "common/structs"
#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txLinearDepth: texture_2d<f32>;
@group(1) @binding(1) var<uniform> params: SilhouetteParams;

struct SilhouetteParams {
    color:   vec4<f32>,  // offset  0  (baseColorFactor)
    _pad0:   vec4<f32>,  // offset 16
    minGap:  f32,        // offset 32  (uvXScale) metros que tiene que haber delante
    rimMin:  f32,        // offset 36  (uvYScale) opacidad del centro respecto al borde (0-1)
    _pad1:   f32,        // offset 40
    _pad2:   f32,        // offset 44
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let coord = vec2<i32>(i32(input.position.x), i32(input.position.y));
    let sceneDepth = textureLoad(txLinearDepth, coord, 0).r * camera.cameraFar;
    let ownDepth = dot(input.WorldPos - camera.cameraPosition.xyz, camera.cameraFront.xyz);
    if (sceneDepth <= 0.0 || sceneDepth > ownDepth - params.minGap) {
        discard;
    }

    // Borde más intenso (fresnel): se lee como silueta y no como una mancha plana.
    let V = normalize(camera.cameraPosition.xyz - input.WorldPos);
    let rim = 1.0 - abs(dot(normalize(input.N), V));
    let alpha = params.color.a * mix(params.rimMin, 1.0, rim * rim);
    return vec4<f32>(params.color.rgb, alpha);
}
