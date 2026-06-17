# VFX Roadmap — Quantum Break Stutters System

Síntesis técnica del sistema de anomalías temporales de Remedy (GDC 2017).
Cada fase es un bloque independiente que se puede implementar y iterar solo.
El orden importa: las fases 1 y 2 son el núcleo visible; el resto es detail pass.

---

## Contexto: qué hizo Remedy exactamente

```
Fluid simulation (GPU) 
  → proyectada sobre el mundo en world-space
  → distorsiona vértices de la geometría
  → se usa también como fuente de luz proyectada dentro de la anomalía
  → los bordes de mayor magnitud spawnean partículas que sampean el color de la escena
  → trails de luz sobre esas partículas (long-exposure)
  → color grading infrarrojo en toda la zona
  → intensidad general conducida por amplitud de audio en tiempo real
```

El "look" sale de que el mismo texture drive todo: distorsión + luz + partículas comparten
la misma fuente, así que todo pulsa y se mueve de forma coherente.

---

## Estado actual del motor (relevante para este roadmap)

| Sistema existente | Rol aquí |
|---|---|
| `ShockwavePostProcessComponent` | Referencia de compute screen-space distortion |
| `ParticleSystemComponent` | Base para partículas de desintegración |
| `TrailRendererComponent` | Base para light trails |
| `TiledLightManager` | Donde vive la iluminación dinámica de zona |
| `DISTORSIONS` render category | Distorsiones de geometría existentes (no tocar) |
| `ChromaticAberrationComponent` | Referencia de CA global — la anomalía necesita CA local |
| `DeferredRenderer` + `accLight` RT | Target de lectura para color de partículas |
| `FilmGrainComponent` / `VignetteComponent` | Referencia de post-process zoneado |

---

## Fase 0 — StutterZoneComponent (fundación)

**Qué es**: entidad que define el volumen de la anomalía y expone la API central.
Todo lo demás en este roadmap se engancha a esta entidad.

**Datos que gestiona**:
```typescript
interface StutterZoneData {
  radius:    number;       // radio en metros
  intensity: number;       // 0-1, master drive de todo el sistema
  decayRate: number;       // velocidad de desvanecimiento natural
  audioSync: boolean;      // si la intensidad la conduce el audio
}
```

**Lifecycle**:
- `spawn()` → fade-in hasta intensity target
- `update(dt)` → decae automáticamente si no hay refeed (o audio la mantiene)
- `despawn()` → fade-out y destroy

**Dependencias**: ninguna. Esta es la piedra base.

**Complejidad**: baja. Es un Component + UBO + math de esfera.

---

## Fase 1 — Fluid Distortion (el efecto principal)

**Qué hace Remedy**: una simulación de fluidos GPU proyectada en world-space sobre la geometría
distorsiona sus vértices. Es persistente mientras dure la anomalía.

**Aproximación para este motor**:

Remedy desplaza vértices en un pre-pass de geometría. En un deferred renderer esto es costoso
(requiere render separado de objetos dentro de la zona). La aproximación screen-space es
prácticamente indistinguible a distancia media y consiste en:

```
StutterDistortionPass (compute, similar a ShockwavePass)
  group(0) CameraUniforms
  group(1) accLight + gLinearDepth + sampler
  group(2) outputTex (storage rgba16float)
  group(3) StutterZoneUBO (origin, radius, intensity, time)
  group(4) fluidTexture (animated noise, RG16Float, 256×256)
```

**El fluid texture**:
En lugar de simular fluidos reales (costoso), se genera un pseudo-fluid texture en compute
usando domain-warped FBM en múltiples octavas + curl noise para el campo de velocidades.
Se actualiza cada frame en un pass separado de 16×16 tiles. Esto da el look de fluido
sin el coste de una simulación SPH.

```
FluidSimPass (compute 32×32 workgroups sobre textura 256×256)
  → domain warp: p' = p + fbm(p + time)
  → curl field: ∂f/∂y, -∂f/∂x de la función de flujo
  → resultado: RG = velocidad del fluido (usada como offset UV)
```

**Proyección world-space** (en el distortion compute):
```wgsl
// Mapear worldPos a UV del fluid texture
let zoneUV = (worldPos.xz - zone.origin.xz) / (zone.radius * 2.0) + 0.5;
let fluidOffset = textureSampleLevel(fluidTex, sampler, zoneUV, 0.0).rg;
let screenOffset = fluidOffset * zone.intensity * w_mask;
```

**Look "facetado/prismático"**: 
La textura del fluido se filtra con un Voronoi cell pattern multiplicado sobre el
campo de velocidades. Cada celda tiene una fase temporal ligeramente diferente, dando
el aspecto cristalino / "espacio rompiéndose en facetas".

