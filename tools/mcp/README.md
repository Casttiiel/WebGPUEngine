# MCP del motor (`webgpu-engine`)

Servidor MCP para que Claude pueda **arrancar, observar, controlar y verificar** el juego sin intervención manual.

El motor no es un editor en tiempo real. El contenido (código, escenas, prefabs, escenarios) vive en ficheros y se edita en VS Code. El juego en ejecución solo se usa para mirar y comprobar.

```
editar ficheros → run_checks / validate_data → launch / reload → get_logs / screenshot / get_entity
              → simulate_input / game_command / step → run_scenario (asserts) → repetir
```

## Arquitectura

- `tools/mcp/server.ts`: servidor MCP por stdio, registrado en [`.mcp.json`](../../.mcp.json).
- **Vite**: el servidor arranca su propio dev server en el puerto `5199` y lo para al cerrar.
- **Playwright** (`playwright-core`): abre **Edge** (o Chrome) del sistema, con WebGPU y la GPU real. La ventana es visible por defecto.
- **`window.__engine`** ([`src/core/debug/DevBridge.ts`](../../src/core/debug/DevBridge.ts)): API de depuración que solo existe en `dev`. El MCP la llama con `page.evaluate()`.
- **Parámetros de URL (solo en dev):**
  - `?scene=a.json,b.json` sustituye las escenas de `boot.json`.
  - `?scenario=nombre` carga un escenario.
  - `?seed=N` hace que `Math.random` sea determinista.

Comandos:

```bash
npm run mcp                 # arrancar el servidor a mano (normalmente lo lanza Claude Code)
npm run mcp:call -- '[["launch",{}],["screenshot",{}],["close",{}]]'   # probar herramientas desde la terminal
npm run mcp:check           # type-check del propio MCP
```

Variables de entorno opcionales:

| Variable                 | Valor por defecto  | Para qué                                                             |
| ------------------------ | ------------------ | -------------------------------------------------------------------- |
| `ENGINE_DEV_PORT`        | `5199`             | Puerto del dev server                                                |
| `ENGINE_BROWSER_CHANNEL` | `msedge` (Windows) | Navegador; también admite `chrome`                                   |
| `ENGINE_BROWSER_PATH`    | —                  | Ruta a un ejecutable concreto                                        |
| `ENGINE_HEADLESS`        | —                  | `1` para no mostrar ventana (WebGPU puede no funcionar)              |
| `MCP_DEBUG`              | —                  | `1` para incluir las stack traces de los errores de las herramientas |

## Herramientas

| Grupo         | Herramienta                                        | Qué hace                                                                                                                                    |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Ciclo de vida | `launch`, `reload`, `close`                        | Arranca o recarga y espera a `ready`. Detecta errores de compilación de Vite y fallos de arranque. `waitNavMesh` espera también al navmesh. |
| Observación   | `get_status`, `get_logs`, `screenshot`             | Estado, consola, errores no capturados, 404 y salida de Vite. Captura del canvas, con overlays opcionales.                                  |
| Calidad       | `run_checks`                                       | `tsc` + `eslint`. Por defecto solo muestra diagnósticos en **líneas cambiadas** respecto a HEAD, porque el repo arrastra errores previos.   |
| Datos         | `list_components`, `list_prefabs`, `validate_data` | Esquema de cada componente, extraído de su `load()` con el compilador de TS. Valida escenas, prefabs y escenarios sin ejecutar nada.        |
| Inspección    | `list_entities`, `get_entity`, `eval`              | Solo lectura. `eval` es para preguntas puntuales, no para crear contenido.                                                                  |
| Tiempo        | `pause`, `resume`, `step`, `set_time_scale`        | `step(n)` avanza n frames con delta fijo.                                                                                                   |
| Input         | `simulate_input`                                   | Ratón y teclado reales. Los objetivos pueden ser `{x,y}` del canvas, `{world:[x,y,z]}` o `{entity}`.                                        |
| Juego táctico | `get_combat_state`, `game_command`                 | Requieren un _combat provider_; ver más abajo.                                                                                              |
| Espacial      | `query_path`, `query_los`, `debug_draw`            | Navmesh (Detour), raycast de Rapier y overlays: `navmesh`, `paths`, `los`, `colliders`…                                                     |
| Tests         | `list_scenarios`, `run_scenario`                   | Escenarios en `public/data/scenarios/*.json`. `name: "*"` los ejecuta todos.                                                                |

