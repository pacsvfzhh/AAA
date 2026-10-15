/**
 * Device Performance Detection and Optimization
 *
 * Automatically detects device capabilities and applies appropriate optimizations
 * for low-end, mid-range, and high-end mobile devices.
 */

export interface DeviceCapabilities {
  tier: 'low' | 'mid' | 'high';
  hardwareConcurrency: number;
  deviceMemory: number | undefined;
  connectionSpeed: 'slow' | 'medium' | 'fast';
  maxTextureSize: number | undefined;
  isMobile: boolean;
  isTablet: boolean;
  deviceType: 'phone' | 'tablet' | 'desktop';
  isLowEndDevice: boolean;
}

interface NetworkInformationLike {
  effectiveType?: string;
}

interface ExtendedNavigator extends Navigator {
  deviceMemory?: number;
  connection?: NetworkInformationLike;
  mozConnection?: NetworkInformationLike;
  webkitConnection?: NetworkInformationLike;
}

export interface PerformanceConfig {
  enableAnimations: boolean;
  enableParticles: boolean;
  enableBlur: boolean;
  enableShadows: boolean;
  enableGradients: boolean;
  maxListItems: number;
  imageQuality: 'low' | 'medium' | 'high';
  debounceDelay: number;
  lazyLoadThreshold: number;
}

class DevicePerformanceDetector {
  private capabilities: DeviceCapabilities | null = null;
  private performanceConfig: PerformanceConfig | null = null;
  private maxTextureSize: number | undefined | null = null;

  /**
   * Reset cached capabilities (useful for debugging or screen resize)
   */
  resetCapabilities(): void {
    this.capabilities = null;
    this.performanceConfig = null;
  }

  /**
   * Detect device capabilities
   */
  detectCapabilities(): DeviceCapabilities {
    if (this.capabilities) {
      return this.capabilities;
    }

    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const maxDimension = Math.max(screenWidth, screenHeight);
    const minDimension = Math.min(screenWidth, screenHeight);

    console.log('[Performance] Screen dimensions:', {
      width: screenWidth,
      height: screenHeight,
      minDimension,
      maxDimension,
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints
    });

    const isTablet = this.detectTablet();
    const isMobile = this.detectMobile();
    const deviceType = this.detectDeviceType();
    const hardwareConcurrency = navigator.hardwareConcurrency || 2;

    const deviceMemory = (navigator as ExtendedNavigator).deviceMemory;

    const connectionSpeed = this.detectConnectionSpeed();
    const maxTextureSize = this.detectMaxTextureSize();

    // Calculate device tier based on multiple factors
    let score = 0;

    // CPU cores score (max 30 points)
    if (hardwareConcurrency >= 8) score += 30;
    else if (hardwareConcurrency >= 6) score += 25;
    else if (hardwareConcurrency >= 4) score += 20;
    else if (hardwareConcurrency >= 2) score += 10;
    else score += 5;

    // Memory score (max 30 points)
    if (deviceMemory !== undefined) {
      if (deviceMemory >= 8) score += 30;
      else if (deviceMemory >= 4) score += 20;
      else if (deviceMemory >= 2) score += 10;
      else score += 5;
    } else {
      // Assume mid-tier if unknown
      score += 15;
    }

    // Connection speed score (max 20 points)
    if (connectionSpeed === 'fast') score += 20;
    else if (connectionSpeed === 'medium') score += 10;
    else score += 5;

    // Texture size score (max 20 points)
    if (maxTextureSize !== undefined) {
      if (maxTextureSize >= 8192) score += 20;
      else if (maxTextureSize >= 4096) score += 15;
      else if (maxTextureSize >= 2048) score += 10;
      else score += 5;
    } else {
      score += 10;
    }

    // Determine tier based on total score (max 100)
    // Use different thresholds for desktop vs mobile to better detect low-end desktops
    let tier: 'low' | 'mid' | 'high';

    // Desktop: use relaxed thresholds to catch more low-end devices
    if (deviceType === 'desktop') {
      if (score >= 65) tier = 'high';
      else if (score >= 45) tier = 'mid';
      else tier = 'low';
    }
    // Mobile/Tablet: use standard thresholds
    else {
      if (score >= 70) tier = 'high';
      else if (score >= 40) tier = 'mid';
      else tier = 'low';
    }

    // Tablets: treat as desktop-like (no downgrade)
    // Phones: downgrade by one tier for battery/thermal management
    if (deviceType === 'phone') {
      if (tier === 'high') tier = 'mid';
      else if (tier === 'mid') tier = 'low';
    }

    const isLowEndDevice = tier === 'low' || (deviceType === 'phone' && hardwareConcurrency <= 4 && (deviceMemory || 2) <= 2);

    this.capabilities = {
      tier,
      hardwareConcurrency,
      deviceMemory,
      connectionSpeed,
      maxTextureSize,
      isMobile,
      isTablet,
      deviceType,
      isLowEndDevice
    };

    console.log('[Performance] Device capabilities:', this.capabilities);
    return this.capabilities;
  }

