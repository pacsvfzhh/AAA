import { useState, useEffect } from 'react';
import { devicePerformance, DeviceCapabilities, PerformanceConfig } from './devicePerformance';

/**
 * React Hook for device-specific optimizations
 *
 * Automatically detects device capabilities and provides optimized settings
 */
export function useDeviceOptimization() {
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);
  const [config, setConfig] = useState<PerformanceConfig | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    const detectAndApply = () => {
      devicePerformance.resetCapabilities();
      const detectedCapabilities = devicePerformance.detectCapabilities();
      const performanceConfig = devicePerformance.getPerformanceConfig();

      setCapabilities(detectedCapabilities);
      setConfig(performanceConfig);
      setIsInitialized(true);

      devicePerformance.applyCSSOptimizations();
    };

    detectAndApply();

    // Mobile toolbars collapsing while scrolling fire height-only resizes; the device class can only change with width.
    let lastWidth = window.innerWidth;
    const handleResize = () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      detectAndApply();
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  return {
    capabilities,
    config,
    isInitialized,
    isLowEnd: capabilities?.isLowEndDevice || false,
    isMobile: capabilities?.isMobile || false,
    isTablet: capabilities?.isTablet || false,
    deviceType: capabilities?.deviceType || 'desktop',
    tier: capabilities?.tier || 'mid',
    deviceName: devicePerformance.getDeviceTierName(),
    shouldReduceAnimations: (capabilities?.deviceType === 'phone' && capabilities?.tier === 'low') || false
  };
}

/**
 * Hook for conditional rendering based on device performance
 */
export function useConditionalRender() {
  const { config, isInitialized } = useDeviceOptimization();

  return {
    shouldRenderAnimations: config?.enableAnimations ?? true,
    shouldRenderParticles: config?.enableParticles ?? false,
    shouldRenderBlur: config?.enableBlur ?? false,
    shouldRenderShadows: config?.enableShadows ?? true,
    shouldRenderGradients: config?.enableGradients ?? true,
    isReady: isInitialized
  };
}

/**
 * Hook for list virtualization thresholds
 */
export function useListOptimization() {
  const { config } = useDeviceOptimization();

  return {
    maxItems: config?.maxListItems ?? 50,
    lazyLoadThreshold: config?.lazyLoadThreshold ?? 500,
    debounceDelay: config?.debounceDelay ?? 200
  };
}

/**
 * Hook for image optimization
 */
export function useImageOptimization() {
  const { config } = useDeviceOptimization();

  const getImageQuality = () => {
    switch (config?.imageQuality) {
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
    switch (config?.imageQuality) {
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
