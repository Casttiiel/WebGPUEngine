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

📋 FASE 1: Gizmos y Manipulación (2-3 semanas)
Interacción con el gizmo - Permitir arrastrar el objeto cuando haces clic en un eje
Grid y Snapping
Hover detection funciona con distancia respecto al centro?
Modos ROTATE y SCALE - Implementar los otros dos gizmos (actualmente hay un TODO)
Transform update if parent is dirty only better?

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

📋 FASE 2: Editor UI Completo (2-3 semanas)
6.1 - Layout de Paneles
6.2 - Render parameters to be changed
HTML/CSS separado:

6.2 - Scene Hierarchy Tree
🎯 Implementación Práctica
Modificaciones Mínimas al Motor
Engine.ts - Agregar parámetro de modo:
index.html - Detección de modo:
