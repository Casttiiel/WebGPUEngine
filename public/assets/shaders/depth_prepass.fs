#include "common/uniforms"
#include "common/structs"
#include "common/utils"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@fragment
fn fs(input: ShadowsVertexOutput) {
    // Para depth prepass, no necesitamos output de color
    // El depth buffer se llena automáticamente por el GPU
    // Opcionalmente podemos hacer alpha testing aquí si fuera necesario
}
