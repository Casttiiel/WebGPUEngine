// Contact-sheet renderer for authored animations: stick-figure frames from several
// views, an onion-skin overlay with the weapon-tip path, and speed curves. Output PNG.
import sharp from 'sharp';
import { vec3, quat } from 'gl-matrix';

const BONES_SKIP = /(index|middle|ring|pinky|thumb)_0[2-4]|leaf/;
const VIEWS = {
  // project model-space point → [x, y] (y up). Character faces +Z, left is +X.
  side: (p) => [p[2], p[1]], // seen from character's right: forward → screen right
  front: (p) => [p[0], p[1]], // seen from the front (character's right on screen left)
  top: (p) => [p[2], p[0]], // from above: forward → right, character left → up
  three4: (p) => {
    const a = 50 * Math.PI / 180; // camera orbits 50° from the side toward the front
    return [p[2] * Math.cos(a) - p[0] * Math.sin(a), p[1] + 0.25 * (p[2] * Math.sin(a) + p[0] * Math.cos(a))];
  },
};

function boneSegments(pose) {
  const segs = [];
  const { names, parents } = pose.skel;
  for (let i = 0; i < names.length; i++) {
    const p = parents[i];
    if (p < 0 || names[p] === 'root' || BONES_SKIP.test(names[i])) continue;
    const side = /_l$/.test(names[i]) ? 'L' : /_r$/.test(names[i]) ? 'R' : 'C';
    segs.push([pose.pos(names[p]), pose.pos(names[i]), side]);
  }
  return segs;
}

/** Frame point with the frame's stitching offset (combo sheets place clips one after another). */
const at = (frame, p) => (frame.offset ? vec3.add(vec3.create(), p, frame.offset) : p);

const COL = { L: '#3a7bd5', R: '#d5493a', C: '#333' };

function drawFigure(frame, view, tx, opacity = 1, thin = false) {
  let s = '';
  for (const [a, b, side] of boneSegments(frame.pose)) {
    const [x1, y1] = tx(VIEWS[view](at(frame, a))), [x2, y2] = tx(VIEWS[view](at(frame, b)));
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COL[side]}" stroke-width="${thin ? 1.2 : 3}" stroke-linecap="round" opacity="${opacity}"/>`;
  }
  const h = tx(VIEWS[view](at(frame, frame.pose.pos('Head'))));
  s += `<circle cx="${h[0]}" cy="${h[1]}" r="${thin ? 3 : 7}" fill="none" stroke="#333" stroke-width="${thin ? 1 : 2}" opacity="${opacity}"/>`;
  if (frame.spear) {
    const [b1, b2] = tx(VIEWS[view](at(frame, frame.spear.butt))), [t1, t2] = tx(VIEWS[view](at(frame, frame.spear.tip)));
    s += `<line x1="${b1}" y1="${b2}" x2="${t1}" y2="${t2}" stroke="#8a6d3b" stroke-width="${thin ? 1.2 : 2.5}" opacity="${opacity}"/>`;
    s += `<circle cx="${t1}" cy="${t2}" r="${thin ? 1.5 : 3.5}" fill="#c9a227" opacity="${opacity}"/>`;
  }
  if (frame.target) {
    const [x, y] = tx(VIEWS[view](at(frame, frame.target)));
    s += `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#2a2" stroke-width="2" opacity="${opacity}"/>`;
  }
  return s;
}

/**
 * frames: [{ t, pose, spear?: {butt, tip}, label? }]
 * Renders: rows of thumbnails for each view in `views`, then onion skins and a speed plot.
 */
