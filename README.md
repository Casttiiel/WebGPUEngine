# WebGPU Engine

A modern 3D rendering engine built with WebGPU, designed for high-performance graphics and game development.

## Overview

This engine is built on top of WebGPU, the next-generation graphics API for the web, offering superior performance and modern graphics capabilities. It features a modular architecture with an Entity Component System (ECS) for efficient game object management.

## 🚀 Features

### Current Features
- Entity Component System (ECS)
- Modular Architecture
- Resource Management System
- Transform and Camera Components
- Deferred Rendering Pipeline
- Material System
- Custom Shader Support

### 🔄 In Development
- PBR Lighting System
  - Directional Lights with/without Shadows
  - Point Lights
  - Light Culling
- Advanced Post-Processing
  - HDR & Tone Mapping
  - Anti-aliasing
  - Blur Effects
  - Bloom
- Advanced Rendering Features
  - Skybox System
  - Ambient Occlusion
  - Decal System
  - Mesh LOD
  - Camera Culling
- Visual Effects
  - Lens Flare
  - Camera Lens Dirt
  - Volumetric Lighting/God Rays
  - Particle Systems
- Environment
  - Procedural Terrain (Perlin Noise)
  - Weighted Terrain System
  - Physics Integration
- Performance Optimizations
  - Instancing
  - Cascaded Shadow Maps

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/Casttiiel/WebGPUEngine.git

# Navigate to the project directory
cd WebGPUEngine

# Install dependencies
npm install

# Start the development server
npm run dev
```

## 🛠️ Project Structure

```
src/
├── components/     # ECS Components
├── core/          # Core Engine Systems
├── modules/       # Game Modules
├── renderer/      # Rendering System
└── types/         # TypeScript Types
```

## 🔧 Technical Requirements

- Modern web browser with WebGPU support
- Node.js and npm installed
- TypeScript support

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📜 License


## 🎮 Examples

(Coming soon)