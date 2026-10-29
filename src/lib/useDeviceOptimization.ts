import { useState, useEffect } from 'react';
import { devicePerformance, DeviceCapabilities, PerformanceConfig } from './devicePerformance';

const readState = () => ({
  capabilities: devicePerformance.detectCapabilities(),
  config: devicePerformance.getPerformanceConfig(),
});

/**
 * React Hook for device-specific optimizations
 *
 * Every caller shares one detector. isLowEnd covers weak hardware, Save-Data and a measured frame-rate drop,
 * so components should gate decorative effects on it rather than on phone / iOS checks.
 */
export function useDeviceOptimization() {
  const [{ capabilities, config }, setState] = useState<{ capabilities: DeviceCapabilities; config: PerformanceConfig }>(readState);

  useEffect(() => {
    const update = () => setState(readState());
    const unsubscribe = devicePerformance.subscribe(update);
    devicePerformance.start();
    update();
    return unsubscribe;
  }, []);

  return {
    capabilities,
    config,
    isInitialized: true,
    isLowEnd: capabilities.isLowEndDevice,
    isMobile: capabilities.isMobile,
    isTablet: capabilities.isTablet,
    isIOS: capabilities.isIOS,
    deviceType: capabilities.deviceType,
    tier: capabilities.tier,
    deviceName: devicePerformance.getDeviceTierName(),
    shouldReduceAnimations: capabilities.isLowEndDevice
  };
}

/**
 * Hook for conditional rendering based on device performance
 */
export function useConditionalRender() {
  const { config, isInitialized } = useDeviceOptimization();

  return {
    shouldRenderAnimations: config.enableAnimations,
    shouldRenderParticles: config.enableParticles,
    shouldRenderBlur: config.enableBlur,
    shouldRenderShadows: config.enableShadows,
    shouldRenderGradients: config.enableGradients,
    isReady: isInitialized
  };
}

/**
 * Hook for list virtualization thresholds
 */
export function useListOptimization() {
  const { config } = useDeviceOptimization();

  return {
    maxItems: config.maxListItems,
    lazyLoadThreshold: config.lazyLoadThreshold,
    debounceDelay: config.debounceDelay
  };
}

/**
 * Hook for image optimization
 */
export function useImageOptimization() {
  const { config } = useDeviceOptimization();

  const getImageQuality = () => {
    switch (config.imageQuality) {
      case 'high':
        return 0.95;
      case 'medium':
        return 0.85;
      case 'low':
      default:
        return 0.70;
    }
  };

  const getImageMaxWidth = () => {
    switch (config.imageQuality) {
      case 'high':
        return 1920;
      case 'medium':
        return 1280;
      case 'low':
      default:
        return 800;
    }
  };

  return {
    quality: getImageQuality(),
    maxWidth: getImageMaxWidth(),
    shouldLazyLoad: true
  };
}