export async function contactSheet(frames, file, { views = ['side', 'three4', 'front'], cols = 12, cell = 150, scale = 70, title = '' } = {}) {
  const rows = Math.ceil(frames.length / cols);
  const W = cols * cell;
  const onionH = 360;
  const plotH = 160;
  const H = 30 + views.length * rows * cell + onionH + plotH + 20;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f4f1ea"/>`;
  svg += `<text x="8" y="20" font-family="monospace" font-size="15">${title}</text>`;
  let y0 = 30;
  for (const view of views) {
    frames.forEach((f, i) => {
      const cx = (i % cols) * cell, cy = y0 + Math.floor(i / cols) * cell;
      // follow the character as root motion carries it
      const centerX = VIEWS[view](at(f, f.root ?? vec3.create()))[0] + (view === 'front' ? 0 : 0.3);
      // and up when it jumps (the ground line drops instead), clipped to the cell
      const lift = view === 'top' ? 0 : Math.max(0, f.pose.pos('pelvis')[1] - 0.95);
      const k = (scale * cell) / 150;
      const tx = ([x, y]) => [(cx + cell / 2 + (x - centerX) * k).toFixed(1), (cy + cell - 12 - ((view === 'top' ? y + 1 : y) - lift) * k).toFixed(1)];
      const ground = cy + cell - 12 + lift * k;
      svg += `<clipPath id="c${view}${i}"><rect x="${cx}" y="${cy}" width="${cell}" height="${cell}"/></clipPath><g clip-path="url(#c${view}${i})">`;
      svg += `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" fill="none" stroke="#ddd"/>`;
      svg += `<line x1="${cx}" y1="${ground}" x2="${cx + cell}" y2="${ground}" stroke="#bbb"/>`;
      svg += drawFigure(f, view, tx);
      svg += '</g>';
      svg += `<text x="${cx + 3}" y="${cy + 12}" font-family="monospace" font-size="10">${view} ${f.t.toFixed(2)}${f.label ? ' ' + f.label : ''}</text>`;
    });
    y0 += rows * cell;
  }
  // Onion skins: side + top, all frames overlaid, tip trail
  const half = W / 2;
  for (const [k, view] of [['0', 'side'], ['1', 'top']].map(([a, b]) => [Number(a), b])) {
    const ox = k * half;
    const sc = 120;
    const tx = ([x, y]) => [(ox + half * 0.2 + x * sc).toFixed(1), (y0 + onionH - 20 - (view === 'top' ? y + 1.1 : y) * sc).toFixed(1)];
    svg += `<rect x="${ox}" y="${y0}" width="${half}" height="${onionH}" fill="none" stroke="#999"/>`;
    svg += `<text x="${ox + 4}" y="${y0 + 14}" font-family="monospace" font-size="12">onion ${view} (tip path, dots = frames)</text>`;
    frames.forEach((f, i) => { if (i % 2 === 0) svg += drawFigure(f, view, tx, 0.18, true); });
    const pts = frames.filter((f) => f.spear).map((f) => tx(VIEWS[view](at(f, f.spear.tip))));
    svg += `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#c9a227" stroke-width="2"/>`;
    pts.forEach((p) => (svg += `<circle cx="${p[0]}" cy="${p[1]}" r="2" fill="#7a5a00"/>`));
    for (const n of ['hand_r', 'pelvis', 'Head']) {
      const hp = frames.map((f) => tx(VIEWS[view](at(f, f.pose.pos(n)))));
      svg += `<polyline points="${hp.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${n === 'pelvis' ? '#555' : n === 'Head' ? '#2a2' : '#d5493a'}" stroke-width="1.5" stroke-dasharray="3,2"/>`;
    }
  }
  y0 += onionH;
  // Speed plot: tip speed and pelvis speed (m/s)
  const speeds = (get) => frames.map((f, i) => (i === 0 || f.t <= frames[i - 1].t ? 0 : vec3.dist(get(f), get(frames[i - 1])) / (f.t - frames[i - 1].t)));
  const series = [
    ['pelvis x2', '#555', speeds((f) => at(f, f.pose.pos('pelvis'))).map((v) => v * 2)],
    ['hand_r', '#d5493a', speeds((f) => at(f, f.pose.pos('hand_r')))],
    ['tip', '#c9a227', speeds((f) => at(f, f.spear?.tip ?? f.pose.pos('hand_r')))],
  ];
  const vmax = Math.max(1, ...series.flatMap((s) => s[2]));
  const tmax = frames[frames.length - 1].t || 1;
  svg += `<text x="4" y="${y0 + 14}" font-family="monospace" font-size="12">speed (max ${vmax.toFixed(1)} m/s)  ${series.map((s) => s[0]).join(' / ')}</text>`;
  for (const [, col, vals] of series) {
    const pts = vals.map((v, i) => `${(frames[i].t / tmax * (W - 20) + 10).toFixed(1)},${(y0 + plotH - 5 - v / vmax * (plotH - 25)).toFixed(1)}`);
    svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`;
  }
  frames.forEach((f) => { if (f.label) svg += `<text x="${(f.t / tmax * (W - 20) + 10).toFixed(1)}" y="${y0 + plotH + 10}" font-family="monospace" font-size="9">${f.label}</text>`; });
  svg += '</svg>';
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

export { quat };
