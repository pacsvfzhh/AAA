import { useState, useEffect } from 'react';
import {
  getDeviceConfig,
  needsLayoutAdjustment,
  DEVICE_BREAKPOINTS
} from './responsiveBreakpoints';

const sameValues = <T extends object>(a: T, b: T) =>
  (Object.keys(b) as (keyof T)[]).every(key => Object.is(a[key], b[key]));

/**
 * Hook for responsive design based on real device dimensions
 */
export function useResponsive() {
  const [deviceConfig, setDeviceConfig] = useState(() => getDeviceConfig());
  const [layoutAdjustments, setLayoutAdjustments] = useState(() => needsLayoutAdjustment());

  useEffect(() => {
    // <body> resizes on every content height change (e.g. each tab switch); only re-render when a value changed.
    const handleResize = () => {
      const nextConfig = getDeviceConfig();
      const nextAdjustments = needsLayoutAdjustment();
      setDeviceConfig(prev => (sameValues(prev, nextConfig) ? prev : nextConfig));
      setLayoutAdjustments(prev => (sameValues(prev, nextAdjustments) ? prev : nextAdjustments));
    };

    // Handle orientation change with proper timing
    const handleOrientationChange = () => {
      // Use multiple strategies to ensure we capture the correct dimensions
      // after orientation change completes

      // Strategy 1: Immediate update
      handleResize();

      // Strategy 2: After a short delay (iOS Safari needs this)
      setTimeout(() => {
        handleResize();
      }, 100);

      // Strategy 3: After animation frame (ensure layout is complete)
      requestAnimationFrame(() => {
        handleResize();
      });

      // Strategy 4: After a longer delay (for slower devices)
      setTimeout(() => {
        handleResize();
      }, 300);
    };

    // Use ResizeObserver for better performance
    let resizeObserver: ResizeObserver | null = null;

    let resizeFrame = 0;
    if ('ResizeObserver' in window) {
      // Re-rendering synchronously inside the callback can resize <body> again and trigger the "ResizeObserver loop" warning.
      resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(handleResize);
      });
      resizeObserver.observe(document.body);
    }

    // Listen for orientation changes with enhanced handling
    window.addEventListener('orientationchange', handleOrientationChange);

    // Also listen for resize events (as backup for orientation changes)
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(resizeFrame);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
    };
  }, []);

  return {
    ...deviceConfig,
    ...layoutAdjustments,
    // Helper booleans
    isXS: deviceConfig.category === 'xs',
    isSM: deviceConfig.category === 'sm',
    isMD: deviceConfig.category === 'md',
    isLG: deviceConfig.category === 'lg',
    isXL: deviceConfig.category === 'xl',
    isTablet: ['xl', 'tablet'].includes(deviceConfig.category),
    isDesktop: deviceConfig.category === 'desktop',
    isMobile: ['xs', 'sm', 'md', 'lg'].includes(deviceConfig.category),
    deviceName: deviceConfig.config.name
  };
}

/**
 * Hook for viewport-safe positioning (handles notches, status bars)
 */
export function useSafeArea() {
  const [safeAreaInsets, setSafeAreaInsets] = useState({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  });

  useEffect(() => {
    const computeSafeArea = () => {
      // Get CSS environment variables for safe area
      const computedStyle = getComputedStyle(document.documentElement);

      const top = parseInt(computedStyle.getPropertyValue('env(safe-area-inset-top)') || '0');
      const right = parseInt(computedStyle.getPropertyValue('env(safe-area-inset-right)') || '0');
      const bottom = parseInt(computedStyle.getPropertyValue('env(safe-area-inset-bottom)') || '0');
      const left = parseInt(computedStyle.getPropertyValue('env(safe-area-inset-left)') || '0');

      setSafeAreaInsets({ top, right, bottom, left });
    };

    computeSafeArea();
    window.addEventListener('resize', computeSafeArea);
    window.addEventListener('orientationchange', computeSafeArea);

    return () => {
      window.removeEventListener('resize', computeSafeArea);
      window.removeEventListener('orientationchange', computeSafeArea);
    };
  }, []);

  return safeAreaInsets;
}

/**
 * Hook for text truncation based on device
 */