  /**
   * Get optimized performance configuration based on device capabilities
   */
  getPerformanceConfig(): PerformanceConfig {
    if (this.performanceConfig) {
      return this.performanceConfig;
    }

    const capabilities = this.detectCapabilities();

    let config: PerformanceConfig;

    switch (capabilities.tier) {
      case 'high':
        config = {
          enableAnimations: true,
          enableParticles: true,
          enableBlur: true,
          enableShadows: true,
          enableGradients: true,
          maxListItems: 100,
          imageQuality: 'high',
          debounceDelay: 150,
          lazyLoadThreshold: 1000
        };
        break;

      case 'mid':
        config = {
          enableAnimations: true,
          enableParticles: false,
          enableBlur: false,
          enableShadows: true,
          enableGradients: true,
          maxListItems: 50,
          imageQuality: 'medium',
          debounceDelay: 200,
          lazyLoadThreshold: 500
        };
        break;

      case 'low':
      default:
        config = {
          enableAnimations: false,
          enableParticles: false,
          enableBlur: false,
          enableShadows: false,
          enableGradients: false,
          maxListItems: 30,
          imageQuality: 'low',
          debounceDelay: 300,
          lazyLoadThreshold: 200
        };
        break;
    }

    this.performanceConfig = config;
    console.log('[Performance] Configuration:', config);
    return config;
  }

  /**
   * Detect if device is a tablet
   * All iPad models (Mini, Air, Pro) are treated identically
   */
  private detectTablet(): boolean {
    const userAgent = navigator.userAgent.toLowerCase();
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const maxDimension = Math.max(screenWidth, screenHeight);
    const minDimension = Math.min(screenWidth, screenHeight);

    // iPad detection via user agent
    // For "macintosh" + maxTouchPoints > 1 (iPad in desktop mode),
    // also require screen size to be in tablet range to avoid misidentifying Mac desktops
    const isIPadUA = userAgent.includes('ipad');
    const isIPadDesktopMode = userAgent.includes('macintosh') && navigator.maxTouchPoints > 1 &&
                              maxDimension <= 1400 && minDimension <= 1024;
    const isIPad = isIPadUA || isIPadDesktopMode;
    const isAndroidTablet = userAgent.includes('android') && !userAgent.includes('mobile');
    const isTabletUA = isIPad || isAndroidTablet;

    // Unified screen size detection for all tablets
    // iPad Mini (768x1024) to iPad Pro 12.9" (1024x1366)
    const isTabletSize = minDimension >= 600 && minDimension <= 1024 &&
                         maxDimension >= 768 && maxDimension <= 1400;

    // Only consider touch + size as tablet if the device doesn't appear to be a desktop
    // Mac desktops with Force Touch trackpads report maxTouchPoints > 0 and may have
    // windows sized in the tablet range, but they are not tablets
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isDesktopUA = (userAgent.includes('macintosh') || userAgent.includes('windows nt') || userAgent.includes('linux x86')) &&
                        !userAgent.includes('android');

    const isTablet = isTabletUA || (isTabletSize && hasTouch && !isDesktopUA);

    console.log('[Performance] Tablet detection:', {
      isTablet,
      isTabletUA,
      isIPad,
      isTabletSize,
      hasTouch,
      isDesktopUA,
      dimensions: `${screenWidth}x${screenHeight}`
    });

    return isTablet;
  }

  /**
   * Detect device type (phone, tablet, or desktop)
   */
  private detectDeviceType(): 'phone' | 'tablet' | 'desktop' {
    const isTablet = this.detectTablet();
    if (isTablet) {
      return 'tablet';
    }

    const userAgent = navigator.userAgent.toLowerCase();
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const screenWidth = window.innerWidth;

    // Desktop user agents should never be classified as phones
    const isDesktopUA = (userAgent.includes('macintosh') || userAgent.includes('windows nt') || userAgent.includes('linux x86')) &&
                        !userAgent.includes('android');
    if (isDesktopUA) {
      return 'desktop';
    }

    const phoneKeywords = ['iphone', 'ipod', 'android', 'webos', 'blackberry', 'windows phone'];
    const isPhoneUA = phoneKeywords.some(keyword => userAgent.includes(keyword));
    const isPhoneSize = screenWidth < 768;

    if ((isPhoneUA || isPhoneSize) && isTouchDevice) {
      return 'phone';
    }

    return 'desktop';
  }

