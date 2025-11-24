export type CameraFOVModifierComponentDataType = {
  baseFOV?: number; // FOV base en reposo (grados)
  maxFOVIncrease?: number; // Incremento máximo de FOV (grados)
  speedThreshold?: number; // Velocidad mínima para activar (m/s)
  maxSpeed?: number; // Velocidad máxima para FOV completo (m/s)
  lerpSpeed?: number; // Velocidad de interpolación del FOV
  enabled?: boolean; // Activar/desactivar el efecto
};
