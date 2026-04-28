/** A single keyframe in a view-model animation clip */
export interface ViewModelKeyframe {
  /** Time in seconds */
  time: number;
  /** Local position offset [x, y, z] */
  position: [number, number, number];
  /** Local rotation quaternion [x, y, z, w] */
  rotation: [number, number, number, number];
  /** Local scale [x, y, z] */
  scale: [number, number, number];
}

/** A named clip containing sorted keyframes */
export interface ViewModelClip {
  name: string;
  /** Total duration in seconds (if omitted, inferred from last keyframe time) */
  duration?: number;
  loop?: boolean;
  keyframes: ViewModelKeyframe[];
}

/** JSON data format for a view-model animation asset */
export interface ViewModelAnimationData {
  clips: ViewModelClip[];
}
