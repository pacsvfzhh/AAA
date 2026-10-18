/**
 * Device performance detection and adaptation.
 *
 * The tier comes from hardware signals (cores, memory, GPU texture limit). Safari exposes neither
 * deviceMemory nor the Network Information API, so missing signals never count against a device.
 * A measured frame-rate probe flags devices that are slow in practice (older phones, battery saver,
 * iOS Low Power Mode); every user of useDeviceOptimization() then switches to the lite visuals.
 */

export interface DeviceCapabilities {
  tier: 'low' | 'mid' | 'high';
  hardwareConcurrency: number;
  deviceMemory: number | undefined;
  connectionSpeed: 'slow' | 'medium' | 'fast';
  maxTextureSize: number | undefined;
  isMobile: boolean;
  isTablet: boolean;
  isIOS: boolean;
  saveData: boolean;
  deviceType: 'phone' | 'tablet' | 'desktop';
  isLowEndDevice: boolean;
}

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
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

const SLOW_FRAMES_KEY = 'device_slow_frames';
const LITE_CLASS = 'perf-lite';
// The probe starts once the app has settled, then needs two consecutive slow windows before it flips the device to lite.
const PROBE_START_DELAY_MS = 4000;
const PROBE_WINDOW_MS = 2000;
const PROBE_MAX_FRAME_GAP_MS = 250;
const PROBE_MIN_FPS = 38;
const PROBE_SLOW_WINDOWS = 2;

