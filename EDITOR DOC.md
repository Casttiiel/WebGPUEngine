# 🎯 Roadmap: De Runtime-Only a Motor con Tooling

---

## Principio Arquitectónico

📋 FASE 1: Gizmos y Manipulación (2-3 semanas)
Modos ROTATE y SCALE - Implementar los otros dos gizmos (actualmente hay un TODO)
Transform update if parent is dirty only better?

📋 FASE 2: Asset Browser y Spawn (2 semanas)
3.1 - AssetDatabase (Extensión de ResourceManager)
3.2 - UI de Asset Browser (HTML + CSS)
Drag & Drop:
Usuario arrastra cube.prefab
Raycast hacia el mundo
Ejecuta new SpawnEntityCommand(prefabPath, hitPosition)

📋 FASE 3: Scene Serialization (1 semana)
4.1 - Scene Exporter
4.2 - Component Serialization
