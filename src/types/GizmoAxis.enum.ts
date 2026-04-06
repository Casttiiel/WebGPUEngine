export enum GizmoAxis {
  NONE = 'none',
  X = 'x',
  Y = 'y',
  Z = 'z',
  XY = 'xy', // Plano XY
  YZ = 'yz', // Plano YZ
  XZ = 'xz', // Plano XZ
  VIEW = 'view', // Centro (para mover libre)
  // Probe face resize handles
  PROBE_PX = 'probe_px',
  PROBE_NX = 'probe_nx',
  PROBE_PY = 'probe_py',
  PROBE_NY = 'probe_ny',
  PROBE_PZ = 'probe_pz',
  PROBE_NZ = 'probe_nz',
}
