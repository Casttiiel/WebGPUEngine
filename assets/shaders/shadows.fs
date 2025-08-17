#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> object: ObjectUniforms;

@fragment
fn fs(input: ShadowsVertexOutput) {
    // Para depth-only shadow mapping, no necesitamos output de color
    // El depth buffer se llena automáticamente por el GPU
    // Opcionalmente podemos hacer alpha testing aquí si fuera necesario
}