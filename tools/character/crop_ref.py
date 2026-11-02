"""Crop/zoom regions of the reference sheet (coords in the 800x1293 preview space).
  blender -b --python crop_ref.py -- <ref> <out_dir> name:x0,y0,x1,y1[:scale] ..."""
import bpy, sys, os
import numpy as np
argv = sys.argv[sys.argv.index('--') + 1:]
img = bpy.data.images.load(argv[0])
W, H = img.size
a = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)[::-1]   # top row first
sx, sy = W / 800, H / 1293
for spec in argv[2:]:
    name, box, *sc = spec.split(':')
    x0, y0, x1, y1 = [float(v) for v in box.split(',')]
    s = float(sc[0]) if sc else 2.0
    c = a[int(y0 * sy):int(y1 * sy), int(x0 * sx):int(x1 * sx)]
    h, w = int(c.shape[0] * s / (sx)), int(c.shape[1] * s / (sx))
    yi = (np.arange(h) * c.shape[0] / h).astype(int)
    xi = (np.arange(w) * c.shape[1] / w).astype(int)
    c = c[yi][:, xi][::-1].copy()
    out = bpy.data.images.new(name, w, h, alpha=True)
    out.pixels = c.ravel()
    out.filepath_raw = os.path.join(argv[1], name + '.png')
    out.file_format = 'PNG'
    out.save()
    print('saved', name, w, h)
