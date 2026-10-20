// ─── Silueta de personaje ocluido ─────────────────────────────────────────────
//
// Segunda pasada de un personaje (categoría transparent, después de la iluminación).
// Solo pinta los píxeles del personaje que tienen algo delante en la escena: compara su
// profundidad con la del G-buffer (linear_depth). Si la escena está más de `minGap` metros
// por delante, está tapado → color plano con el borde más intenso. Si no, descarta: así
// un muro que tapa medio cuerpo deja silueta solo en esa mitad.
//
// Un personaje no se ocluye a sí mismo: se reconstruye el punto de la escena que tapa el
// píxel y, si cae dentro de la cápsula vertical del propio personaje (eje en el origen
// del modelo, radio `selfRadius`, alto `selfHeight`), el oclusor es su propio cuerpo
// (torso delante del brazo, una pierna delante de la otra) → descarta. Las coberturas
// quedan fuera de esa cápsula porque el colisionador no deja pegarse más.

#include "common/structs"
#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txLinearDepth: texture_2d<f32>;
@group(1) @binding(1) var<uniform> params: SilhouetteParams;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

struct SilhouetteParams {
    color:   vec4<f32>,  // offset  0  (baseColorFactor)
    _pad0:   vec4<f32>,  // offset 16
    minGap:  f32,        // offset 32  (uvXScale) metros que tiene que haber delante
    rimMin:  f32,        // offset 36  (uvYScale) opacidad del centro respecto al borde (0-1)
    selfRadius: f32,     // offset 40  (surfaceBlend) radio horizontal del propio cuerpo
    selfHeight: f32,     // offset 44  (pomScale) alto del propio cuerpo desde los pies
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let coord = vec2<i32>(i32(input.position.x), i32(input.position.y));
    let sceneDepth = textureLoad(txLinearDepth, coord, 0).r * camera.cameraFar;
    let ownDepth = dot(input.WorldPos - camera.cameraPosition.xyz, camera.cameraFront.xyz);
    if (sceneDepth <= 0.0 || sceneDepth > ownDepth - params.minGap) {
        discard;
    }

    // Punto de la escena delante del píxel: mismo rayo, a la profundidad del G-buffer.
    let toFrag = input.WorldPos - camera.cameraPosition.xyz;
    let occluder = camera.cameraPosition.xyz + toFrag * (sceneDepth / ownDepth);
    let local = occluder - object.modelMatrix[3].xyz;
    if (dot(local.xz, local.xz) < params.selfRadius * params.selfRadius &&
        local.y > 0.02 && local.y < params.selfHeight) {
        discard;
    }

    // Borde más intenso (fresnel): se lee como silueta y no como una mancha plana.
    let V = normalize(camera.cameraPosition.xyz - input.WorldPos);
    let rim = 1.0 - abs(dot(normalize(input.N), V));
    let alpha = params.color.a * mix(params.rimMin, 1.0, rim * rim);
    return vec4<f32>(params.color.rgb, alpha);
}
