Revisión de la luz ambiente (difuso + especular) con el SSR nuevo
El SSR en sí está bien planteado, pero cómo se compone el especular ambiente no es físicamente correcto. Hay un error grave y otros dos que hacen que no cuadren las energías.

Lo que está bien
Difuso SH: la proyección multiplica por π, 2π/3 y π/4 (SHProjector.ts:77) y el shader divide por π (albedo/π · E). Es correcto.
SSR: ssr.cs devuelve la radiancia sin pesar por la BRDF, muestreada con GGX VNDF. Promediarla equivale a la radiancia prefiltrada del lóbulo, así que después hay que multiplicarla por el split-sum, que es lo que se hace. Es el mismo espacio de energía que la IBL.
Rayos que no impactan: usan el env prefiltrado en la dirección espejo, con el mip según la rugosidad y el mismo PCC que la IBL. Así, activar o desactivar el SSR no cambia la energía.
En el punto de impacto, accLight ya incluye el difuso ambiente, la luz directa y el emisivo. Es lo que debe reflejarse.
El AO solo afecta al difuso, y la oclusión especular (fórmula de Lagarde) se deriva de él. Correcto.
Errores

1. La BRDF se aplica dos veces (grave). En ambient_specular.fs el shader devuelve rgb = radiancia × splitSum y alpha = media(splitSum) × so. El blend additive_by_src_alpha hace dst += rgb × alpha, así que el resultado final es radiancia × splitSum × splitSum × so.

En un dieléctrico pulido visto de frente, el split-sum vale ≈ 0.04, así que la reflexión sale ≈ 0.0016 en vez de 0.04: unas 25 veces más débil.
En ángulos rasantes el error casi desaparece, y en metales es solo ×0.8.
Por eso los suelos brillantes apenas reflejan salvo de lado, aunque el SSR funcione bien.
La solución es devolver vec4(especular × so, 1) o poner alpha = so. 2. El Fresnel se cuenta dos veces. Ahora se calcula F_Schlick_Roughness(NoV) × A + B, pero la LUT ya integra el Fresnel. Lo correcto, según Karis, es F0 × A + B. Además, el difuso (ambient.fs) ya usa F0·A+B para restar energía, así que en ángulos rasantes la suma de difuso y especular supera 1.

3. La fórmula multi-scatter (Fms) está mal. El término correcto (Fdez-Agüera, el mismo que usa three.js) es FssEss·Favg·Ems / (1 − Favg·Ems). Al código le falta el factor FssEss. En dieléctricos rugosos eso suma un ~+0.04 de especular que no debería existir, es decir, aproximadamente duplica su especular y quedan algo "lechosos". El mismo error está en ambient.fs, ambient_specular.fs y en el multiBounce de ssr.cs.

Problemas medios 4. Orden de pases. El especular ambiente se suma después del agua, los transparentes y el vidrio, y usa el G-buffer opaco (DeferredRenderer.ts:609-620). Resultado: el reflejo del suelo que hay detrás de un cristal, el agua o las partículas se pinta encima de ellos sin atenuarse. Habría que mover el SSR y el especular a justo después de renderAccLight().

5. Oclusión especular sobre los impactos del SSR. La oclusión especular existe porque el cubemap no conoce la geometría local. Un impacto del SSR ya incluye esa oclusión, así que se oscurece dos veces. Solo debería aplicarse a la parte que viene del env (los rayos sin impacto).

6. globalAmbientBoost se aplica al difuso pero no al especular. No es coherente si lo usas para oscurecer escenas.

Menores
multiBounce calcula la BRDF del punto de impacto con V hacia la cámara, cuando debería ir hacia el píxel que refleja. Es una aproximación aceptable.
El tope de luminancia (maxLuminance) quita energía a los reflejos del sol y de los emisivos. Es una decisión estética.
mip = rugosidad × 7 solo es correcto si los cubemaps se prefiltraron con rugosidad = mip/7. No he podido comprobarlo porque se hornean fuera del motor.
