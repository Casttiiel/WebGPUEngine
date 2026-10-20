export interface ReflectionProbeComponentData {
  resolution?: number;
  radius?: number;
  extents?: [number, number, number];
  type?: 'indoor' | 'outdoor';
  /** Cross-fade distance at the influence box faces (metres): one value, or per axis. */
  fade?: number | [number, number, number];
  /** Influence box centre relative to the probe position (capture point). */
  boxOffset?: [number, number, number];
}
