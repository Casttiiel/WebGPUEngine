### Alpha Roadmap

1. Flow gains (if repeated action no gain flow)
   Roll to ground, roll + jump, wall jump, Dash give 1 flow
2. Flow reduce
   Hit ground no roll
3. Flow reset
   Hit wall
   Stop
4. Load variables update
5. Speed lines not showing
6. Revisit everything
7. Roll velocity transformation
8. Level Design
   ----Dash to Wall
   ----Dash distance
9. Eco Powerup

Si no limito la velocidad en el aire, el jugador saltara todo el tiempo, si al aterrizar no limito la velocidad, gana flow solo saltando no?

### Feedback

1. Jump floaty?
2. WallRun angle needs to be amplified?
3. Test floaty jump when dashing (no jump cut factor applied)
4. Qué velocidad deberia usar tras dash? SI uso el del dash, pues no necesito el Eco?
5. Deactivate dash on close range?
6. En roll y en swing, mirar en la direccion que toca y bloquear durante la duracion?
7. Test mantle on small slope/places

### Engine

1. UI
2. Start Screen
3. Game Loading Screen
4. Remove en main.ts el skip first frame?
5. Quality settings selection
6. Multiple Light probes has good shadows?
7. Froxel Scattering
   Light injection Directional Light
   Light Injection Point Light
   Light Injection Spot Light
   Scattering propagation (luz rebota entre froxels) Implementar el segundo compute pass que ya tienes preparado Hace que la luz se propague volumétricamente
8. Improve particles
9. Weird line on corners is irradiance because of normals
10. TAA?

## Gameplay

1. Door
2. Enemy

## Visuals and Sound

1. Sound
2. HeightMap
3. Skybox
4. Triplanar mapping
5. Check neon white for textures

## Questions

Visuals
Controls
-Jump too floaty?
-Air control?
Camera
