/**
 * Ejemplo de uso del sistema de Bloom con Quality Settings
 *
 * Este archivo muestra diferentes formas de configurar y usar el bloom
 * integrado con el sistema de QualitySettings del motor.
 */

import { Engine } from '../core/engine/Engine';
import { QualitySettings } from '../core/engine/QualitySettings';
import { ModuleRender } from '../modules/game/ModuleRender';
import { BloomComponent } from '../components/render/BloomComponent';

export class BloomExamples {
  /**
   * Ejemplo 1: Configuración básica usando presets de calidad
   */
  public static setupBasicBloom(): void {
    const qualitySettings = QualitySettings.getInstance();

    // Aplicar preset de calidad que incluye configuración automática de bloom
    qualitySettings.applyPreset('MEDIUM'); // Automáticamente configura bloom en 'medium'

    console.log('Bloom configurado automáticamente con preset MEDIUM');
  }

  /**
   * Ejemplo 2: Cambio dinámico de calidad de bloom
   */
  public static setupDynamicBloomQuality(): void {
    const moduleRender = Engine.getModules().getModule('render') as ModuleRender;

    // Configuraciones para diferentes situaciones

    // Escena con muchos efectos - reducir bloom para mantener rendimiento
    moduleRender.setBloomQuality('low');

    // Escena cinematográfica - máxima calidad visual
    moduleRender.setBloomQuality('high');

    // Modo rendimiento - desactivar bloom completamente
    moduleRender.setBloomQuality('off');

    // Obtener configuración actual
    const currentConfig = moduleRender.getCurrentBloomConfig();
    console.log('Configuración actual de bloom:', currentConfig);
  }

  /**
   * Ejemplo 3: Adaptación automática basada en rendimiento
   */
  public static setupAdaptiveBloomQuality(): (deltaTime: number) => void {
    const moduleRender = Engine.getModules().getModule('render') as ModuleRender;
    let frameTimeHistory: number[] = [];
    const targetFPS = 60;

    // Función que se llamaría en el loop principal
    const updateAdaptiveQuality = (deltaTime: number) => {
      frameTimeHistory.push(deltaTime);
      if (frameTimeHistory.length > 60) frameTimeHistory.shift();

      const avgFrameTime = frameTimeHistory.reduce((a, b) => a + b) / frameTimeHistory.length;
      const currentFPS = 1 / avgFrameTime;

      const currentQuality = moduleRender.getBloomQuality();

      // Si el FPS baja del objetivo, reducir calidad de bloom
      if (currentFPS < targetFPS * 0.85) {
        if (currentQuality === 'high') {
          moduleRender.setBloomQuality('medium');
          console.log('Bloom quality reduced to medium (performance)');
        } else if (currentQuality === 'medium') {
          moduleRender.setBloomQuality('low');
          console.log('Bloom quality reduced to low (performance)');
        } else if (currentQuality === 'low') {
          moduleRender.setBloomQuality('off');
          console.log('Bloom disabled (performance)');
        }
      }
      // Si el FPS es estable, intentar mejorar calidad gradualmente
      else if (currentFPS > targetFPS * 1.1 && frameTimeHistory.length >= 60) {
        if (currentQuality === 'off') {
          moduleRender.setBloomQuality('low');
          console.log('Bloom enabled at low quality');
        } else if (currentQuality === 'low') {
          moduleRender.setBloomQuality('medium');
          console.log('Bloom quality increased to medium');
        } else if (currentQuality === 'medium') {
          moduleRender.setBloomQuality('high');
          console.log('Bloom quality increased to high');
        }
      }
    };

    // Retornar la función para que pueda ser llamada en el game loop
    return updateAdaptiveQuality;
  }

  /**
   * Ejemplo 4: Configuración por tipo de escena
   */
  public static setupSceneBasedBloom(sceneType: 'indoor' | 'outdoor' | 'space' | 'menu'): void {
    const moduleRender = Engine.getModules().getModule('render') as ModuleRender;

    switch (sceneType) {
      case 'indoor':
        // Interiores: bloom sutil para luces artificiales
        moduleRender.setBloomQuality('medium');
        break;

      case 'outdoor':
        // Exteriores: bloom intenso para sol y cielo
        moduleRender.setBloomQuality('high');
        break;

      case 'space':
        // Espacio: bloom máximo para estrellas y nebulosas
        moduleRender.setBloomQuality('high');
        break;

      case 'menu':
        // Menús: sin bloom para UI limpia
        moduleRender.setBloomQuality('off');
        break;
    }

    console.log(`Bloom configurado para escena tipo: ${sceneType}`);
  }

