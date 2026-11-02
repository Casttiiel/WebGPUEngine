import bpy, sys, json
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=sys.argv[-1])
arm = next(o for o in bpy.data.objects if o.type=='ARMATURE')
body = next(o for o in bpy.data.objects if o.type=='MESH' and o.name.startswith('Mannequin'))
print("body", body.name, body.parent and body.parent.name, len(body.data.vertices), [m.type for m in body.modifiers])
vg = {g.index:g.name for g in body.vertex_groups}
mw = body.matrix_world
groups = {}
for v in body.data.vertices:
    if not v.groups: continue
    g = max(v.groups, key=lambda g:g.weight)
    groups.setdefault(vg[g.group], []).append(mw @ v.co)
res = {}
for name, pts in groups.items():
    b = arm.data.bones[name]
    m = (arm.matrix_world @ b.matrix_local)  # bone frame: Y along bone
    inv = m.inverted()
    loc = [inv @ p for p in pts]
    ex = lambda i: (round(min(p[i] for p in loc),3), round(max(p[i] for p in loc),3))
    res[name] = dict(n=len(pts), x=ex(0), y=ex(1), z=ex(2), len=round(b.length,3))
    print(name, res[name])
# world bbox per region
json.dump(res, open("measure.json","w"), indent=0)
