"""Bake armor.blend into one skinned mesh and dump raw vertex streams.

  blender -b <out_dir>/armor.blend --python export.py -- <out_dir>

Applies modifiers, resolves the bone tags into vertex groups (rigid / transferred
from the body / the body's own), joins everything into 'armor', unwraps one UV
atlas, saves armor_final.blend (baking input) and writes:
  mesh.bin   float32 pos3 nrm3 uv2 tan4 weights4 + uint16 joints4 (72 B), then uint32 indices
  mesh.json  counts + joint names (glTF axes: x, z, -y)
"""
import bpy, bmesh, sys, os, json, struct

OUT = sys.argv[sys.argv.index('--') + 1]
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
body = bpy.data.objects['undersuit']
bones = [b.name for b in arm.data.bones]

# Clean rest-pose copy of the body to transfer weights from
src = body.copy()
src.data = body.data.copy()
src.modifiers.clear()
src.name = 'weight_source'
bpy.context.scene.collection.objects.link(src)

deps = bpy.context.evaluated_depsgraph_get()
pieces = []
for ob in list(bpy.data.objects):
    if ob.type != 'MESH' or ob in (src,) or 'bone' not in ob:
        continue
    tag = ob['bone']
    # bake modifiers (solidify/bevel/displace) but not the armature
    for m in ob.modifiers:
        if m.type == 'ARMATURE':
            ob.modifiers.remove(m)
            break
    deps = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(deps), preserve_all_data_layers=True, depsgraph=deps)
    ob.modifiers.clear()
    ob.data = me
    ob.parent = None
    ob.matrix_world = ob.matrix_world.copy()
    if tag == '@body':
        pass
    elif tag == '@transfer':
        ob.vertex_groups.clear()
        for b in bones:  # NAME matching needs the destination groups to exist
            ob.vertex_groups.new(name=b)
        m = ob.modifiers.new('xfer', 'DATA_TRANSFER')
        m.object = src
        m.use_vert_data = True
        m.data_types_verts = {'VGROUP_WEIGHTS'}
        m.vert_mapping = 'POLYINTERP_NEAREST'
        m.layers_vgroup_select_src = 'ALL'
        m.layers_vgroup_select_dst = 'NAME'
        with bpy.context.temp_override(object=ob, active_object=ob):
            bpy.ops.object.modifier_apply(modifier='xfer')
    else:
        ob.vertex_groups.clear()
        g = ob.vertex_groups.new(name=tag)
        g.add(range(len(ob.data.vertices)), 1.0, 'REPLACE')
    pieces.append(ob)

# Same group set on every piece so the join lines the names up
for ob in pieces:
    for b in bones:
        if b not in ob.vertex_groups:
            ob.vertex_groups.new(name=b)

bpy.ops.object.select_all(action='DESELECT')
for ob in pieces:
    ob.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
armor = body
armor.name = 'armor'
bpy.data.objects.remove(src)

# Keep at most 4 influences, normalized
bpy.context.view_layer.objects.active = armor
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)

# One UV atlas for the whole suit
me = armor.data
while me.uv_layers:
    me.uv_layers.remove(me.uv_layers[0])
me.uv_layers.new(name='UVMap')
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'armor_final.blend'))

# ── Dump streams ───────────────────────────────────────────────────────────
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
bm.to_mesh(me)
bm.free()
me.calc_tangents(uvmap='UVMap')

gidx = {g.index: g.name for g in armor.vertex_groups}
vweights = []
for v in me.vertices:
    gs = sorted(((g.weight, gidx[g.group]) for g in v.groups if g.weight > 1e-4), reverse=True)[:4]
    tot = sum(w for w, _ in gs) or 1.0
    vweights.append([(bones.index(n), w / tot) for w, n in gs] or [(bones.index('root'), 1.0)])

uv = me.uv_layers.active.data
verts = {}
stream = bytearray()
indices = []
g = lambda c: (c[0], c[2], -c[1])   # Blender Z-up -> glTF Y-up
for tri in me.polygons:
    for li in tri.loop_indices:
        l = me.loops[li]
        n = l.normal
        t = l.tangent
        key = (l.vertex_index, round(n.x, 4), round(n.y, 4), round(n.z, 4),
               round(uv[li].uv.x, 5), round(uv[li].uv.y, 5), l.bitangent_sign)
        idx = verts.get(key)
        if idx is None:
            idx = len(verts)
            verts[key] = idx
            p = me.vertices[l.vertex_index].co
            jw = vweights[l.vertex_index] + [(0, 0.0)] * (4 - len(vweights[l.vertex_index]))
            stream += struct.pack('<3f3f2f4f4f4H', *g(p), *g(n), uv[li].uv.x, 1.0 - uv[li].uv.y,
                                  *g(t), l.bitangent_sign, *[w for _, w in jw], *[j for j, _ in jw])
        indices.append(idx)

with open(os.path.join(OUT, 'mesh.bin'), 'wb') as f:
    f.write(stream)
    f.write(struct.pack(f'<{len(indices)}I', *indices))
json.dump({'vertexCount': len(verts), 'indexCount': len(indices), 'stride': 4 * 16 + 8,
           'bones': bones}, open(os.path.join(OUT, 'mesh.json'), 'w'))
print('EXPORT', len(verts), 'verts', len(indices) // 3, 'tris')
