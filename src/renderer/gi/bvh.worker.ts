/// <reference lib="webworker" />
import { buildBVH, triangleBounds } from './BVHBuilder';

/** BLAS build request: one mesh in object space. */
export interface BLASRequest {
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
  maxLeafSize: number;
}

export interface BLASResponse {
  id: number;
  nodes: Float32Array;
  order: Uint32Array;
}

self.onmessage = (e: MessageEvent<BLASRequest>) => {
  const { id, positions, indices, maxLeafSize } = e.data;
  const bounds = triangleBounds(positions, indices);
  const { nodes, order } = buildBVH({ bounds, count: bounds.length / 6, maxLeafSize });
  const response: BLASResponse = { id, nodes, order };
  (self as unknown as Worker).postMessage(response, [nodes.buffer, order.buffer]);
};
