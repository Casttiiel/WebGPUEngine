### Engine

1. Froxel Scattering
   Light injection (que las luces afecten la niebla) Point lights y spot lights inyectan color en los froxels Crear compute shader para procesar luces
   Scattering propagation (luz rebota entre froxels) Implementar el segundo compute pass que ya tienes preparado Hace que la luz se propague volumétricamente
2. Revisit shadows bias + normal offset
3. Gamestates
4. Loading Bar
5. Multiple Light probes has good shadows?
6. Improve particles
7. Weird line on corners is irradiance because of normals

## Gameplay

1. Dash
2. Momentum/Chain
3. Eco
4. Gameplay analysis
5. Door
6. Enemy
7. Run upward to wall -> wallrun (wrong)

### Testing

1. Swing Bar too restrictive?
2. On Wallrun remove velocity into wall removes mostly all horizontal speed
3. Run uphill fast makes not stick to ground

## Visuals and Sound

1. Sound
2. HeightMap
3. Skybox
4. Triplanar mapping
5. Check neon white for textures
