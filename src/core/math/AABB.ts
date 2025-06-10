import { mat4, vec3 } from 'gl-matrix';

export class AABB {
  min: vec3;
  max: vec3;

  constructor(min: vec3 = vec3.fromValues(0, 0, 0), max: vec3 = vec3.fromValues(0, 0, 0)) {
    this.min = min;
    this.max = max;
  }

  merge(other: AABB | null): void {
    if (!other) return;

    this.min = vec3.min(this.min, this.min, other.min);
    this.max = vec3.max(this.max, this.max, other.max);
  }

  getCenter(): vec3 {
    const center = vec3.create();
    return vec3.lerp(center, this.min, this.max, 0.5);
  }

  getSize(): vec3 {
    const size = vec3.create();
    return vec3.subtract(size, this.max, this.min);
  }

  transform(matrix: mat4): AABB {
    // Transform AABB by matrix
    const corners = this.getCorners();
    const transformedCorners = corners.map((corner) => {
      const transformed = vec3.create();
      vec3.transformMat4(transformed, corner, matrix);
      return transformed;
    });

    const result = new AABB();
    result.min = vec3.clone(transformedCorners[0]);
    result.max = vec3.clone(transformedCorners[0]);

    for (let i = 1; i < transformedCorners.length; i++) {
      vec3.min(result.min, result.min, transformedCorners[i]);
      vec3.max(result.max, result.max, transformedCorners[i]);
    }

    return result;
  }

  private getCorners(): vec3[] {
    return [
      vec3.fromValues(this.min[0], this.min[1], this.min[2]),
      vec3.fromValues(this.max[0], this.min[1], this.min[2]),
      vec3.fromValues(this.min[0], this.max[1], this.min[2]),
      vec3.fromValues(this.max[0], this.max[1], this.min[2]),
      vec3.fromValues(this.min[0], this.min[1], this.max[2]),
      vec3.fromValues(this.max[0], this.min[1], this.max[2]),
      vec3.fromValues(this.min[0], this.max[1], this.max[2]),
      vec3.fromValues(this.max[0], this.max[1], this.max[2]),
    ];
  }
}
