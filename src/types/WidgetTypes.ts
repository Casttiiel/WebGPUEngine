// types/ui/WidgetTypes.ts

export interface WidgetClass {
  name: string; // Widget name (from JSON)
  type: string; // Widget type (e.g. vida, boton, fondo...)
  widget?: Widget;
  controller?: WidgetController;
}

export interface WidgetToLerp {
  element: { value: number };
  maxElement: number;
  value: number;
  initialTime: number;
  lerpTime: number;
  currentTime: number;
  isFirstFrame: boolean;
}

// Forward declarations for type safety
export interface WidgetController {
  update(dt: number): void;
}

export interface WidgetEffect {
  start(): void;
  stop(): void;
  update(dt: number): void;
  onDeactivate?(): void;
  getName(): string;
  changeSpeedUV?(x: number, y: number): void;
  stopUiFx?(): void;
}

export interface WidgetParams {
  visible: boolean;
  position: { x: number; y: number };
  scale: { x: number; y: number };
  rotation: number;
  pivot: { x: number; y: number };
  [key: string]: any;
}

// Widget will be imported from components/ui/Widget
export type Widget = any;
