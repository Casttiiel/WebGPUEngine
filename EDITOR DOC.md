# 🎯 Roadmap: De Runtime-Only a Motor con Tooling

## ⚡ Estado del Proyecto

| Fase       | Estado            | Duración    | Archivos Creados         |
| ---------- | ----------------- | ----------- | ------------------------ |
| **Fase 1** | ✅ **COMPLETADO** | 4 horas     | 8 archivos (~538 líneas) |
| Fase 2     | 🔜 Pendiente      | 2-3 semanas | -                        |
| Fase 3     | 🔜 Pendiente      | 2 semanas   | -                        |
| Fase 4     | 🔜 Pendiente      | 1 semana    | -                        |
| Fase 5     | 🔜 Pendiente      | 2 semanas   | -                        |
| Fase 6     | 🔜 Pendiente      | 2-3 semanas | -                        |

**Documentación:**

- ✅ [FASE1-SUMMARY.md](./FASE1-SUMMARY.md) - Resumen técnico completo
- ✅ [FASE1-GUIDE.md](./FASE1-GUIDE.md) - Guía de uso y API
- ✅ [QUICK-START-EDITOR.md](./QUICK-START-EDITOR.md) - Testing rápido

---

## Principio Arquitectónico

📋 FASE 1: Fundación del Editor (1-2 semanas)
1.1 - EditorState (GameState especial)
Implementación:
Crear ModuleEditor como módulo de juego
Modificar gamestates.json para incluir estado "editor"
En Engine.start(), decidir según parámetro: ?mode=editor
1.2 - SelectionSystem (Componente ECS)
Clave: La selección es un componente normal. Las entidades del juego también pueden tenerlo.

📋 FASE 2: Gizmos y Manipulación (2-3 semanas)
2.1 - Gizmo como Entidad ECS
Ventajas:
Las flechas son RenderComponent normales
Se dibujan con el mismo pipeline que todo
Pueden tener física (raycasting) usando ModulePhysics
2.2 - Grid y Snapping

📋 FASE 3: Asset Browser y Spawn (2 semanas)
3.1 - AssetDatabase (Extensión de ResourceManager)
3.2 - UI de Asset Browser (HTML + CSS)
Drag & Drop:
Usuario arrastra cube.prefab
Raycast hacia el mundo
Ejecuta new SpawnEntityCommand(prefabPath, hitPosition)

📋 FASE 4: Scene Serialization (1 semana)
4.1 - Scene Exporter
4.2 - Component Serialization

📋 FASE 5: Propiedades e Inspector (2 semanas)
5.1 - Property System
5.2 - Inspector Panel

📋 FASE 6: Editor UI Completo (2-3 semanas)
6.1 - Layout de Paneles
HTML/CSS separado:

6.2 - Scene Hierarchy Tree
🎯 Implementación Práctica
Modificaciones Mínimas al Motor
Engine.ts - Agregar parámetro de modo:
index.html - Detección de modo:

1.3 - Command Pattern (Undo/Redo)