  /**
   * Ejemplo 5: Configuración manual avanzada (solo cuando sea necesario)
   */
  public static setupCustomBloomParameters(): void {
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');

    if (mainCamera?.hasComponent('bloom')) {
      const bloomComponent = mainCamera.getComponent('bloom') as BloomComponent;

      // Configuración personalizada que sobrescribe quality settings
      // (Use con cuidado - rompe la consistencia del sistema de calidad)

      bloomComponent.setMaxBlurSteps(5); // Blur amplio
      bloomComponent.setBlurStrength(1.8); // Blur suave
      bloomComponent.setBlendIntensity(1.1); // Blending intenso
      bloomComponent.setBloomIntensity(1.3); // Bloom visible
      bloomComponent.setBloomThreshold(0.9); // Sensible a luces
      bloomComponent.setBloomRadius(1.7); // Radio amplio
      bloomComponent.setBloomKnee(0.6); // Transición suave

      console.log('Bloom configurado manualmente con parámetros personalizados');
      console.warn(
        'Advertencia: La configuración manual puede ser sobrescrita por QualitySettings',
      );
    }
  }

  /**
   * Ejemplo 6: Monitoreo y debug de bloom
   */
  public static setupBloomDebugging(): void {
    const moduleRender = Engine.getModules().getModule('render') as ModuleRender;
    const qualitySettings = QualitySettings.getInstance();

    // Función de debug que puede llamarse en el renderInMenu o console
    const debugBloomInfo = () => {
      const bloomQuality = moduleRender.getBloomQuality();
      const bloomConfig = moduleRender.getCurrentBloomConfig();
      const globalSettings = qualitySettings.getSettings();

      console.group('🌟 Bloom Debug Info');
      console.log('Quality Setting:', bloomQuality);
      console.log('Enabled:', bloomConfig.enabled);
      console.log('Max Blur Steps:', bloomConfig.maxBlurSteps);
      console.log('Blur Strength:', bloomConfig.blurStrength);
      console.log('Blend Intensity:', bloomConfig.blendIntensity);
      console.log('Bloom Intensity:', bloomConfig.bloomIntensity);
      console.log('Bloom Threshold:', bloomConfig.bloomThreshold);
      console.log('Bloom Radius:', bloomConfig.bloomRadius);
      console.log('Bloom Knee:', bloomConfig.bloomKnee);
      console.log('Global Quality Preset:', globalSettings);
      console.groupEnd();
    };

    return debugBloomInfo;
  }

  /**
   * Ejemplo 7: Configuración para diferentes plataformas
   */
  public static setupPlatformOptimizedBloom(): void {
    const moduleRender = Engine.getModules().getModule('render') as ModuleRender;

    // Detección básica de plataforma (en una implementación real usarías APIs más sofisticadas)
    const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    );
    const isLowEndDevice = navigator.hardwareConcurrency <= 4; // Ejemplo simplificado

    if (isMobile) {
      // Móviles: priorizar rendimiento
      moduleRender.setBloomQuality('low');
      console.log('Bloom optimizado para móviles');
    } else if (isLowEndDevice) {
      // PCs de gama baja: bloom mínimo
      moduleRender.setBloomQuality('medium');
      console.log('Bloom optimizado para hardware de gama baja');
    } else {
      // PCs potentes: máxima calidad
      moduleRender.setBloomQuality('high');
      console.log('Bloom configurado para máxima calidad');
    }
  }

  /**
   * Ejemplo 8: Integración con eventos de cambio de calidad
   */
  public static setupQualityChangeListener(): void {
    // Escuchar eventos de cambio de configuración de calidad
    if (typeof window !== 'undefined') {
      window.addEventListener('qualitySettingsChanged', (event) => {
        const customEvent = event as CustomEvent;
        const { settings } = customEvent.detail;

        console.log('Quality settings changed:', settings);
        console.log('New bloom quality:', settings.bloomQuality);

        // Opcional: realizar acciones adicionales cuando cambie la calidad
        if (settings.bloomQuality === 'off') {
          console.log('Bloom has been disabled - consider adjusting lighting');
        } else {
          console.log(`Bloom quality set to: ${settings.bloomQuality}`);
        }
      });
    }
  }
}

// Ejemplo de uso típico:
// BloomExamples.setupBasicBloom();
// BloomExamples.setupSceneBasedBloom('outdoor');
// const adaptiveUpdate = BloomExamples.setupAdaptiveBloomQuality();
// En el game loop: adaptiveUpdate(deltaTime);