class DevicePerformanceDetector {
  private capabilities: DeviceCapabilities | null = null;
  private performanceConfig: PerformanceConfig | null = null;
  private maxTextureSize: number | undefined | null = null;
  private slowFrames = false;
  private started = false;
  private lastWidth = 0;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }

  /**
   * Reset cached capabilities (screen resize or a new slow-frame verdict)
   */
  resetCapabilities(): void {
    this.capabilities = null;
    this.performanceConfig = null;
  }

  /**
   * Applies the CSS for the current tier, tracks width changes and starts the frame-rate probe. Safe to call repeatedly.
   */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.lastWidth = window.innerWidth;

    this.applyCSSOptimizations();

    // Mobile toolbars collapsing while scrolling fire height-only resizes; the device class can only change with width.
    const handleResize = () => {
      if (window.innerWidth === this.lastWidth) return;
      this.lastWidth = window.innerWidth;
      this.resetCapabilities();
      this.applyCSSOptimizations();
      this.notify();
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    this.startFrameRateProbe();
  }

  private startFrameRateProbe(): void {
    try {
      if (sessionStorage.getItem(SLOW_FRAMES_KEY) === '1') {
        this.setSlowFrames(false);
        return;
      }
    } catch {
      // Storage can be blocked; the probe still works without the remembered verdict.
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frameId = 0;
    let windowStart = 0;
    let lastFrame = 0;
    let frames = 0;
    let slowWindows = 0;
    let stopped = false;

    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frameId);
    };
    const tick = (now: number) => {
      if (stopped) return;
      // A long gap means the tab was hidden or the main thread was blocked; that says nothing about rendering speed.
      if (!windowStart || now - lastFrame > PROBE_MAX_FRAME_GAP_MS) {
        windowStart = now;
        frames = 0;
        slowWindows = 0;
      } else {
        frames++;
        if (now - windowStart >= PROBE_WINDOW_MS) {
          const fps = (frames * 1000) / (now - windowStart);
          if (fps >= PROBE_MIN_FPS) {
            stop();
            return;
          }
          slowWindows++;
          if (slowWindows >= PROBE_SLOW_WINDOWS) {
            stop();
            this.setSlowFrames(true);
            return;
          }
          windowStart = now;
          frames = 0;
        }
      }
      lastFrame = now;
      frameId = requestAnimationFrame(tick);
    };

    window.setTimeout(() => {
      if (!stopped) frameId = requestAnimationFrame(tick);
    }, PROBE_START_DELAY_MS);
  }

  private setSlowFrames(remember: boolean): void {
    if (this.slowFrames) return;
    this.slowFrames = true;
    if (remember) {
      try {
        sessionStorage.setItem(SLOW_FRAMES_KEY, '1');
      } catch {
        // Not remembering only means the probe runs again after a reload.
      }
    }
    this.resetCapabilities();
    this.applyCSSOptimizations();
    this.notify();
  }

  /**
   * Detect device capabilities
   */
  detectCapabilities(): DeviceCapabilities {
    if (this.capabilities) {
      return this.capabilities;
    }

    const isTablet = this.detectTablet();
    const isMobile = this.detectMobile();
    const deviceType = this.detectDeviceType();
    const isIOS = this.detectIOS();
    const hardwareConcurrency = navigator.hardwareConcurrency || 2;
    const deviceMemory = (navigator as ExtendedNavigator).deviceMemory;
    const connectionSpeed = this.detectConnectionSpeed();
    const saveData = this.detectSaveData();
    const maxTextureSize = this.detectMaxTextureSize();

    let score = 0;

    // CPU cores (max 35)
    if (hardwareConcurrency >= 8) score += 35;
    else if (hardwareConcurrency >= 6) score += 30;
    else if (hardwareConcurrency >= 4) score += 22;
    else if (hardwareConcurrency >= 2) score += 10;
    else score += 5;

    // Memory (max 30). Safari never reports it; Apple devices that run current iOS are uniformly capable.
    if (deviceMemory !== undefined) {
      if (deviceMemory >= 8) score += 30;
      else if (deviceMemory >= 4) score += 22;
      else if (deviceMemory >= 2) score += 10;
      else score += 4;
    } else {
      score += isIOS ? 24 : 16;
    }

    // GPU texture limit (max 25)
    if (maxTextureSize !== undefined) {
      if (maxTextureSize >= 16384) score += 25;
      else if (maxTextureSize >= 8192) score += 18;
      else if (maxTextureSize >= 4096) score += 10;
      else score += 5;
    } else {
      score += 12;
    }

    let tier: 'low' | 'mid' | 'high';
    if (score >= 60) tier = 'high';
    else if (score >= 35) tier = 'mid';
    else tier = 'low';

    let isLowEndDevice = tier === 'low'
      || saveData
      || (deviceMemory !== undefined && deviceMemory <= 2)
      || (!isIOS && hardwareConcurrency <= 2);

    if (this.slowFrames) {
      tier = 'low';
      isLowEndDevice = true;
    }

    this.capabilities = {
      tier,
      hardwareConcurrency,
      deviceMemory,
      connectionSpeed,
      maxTextureSize,
      isMobile,
      isTablet,
      isIOS,
      saveData,
      deviceType,
      isLowEndDevice
    };

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
    return config;
  }

  /**
   * iPhone, iPad and iPod, including iPadOS / "Request Desktop Website" which report a Macintosh user agent.
   */
  private detectIOS(): boolean {
    return /iPhone|iPad|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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

    return isTabletUA || (isTabletSize && hasTouch && !isDesktopUA);
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

  private getConnection(): NetworkInformationLike | undefined {
    const extendedNavigator = navigator as ExtendedNavigator;
    return extendedNavigator.connection || extendedNavigator.mozConnection || extendedNavigator.webkitConnection;
  }

  /**
   * Detect connection speed
   */
  private detectConnectionSpeed(): 'slow' | 'medium' | 'fast' {
    const connection = this.getConnection();

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

  private detectSaveData(): boolean {
    return this.getConnection()?.saveData === true;
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
    let styleElement = document.getElementById(styleId) as HTMLStyleElement | null;

    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = styleId;
      document.head.appendChild(styleElement);
    }

    // The perf-lite rules in index.css (no backdrop blur, no decorative glows) hang off this class.
    document.documentElement.classList.toggle(LITE_CLASS, capabilities.isLowEndDevice);

    let css = '';

    if (capabilities.isLowEndDevice) {
      css = `
        /* Low-performance device optimizations */
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
    } else if (capabilities.isTablet) {
      css = `
        /* Tablet-specific optimizations - minimal impact */
        html {
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
      `;
    } else if (capabilities.tier === 'mid') {
      css = `
        /* Mid-range device optimizations */
        .animate-float, .animate-orbit, .animate-spin-slow {
          animation: none !important;
        }
        .fixed.inset-0.-z-10 * {
          -webkit-backdrop-filter: none !important;
          backdrop-filter: none !important;
        }
      `;
    } else if (capabilities.deviceType === 'desktop') {
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