## Escenarios de test

`public/data/scenarios/<nombre>.json`. El runner hace lo siguiente:

1. Carga la escena del escenario.
2. Fija la semilla (por defecto 1) y el delta (por defecto 1/60).
3. **Pausa** el juego y ejecuta los pasos frame a frame, para que el resultado sea reproducible.
4. Falla si hay errores de consola, salvo que el escenario tenga `failOnErrors: false`.

```jsonc
{
  "description": "4 personajes contra 2 dummies",
  "scenes": ["level-1.json"], // opcional: sustituye boot.json
  "entities": [
    {
      "prefab": "characters/dummy_enemy.prefab",
      "components": { "name": "Dummy2", "transform": { "position": [3, 0, 0] } },
    },
  ],
  "seed": 7,
  "steps": [
    { "wait_frames": 10 },
    { "wait_seconds": 1.5 }, // segundos simulados
    { "command": "move", "args": { "unit": "Hero1", "to": [2, 0, 3] } },
    { "command": "attack", "args": { "unit": "Hero1", "target": "Dummy2" }, "expect_error": true },
    {
      "input": [
        { "type": "click", "entity": "Dummy2" },
        { "type": "wait_frames", "frames": 2 },
      ],
    },
    { "debug_draw": { "navmesh": true } },
    { "screenshot": "after-move" }, // .mcp-out/scenarios/<nombre>/after-move.png
    { "assert": { "entity": "Dummy2", "path": "health.currentHp", "op": "<", "value": 100 } },
    { "assert": { "combat": true, "path": "activeUnit", "value": "Hero2" } },
    { "assert": { "status": true, "path": "gamestate", "value": "gs_gameplay" } },
    {
      "assert": {
        "expr": "__engine.listEntities({component:'health'}).total",
        "op": ">=",
        "value": 3,
      },
    },
    {
      "wait_until": { "combat": true, "path": "state", "value": "Victory" },
      "timeout_frames": 600,
    },
    { "assert": { "no_errors": true } },
  ],
}
```

Operadores: `==` `!=` `<` `<=` `>` `>=` `approx` (con `tolerance`) `includes` `exists` `not_exists` `truthy` `falsy`.

## Puntos de extensión para el código del juego

```ts
import { DevBridge } from '../core/debug/DevBridge';

// Fase 3 (turnos): hace funcionar get_combat_state, game_command y los asserts { combat: true }.
DevBridge.registerCombatProvider({
  getState: () => ({ state, round, turnOrder, activeUnit, units }),
  command: (name, args) => combat.execute(name, args), // la IA enemiga usa la misma API
});

// Overlays propios para debug_draw (p.ej. rangos de movimiento).
DevBridge.registerOverlay('ranges', () => {
  PhysicsDebugDrawer.getInstance().addLine(/* ... */);
});
```

Ambas llamadas son inofensivas fuera de `dev`: el bridge no se instala y nadie las consulta.

## Cosas a tener en cuenta

- El primer click sobre el canvas activa el **pointer lock** (`ModuleInput`). Después de eso, el movimiento del ratón llega como `movementX/Y`.
- El input enviado con el juego **en pausa** se procesa en el siguiente frame avanzado con `step`. En los escenarios conviene poner un `wait_frames` después de cada input.
- El navmesh se construye en un worker después de `ready`: usa `waitNavMesh` o un `wait_until` sobre `status.navMeshBuilt`.
- Las salidas (capturas) van a `.mcp-out/`, que está en `.gitignore`.