  /**
   * Detect if device is mobile (phone or tablet)
   */
  private detectMobile(): boolean {
    const deviceType = this.detectDeviceType();
    return deviceType === 'phone' || deviceType === 'tablet';
  }

  /**
   * Detect connection speed
   */
  private detectConnectionSpeed(): 'slow' | 'medium' | 'fast' {
    const extendedNavigator = navigator as ExtendedNavigator;
    const connection = extendedNavigator.connection || extendedNavigator.mozConnection || extendedNavigator.webkitConnection;

    if (!connection) {
      return 'medium';
    }

    const effectiveType = connection.effectiveType;

    if (effectiveType === '4g' || effectiveType === '5g') {
      return 'fast';
    } else if (effectiveType === '3g') {
      return 'medium';
    } else {
      return 'slow';
    }
  }

  /**
   * Detect max texture size (GPU capability indicator)
   */
  // The GPU limit never changes, and every probe creates a WebGL context, so it is read once per page.
  private detectMaxTextureSize(): number | undefined {
    if (this.maxTextureSize !== null) return this.maxTextureSize;
    let size: number | undefined;
    try {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
      if (gl) {
        size = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch {
      size = undefined;
    }
    this.maxTextureSize = size;
    return size;
  }

  /**
   * Apply CSS optimizations based on device tier
   */
  applyCSSOptimizations(): void {
    const capabilities = this.detectCapabilities();
    const styleId = 'device-performance-optimizations';
    let styleElement = document.getElementById(styleId) as HTMLStyleElement;

    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = styleId;
      document.head.appendChild(styleElement);
    }

    let css = '';

    // Tablets: minimal optimizations (treat like desktop)
    if (capabilities.isTablet) {
      css = `
        /* Tablet-specific optimizations - minimal impact */
        html {
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
      `;
    }
    // Low-end phones only
    else if (capabilities.tier === 'low' && capabilities.deviceType === 'phone') {
      css = `
        /* Low-end phone optimizations */
        .animate-float, .animate-float-slow, .animate-orbit,
        .animate-spin-slow, .animate-scan-line, .animate-matrix-fall,
        .animate-float-block, .animate-data-flow, .animate-glow-pulse {
          animation: none !important;
        }
        .fixed.inset-0.-z-10 * {
          -webkit-backdrop-filter: none !important;
          backdrop-filter: none !important;
        }
      `;
    }
    // Mid-tier phones
    else if (capabilities.tier === 'mid' && capabilities.deviceType === 'phone') {
      css = `
        /* Mid-range phone optimizations */
        .animate-float, .animate-orbit, .animate-spin-slow {
          animation: none !important;
        }
        .fixed.inset-0.-z-10 * {
          -webkit-backdrop-filter: none !important;
          backdrop-filter: none !important;
        }
      `;
    }
    // Low-end desktop optimizations
    else if (capabilities.tier === 'low' && capabilities.deviceType === 'desktop') {
      css = `
        /* Low-end desktop optimizations */
        .animate-float, .animate-orbit, .animate-pulse-slow, .animate-spin-slow,
        .animate-float-slow, .animate-scan-line {
          animation: none !important;
        }
        .fixed.inset-0.-z-10 * {
          -webkit-backdrop-filter: none !important;
          backdrop-filter: none !important;
        }
      `;
    }
    // Mid and High tier desktops
    else if (capabilities.deviceType === 'desktop') {
      css = `
        /* Desktop optimizations */
        .animate-orbit, .animate-spin-slow, .animate-scan-line {
          animation: none !important;
        }
      `;
    }

    styleElement.textContent = css;
  }

  /**
   * Get user-friendly device tier name
   */
  getDeviceTierName(): string {
    const tier = this.detectCapabilities().tier;
    const names = {
      low: '低配模式',
      mid: '标准模式',
      high: '高性能模式'
    };
    return names[tier];
  }
}

// Export singleton instance
export const devicePerformance = new DevicePerformanceDetector();

// Export helper hooks for React components
export function useDeviceCapabilities(): DeviceCapabilities {
  return devicePerformance.detectCapabilities();
}

export function usePerformanceConfig(): PerformanceConfig {
  return devicePerformance.getPerformanceConfig();
}
