"""Turnaround render (Workbench) of everything in the scene -> one PNG strip."""
import bpy, math, os
import numpy as np
from mathutils import Vector


def render_views(out_path, views=('front', 'side', 'back', 'threeq'), res=640, center=Vector((0, 0, 0.93)),
                 ortho=2.05, hide=(), color='MATERIAL'):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light = 'STUDIO'
    sh.color_type = color
    sh.show_cavity = True
    sh.cavity_type = 'BOTH'
    sh.show_shadows = False
    sh.show_specular_highlight = True
    sc.render.resolution_x = res
    sc.render.resolution_y = int(res * 1.15)
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    for o in bpy.data.objects:
        if o.name in hide:
            o.hide_render = True
    cam_data = bpy.data.cameras.new("prevcam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = ortho
    cam = bpy.data.objects.new("prevcam", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    dirs = {
        'front': Vector((0, -1, 0)), 'back': Vector((0, 1, 0)), 'side': Vector((1, 0, 0)),
        'threeq': Vector((0.7, -0.7, 0.25)), 'top': Vector((0, -0.2, 1)),
        'threeq_back': Vector((-0.7, 0.7, 0.2)),
    }
    tiles = []
    tmp = os.path.splitext(out_path)[0]
    for v in views:
        d = dirs[v].normalized()
        cam.location = center + d * 6
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        p = f"{tmp}_{v}.png"
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(p)
        a = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
        tiles.append(a)
        bpy.data.images.remove(img)
        os.remove(p)
    strip = np.concatenate(tiles, axis=1)
    out = bpy.data.images.new("strip", strip.shape[1], strip.shape[0], alpha=True)
    out.pixels = strip.ravel()
    out.filepath_raw = out_path
    out.file_format = 'PNG'
    out.save()
    bpy.data.objects.remove(cam)
