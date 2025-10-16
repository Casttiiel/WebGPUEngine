import { vec3 } from 'gl-matrix';
import { Engine } from '../../core/engine/Engine';
import { Module } from '../core/Module';
import { CameraComponent } from '../../components/render/CameraComponent';

interface Sound {
  buffer: AudioBuffer;
  path: string;
}

interface AudioSource {
  source: AudioBufferSourceNode;
  panner: PannerNode;
  gain: GainNode;
  isPlaying: boolean;
}

export class ModuleSound extends Module {
  private audioContext!: AudioContext;
  private masterGain!: GainNode;
  private sounds: Map<string, Sound>;
  private activeSources: Set<AudioSource>;
  private maxSources: number = 32; // Límite práctico para rendimiento

  constructor(name: string) {
    super(name);
    this.sounds = new Map();
    this.activeSources = new Set();
    this.listenerPosition = vec3.create();
  }

  public async start(): Promise<boolean> {
    try {
      // Inicializar Web Audio API
      this.audioContext = new AudioContext();

      // Crear master gain para control global del volumen
      this.masterGain = this.audioContext.createGain();
      this.masterGain.connect(this.audioContext.destination);

      // Configurar listener por defecto
      const listener = this.audioContext.listener;
      listener.setPosition(0, 0, 0);
      listener.setOrientation(0, 0, -1, 0, 1, 0);

      return true;
    } catch (error) {
      console.error('Error initializing audio system:', error);
      return false;
    }
  }

  public stop(): void {
    // Detener todos los sonidos activos
    this.stopAll();

    // Cerrar contexto de audio
    if (this.audioContext) {
      this.audioContext.close();
    }
  }

  public update(deltaTime: number): void {
    // Actualizar posición del listener basado en la cámara principal
    this.updateListenerPosition();

    // Limpiar fuentes completadas
    this.cleanupFinishedSources();
  }

  public renderDebug(): void {}

  public async loadSound(path: string): Promise<void> {
    if (this.sounds.has(path)) return;

    try {
      const response = await fetch(`assets/sounds/${path}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      this.sounds.set(path, {
        buffer: audioBuffer,
        path: path,
      });
    } catch (error) {
      console.error(`Error loading sound ${path}:`, error);
    }
  }

  public play3D(
    path: string,
    position: vec3,
    options: {
      loop?: boolean;
      volume?: number;
      pitch?: number;
      refDistance?: number;
      maxDistance?: number;
    } = {},
  ): AudioSource | null {
    // Verificar límite de fuentes activas
    if (this.activeSources.size >= this.maxSources) {
      console.warn('Maximum number of audio sources reached');
      return null;
    }

    const sound = this.sounds.get(path);
    if (!sound) {
      console.warn(`Sound not loaded: ${path}`);
      return null;
    }

    // Crear nodos de audio
    const source = this.audioContext.createBufferSource();
    const panner = this.audioContext.createPanner();
    const gain = this.audioContext.createGain();

    // Configurar nodos
    source.buffer = sound.buffer;
    source.loop = options.loop || false;
    source.playbackRate.value = options.pitch || 1.0;

    panner.positionX.value = position[0];
    panner.positionY.value = position[1];
    panner.positionZ.value = position[2];
    panner.refDistance = options.refDistance || 1;
    panner.maxDistance = options.maxDistance || 10000;
    panner.distanceModel = 'inverse';
    panner.rolloffFactor = 1;

    gain.gain.value = options.volume || 1.0;

    // Conectar nodos
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.masterGain);

    // Crear y registrar fuente de audio
    const audioSource: AudioSource = {
      source,
      panner,
      gain,
      isPlaying: true,
    };

    this.activeSources.add(audioSource);

    // Configurar limpieza cuando termine
    source.onended = () => {
      audioSource.isPlaying = false;
    };

    // Reproducir
    source.start(0);

    return audioSource;
  }

  public play(
    path: string,
    options: {
      loop?: boolean;
      volume?: number;
      pitch?: number;
    } = {},
  ): AudioSource | null {
    if (this.activeSources.size >= this.maxSources) {
      return null;
    }

    const sound = this.sounds.get(path);
    if (!sound) return null;

    const source = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();

    source.buffer = sound.buffer;
    source.loop = options.loop || false;
    source.playbackRate.value = options.pitch || 1.0;
    gain.gain.value = options.volume || 1.0;

    source.connect(gain);
    gain.connect(this.masterGain);

    const audioSource: AudioSource = {
      source,
      gain,
      panner: null,
      isPlaying: true,
    };

    this.activeSources.add(audioSource);

    source.onended = () => {
      audioSource.isPlaying = false;
    };

    source.start(0);
    return audioSource;
  }

  public stopAudio(source: AudioSource): void {
    if (!source.isPlaying) return;

    source.source.stop();
    source.isPlaying = false;
    this.activeSources.delete(source);
  }

  public stopAllAudio(): void {
    for (const source of this.activeSources) {
      this.stop(source);
    }
  }

  public toggleAudio(paused: boolean): void {
    if (paused) {
      this.audioContext.suspend();
    } else {
      this.audioContext.resume();
    }
  }

  private updateListenerPosition(): void {
    // TODO: Obtener posición de la cámara principal
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();
    if (camera) {
      const position = camera.getPosition();
      const front = camera.getFront();
      const up = camera.getUp();

      const listener = this.audioContext.listener;
      listener.setPosition(position[0], position[1], position[2]);
      listener.setOrientation(
        front[0],
        front[1],
        front[2], // Forward
        up[0],
        up[1],
        up[2], // Up
      );
    }
  }

  private cleanupFinishedSources(): void {
    for (const source of this.activeSources) {
      if (!source.isPlaying) {
        this.activeSources.delete(source);
      }
    }
  }
}