**Sistemas nuevos**:
- `FluidSimPass.ts` — compute pass 256×256, actualiza fluid texture
- `StutterDistortionPass.ts` — compute pass fullscreen, aplica distorsión (similar a ShockwavePass)
- `StutterZoneComponent.ts` — componente en la entidad de zona

**Sistemas tocados**:
- `ModuleRender.ts` — nuevo hook en generateFrame después del shockwave pass

**Complejidad**: media. FluidSimPass es el trabajo nuevo; el distortion pass copia la estructura del shockwave.

---

## Fase 2 — Anomaly Lighting (luz prismática)

**Qué hace Remedy**: la misma fluid texture se proyecta como fuente de luz dentro de la anomalía,
con colores espectrales/prismáticos. La luz pulsa con el fluido.

**Aproximación**:

Dos capas:

### 2A — Projected volume light
Un light especial en TiledLightManager con una cookie texture (el fluid texture) proyectada
desde el centro de la zona. El shader del tiled lighting samplea la cookie para modular
el color de la luz, dando bandas de color prismáticas sobre la geometría.

Esto se puede mockear sin tocar TiledLightManager creando un PointLight estándar + blend
aditivo de un fullscreen pass que aplica el projected pattern solo a pixels dentro de la zona.

### 2B — Prismatic spectrum overlay
Post-process compute adicional (o dentro del distortion pass) que añade un overlay de luz
aditiva dentro de la zona basado en el fluid texture rotado 90°:

```wgsl
// Color espectral — mapear magnitud del fluido a espectro HSV
let hue    = fluidMag * 0.8;                 // recorre ~80% del espectro
let spec   = hsvToRgb(hue, 0.9, fluidMag);  // saturado, valor = magnitud
let additive = spec * zone.intensity * mask * 0.4;
output = original + additive;
```

El `hsvToRgb` en WGSL son 6 líneas. El resultado son las bandas de arcoíris/prisma
que caracterizan el look de Remedy.

**Sistemas nuevos**:
- `AnomalyLightPass.ts` — compute que aplica el overlay espectral aditivo
- `hsvToRgb` helper en el shader

**Complejidad**: baja-media. La parte difícil (FluidSimPass) ya está de la fase 1.

---

## Fase 3 — Particle Disintegration

**Qué hace Remedy**: spawnea partículas desde los bordes de mayor magnitud de distorsión.
Las partículas reciben el color de la superficie subyacente, creando la sensación de
que el mundo se desintegra.

**El problema de color sampling**:
Las partículas necesitan el color de la escena en el punto donde se emiten. En un deferred
renderer, `accLight` está disponible como texture. Si las partículas se emiten en CPU,
el color se obtiene haciendo un readback (1-2 frames de latencia, aceptable).
Si se emiten en GPU (ideal), se puede samplear directamente en el compute de spawn.

**Aproximación**:

### 3A — Spawn points desde fluid magnitude
Cada frame, el FluidSimPass escribe en un buffer adicional las posiciones world-space
donde `length(fluidVelocity) > threshold` (los "bordes" de alta energía).
Estas posiciones se pasan al ParticleSystemComponent de la zona como puntos de emisión.

### 3B — Color at emission
El GPU particle spawn compute samplea `accLight` (pasado como binding extra) en la
posición proyectada de cada spawn point para obtener el color de la superficie.
Ese color se almacena en el vertex buffer de las partículas y se usa como `baseColor` multiplicado
sobre el color de la partícula.

```wgsl
// En el particle spawn compute
let screenUV = worldToScreenUV(spawnPos, camera);
let surfaceColor = textureSampleLevel(accLight, sampler, screenUV, 0.0).rgb;
particle.color = surfaceColor * particle.baseAlpha;
```

**Comportamiento de la partícula**:
- Pequeños cuadrados / fragmentos (billboards con texture cuadrada rota)
- Se desplazan en la dirección del campo del fluido (velocity = fluidVelocity * scale)
- Fade-out rápido (0.3-0.8s)
- Glow aditivo (blend mode additive)

**Sistemas nuevos**:
- Extensión del FluidSimPass para escribir spawn buffer
- Extensión del ParticleSystemComponent (o componente derivado) para GPU color sampling

**Complejidad**: alta. Requiere sincronización GPU→GPU entre FluidSimPass y particle spawn.

---

## Fase 4 — Light Trails

**Qué hace Remedy**: trails de luz sobre las partículas más grandes, inspirados en fotografía
de larga exposición. Complementan el look "glitch".

**Aproximación**:
Las partículas de la fase 3 llevan adjunto un TrailRendererComponent ligero.
Los trails usan blend aditivo con glow (wide gaussian) para dar el look de exposición larga.

El "long exposure" genuino se consigue acumulando temporalmente los trails en un RT separado
con decay exponencial, similar al motion blur:

```
trailAccum = trailAccum * 0.92 + newTrailColor * 0.08
```

