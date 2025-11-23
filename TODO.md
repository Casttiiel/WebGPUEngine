## Player

1. New scene
   1. Coyote Time

Permite saltar un pequeño instante después de haber salido del borde.
Evita saltos “que deberían haber salido”.

✅ 2. Jump Buffering (o Input Buffer)

Si el jugador presiona el botón de salto un poco antes de tocar el suelo, el juego recuerda el input y ejecuta el salto al aterrizar.
Hace que el juego responda incluso si el timing no fue perfecto al milisegundo.

✅ 3. Variable Jump Height

Dejar presionado el botón → salto más alto.
Soltarlo antes → salto más corto.
Da mucho control al jugador.

✅ 4. Cut Jump / Jump Cancel

Al soltar el botón de salto, la velocidad vertical se corta más fuerte.
Hace que los saltos se sientan “afilados”, como en Celeste.

✅ 5. Grace Time al Aterrizar

Permite acciones (como dash, salto o ataque) durante 1–3 frames después de tocar el suelo, aunque aún no se haya “restablecido” el personaje al 100%.

✅ 6. Input Leniency (Tolerance Windows)

Un ligero margen para direcciones (arriba/diagonal) o combinaciones (doble salto, dash).
Hace que el control sea más “humano”.

✅ 7. Jump Hang Time

Reducir por un instante la gravedad en el pico del salto.
Da una sensación más “flotante” pero controlada.

✅ 8. Forgiving Ledges (Auto-step o Edge Correction)

Cuando el personaje cae contra el borde pero se quedó a unos pocos píxeles, el juego lo empuja ligeramente para arriba.
Usado en muchos plataformers modernos sin que el jugador lo note.

✅ 9. Acceleration & Deceleration Curves

Que el personaje no empiece ni se detenga de golpe.
Puede ser simple (aceleración lineal) o natural (curvas exponenciales).
Hace el movimiento más orgánico.

✅ 10. Momentum Conservation

Ej.: si vienes corriendo, el salto inicial es ligeramente más largo.
Muy usado en Mario.

✅ 11. Terminal Velocity Control

Límite superior a la velocidad de caída para que no se vuelva inmanejable.
O aumentar la gravedad mientras se cae, pero frenarla al aterrizar.

✅ 12. Wall Coyote Time

Para wall jumps: un mini-margen que te permite saltar de la pared incluso si ya te “deslindaste” por 1–3 frames.

✅ 13. Ledge Grab or Ledge Forgiveness

No es lo mismo que auto-step: aquí el personaje se agarra automáticamente al borde cercano si es intuitivo hacerlo.

✅ 14. Run-off Forgiveness

Si te aproximas a un borde corriendo y el salto se presionó durante la animación de caída inicial, aún cuenta como salto en el borde.
-Camera rotation smoothing?

Ambient occlusion?
Borde raro en objetos