export function useTextTruncation() {
  const { isSmallScreen } = useResponsive();

  return {
    maxChars: isSmallScreen ? 50 : 100,
    maxLines: isSmallScreen ? 2 : 3,
    ellipsis: '...'
  };
}

/**
 * Hook for responsive image sizing
 */
export function useResponsiveImage() {
  const { width, isRetina, isSuperRetina } = useResponsive();

  const getImageWidth = (baseWidth: number) => {
    const scaleFactor = isSuperRetina ? 3 : isRetina ? 2 : 1;
    return Math.min(baseWidth * scaleFactor, width);
  };

  const getSrcSet = (baseUrl: string, sizes: number[]) => {
    return sizes.map(size => `${baseUrl}?w=${size} ${size}w`).join(', ');
  };

  return {
    getImageWidth,
    getSrcSet,
    quality: isSuperRetina ? 0.95 : isRetina ? 0.90 : 0.85,
    loading: 'lazy' as const
  };
}

/**
 * Hook for responsive grid columns
 */
export function useResponsiveGrid() {
  const { category } = useResponsive();

  const getColumns = (maxColumns: number = 4) => {
    if (category === 'xs') return 1;
    if (category === 'sm') return Math.min(2, maxColumns);
    if (category === 'md') return Math.min(2, maxColumns);
    if (category === 'lg') return Math.min(3, maxColumns);
    if (category === 'xl') return Math.min(3, maxColumns);
    if (category === 'tablet') return Math.min(4, maxColumns);
    return maxColumns;
  };

  const getGap = () => {
    const config = DEVICE_BREAKPOINTS[category];
    return config.spacing;
  };

  return {
    columns: getColumns,
    gap: getGap()
  };
}

/**
 * Hook for responsive modal sizing
 */
export function useResponsiveModal() {
  const { width, isSmallScreen, isShortScreen } = useResponsive();

  const getModalSize = () => {
    if (isSmallScreen || width < 400) {
      return {
        width: '95vw',
        maxWidth: '400px',
        height: isShortScreen ? '90vh' : 'auto',
        maxHeight: '90vh'
      };
    }

    if (width < 768) {
      return {
        width: '90vw',
        maxWidth: '600px',
        height: isShortScreen ? '85vh' : 'auto',
        maxHeight: '85vh'
      };
    }

    return {
      width: '80vw',
      maxWidth: '800px',
      height: 'auto',
      maxHeight: '90vh'
    };
  };

  return getModalSize();
}

/**
 * Hook for touch/click optimization
 */
export function useTouchOptimization() {
  const { isMobile, isSmallScreen } = useResponsive();

  return {
    isTouchDevice: isMobile,
    minTouchTarget: isSmallScreen ? 44 : 48, // Apple HIG: 44pt minimum
    tapHighlight: 'transparent',
    userSelect: 'none' as const,
    touchAction: 'manipulation' as const
  };
}

/**
 * Apply responsive meta tags
 */
export function useApplyResponsiveMeta() {
  useEffect(() => {
    // Ensure viewport meta tag is set correctly
    let viewport = document.querySelector('meta[name="viewport"]');

    if (!viewport) {
      viewport = document.createElement('meta');
      viewport.setAttribute('name', 'viewport');
      document.head.appendChild(viewport);
    }

    viewport.setAttribute(
      'content',
      'width=device-width, initial-scale=1.0, maximum-scale=5.0, minimum-scale=1.0, viewport-fit=cover, user-scalable=yes'
    );

    // Add theme-color for better native feel
    let themeColor = document.querySelector('meta[name="theme-color"]');
    if (!themeColor) {
      themeColor = document.createElement('meta');
      themeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(themeColor);
    }
    themeColor.setAttribute('content', '#0f172a'); // slate-950

    // Add mobile-web-app-capable for iOS
    let appleCapable = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
    if (!appleCapable) {
      appleCapable = document.createElement('meta');
      appleCapable.setAttribute('name', 'apple-mobile-web-app-capable');
      document.head.appendChild(appleCapable);
    }
    appleCapable.setAttribute('content', 'yes');

    // Add status bar style for iOS
    let statusBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (!statusBar) {
      statusBar = document.createElement('meta');
      statusBar.setAttribute('name', 'apple-mobile-web-app-status-bar-style');
      document.head.appendChild(statusBar);
    }
    statusBar.setAttribute('content', 'black-translucent');
  }, []);
}