Cada frame se blendea este buffer de forma aditiva sobre accLight antes del tone mapping.

**Sistemas nuevos**:
- `LightTrailAccumPass.ts` — RT de acumulación + decay compute
- O simplemente: ajustar `TrailRendererComponent` para que use blend aditivo con glow

**Complejidad**: baja si usa TrailRendererComponent existente. Media si se hace el RT de acumulación.

---

## Fase 5 — Audio-Driven Intensity

**Qué hace Remedy**: la amplitud del audio (probablemente mid-frequency band) conduce
la intensidad de toda la distorsión en tiempo real. Sin audio, el efecto puede coexistir
pero pierde la sincronía característica.

**Aproximación para Web Audio API**:
```typescript
class AudioEnvelopeComponent extends Component {
  private analyser: AnalyserNode;
  private buffer: Float32Array;
  public envelope: number = 0;  // 0-1, lo lee StutterZoneComponent

  update(dt: number): void {
    this.analyser.getFloatFrequencyData(this.buffer);
    // RMS de banda media (300-3000 Hz)
    const rms = computeBandRMS(this.buffer, 300, 3000);
    // Envelope follower: ataque rápido, release lento
    const target = rms;
    const speed  = target > this.envelope ? 20.0 : 5.0;
    this.envelope += (target - this.envelope) * speed * dt;
  }
}
```

`StutterZoneComponent.update()` lee `audioEnvelope.envelope` y lo mezcla con su intensity base.

**Sistemas nuevos**:
- `AudioEnvelopeComponent.ts`

**Complejidad**: baja.

---

## Fase 6 — Zone Color Grading (Infrared)

**Qué hace Remedy**: color grading específico dentro de la zona, inspirado en fotografía
infrarroja: alto contraste, rojos muy amplificados, sombras desplazadas a cian/teal,
sensación "sobreexpuesta" en las altas luces.

**Aproximación**:
Una LUT 3D (16³ o 32³) precalculada con el look infrarrojo, aplicada solo a pixels
dentro del screen-footprint de la zona (máscara circular world-space, mismo check que
el distortion pass).

El blend entre LUT normal y LUT infrarroja se controla con `zone.intensity`:
```wgsl
let graded    = sampleLUT(lut_infrared, original.rgb);
let finalColor = mix(original.rgb, graded, mask * zone.intensity);
```

Alternativamente, sin LUT, los 4 parámetros de infrarrojo se pueden emular inline:
```wgsl
// Infrared look sin LUT:
let ir = original;
ir.r   = pow(ir.r, 0.6) * 1.4;           // rojos muy boosteados
ir.gb  = ir.gb * 0.85;                    // verdes/azules atenuados
let lum = dot(ir.rgb, vec3(0.2126, 0.7152, 0.0722));
ir.rgb = mix(vec3(0.0, 0.08, 0.12), ir.rgb, lum * 1.3 + 0.1); // sombras cian
```

**Sistemas nuevos**:
- Extensión del StutterDistortionPass (añadir color grading al mismo compute final)
- O `StutterColorGradePass.ts` separado

**Complejidad**: muy baja una vez que el mask de zona existe.

---

## Orden de implementación recomendado

```
[ ] Fase 0  StutterZoneComponent + UBO + lifecycle
[ ] Fase 1  FluidSimPass (compute 256×256) + StutterDistortionPass
[ ] Fase 2  AnomalyLightPass (spectral overlay aditivo)
[ ] Fase 6  Color grading inline en el distortion pass (coste marginal)
[ ] Fase 3  Particle disintegration (GPU spawn + color sampling)
[ ] Fase 4  Light trails (si TrailRenderer no es suficiente → acum RT)
[ ] Fase 5  Audio envelope (independiente, añadir en cualquier momento)
```

Las fases 0+1+2+6 son el "Stutter core" — dan el 80% del look con el 40% del trabajo.
Las fases 3+4 son el detail pass que lo lleva al nivel Remedy.
La fase 5 es el bonus cinematográfico.

---

## Notas de arquitectura

**Un solo fluid texture, múltiples consumidores**:
El `FluidSimPass` escribe una textura `RG16Float 256×256` que se pasa como binding
a todos los demás passes. Esto garantiza la coherencia visual que Remedy describe:
distorsión, luz, partículas y trails todos leen la misma fuente.

**Max zones simultáneas**:
Igual que el shockwave, un UBO con `count + array<StutterZoneData, 4>` es suficiente.
Las anomalías temporales de Quantum Break raramente overlappan más de 2-3.

**Separación de concerns**:
- `FluidSimPass` — solo simula y escribe el fluid texture
- `StutterDistortionPass` — lee fluid, escribe accLight distorsionada
- `AnomalyLightPass` — lee fluid, escribe additive light overlay
- `StutterZoneComponent` — orquesta los tres, gestiona lifecycle e intensity
