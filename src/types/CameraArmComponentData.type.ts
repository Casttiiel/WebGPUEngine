export type CameraArmComponentDataType = {
  offset?: number[]; // [x, y, z] - Offset en espacio local
  targetOffset?: number[]; // [x, y, z] - Punto al que mira la cámara
  smoothSpeed?: number; // Velocidad de interpolación
  enableCollision?: boolean; // Activar raycast de colisión
  collisionRadius?: number; // Radio para el raycast
  mouseSensitivity?: number; // Sensibilidad del mouse
  enableMouseLook?: boolean; // Control con mouse
};
