/**
 * Responsive Breakpoints for Real Mobile Devices
 *
 * Comprehensive breakpoint system covering all major mobile devices
 * from small budget phones to large flagships and tablets
 */

export const DEVICE_BREAKPOINTS = {
  // Ultra Small Phones (240-320px)
  // iPhone 4/4S, old Android budget phones
  xs: {
    min: 240,
    max: 320,
    name: '超小屏幕',
    devices: ['iPhone 4/4S', 'SE 第一代 (竖屏)', '老旧 Android'],
    fontSize: '12px',
    padding: '8px',
    spacing: '4px'
  },

  // Small Phones (321-375px)
  // iPhone 6/7/8, iPhone SE 2020, small Android
  sm: {
    min: 321,
    max: 375,
    name: '小屏手机',
    devices: ['iPhone 6/7/8', 'iPhone SE 2020', '小屏 Android'],
    fontSize: '13px',
    padding: '12px',
    spacing: '6px'
  },

  // Standard Phones (376-414px)
  // iPhone 6+/7+/8+, iPhone X/XS/11 Pro, most Android
  md: {
    min: 376,
    max: 414,
    name: '标准手机',
    devices: ['iPhone X/XS/11 Pro', 'iPhone 6/7/8 Plus', '主流 Android'],
    fontSize: '14px',
    padding: '16px',
    spacing: '8px'
  },

  // Large Phones (415-480px)
  // iPhone XR/11/12/13/14, large Android phones
  lg: {
    min: 415,
    max: 479,
    name: '大屏手机',
    devices: ['iPhone XR/11/12/13/14', '大屏 Android'],
    fontSize: '15px',
    padding: '20px',
    spacing: '10px'
  },

  // Extra Large Phones (481-599px)
  // iPhone Pro Max series, Android phablets
  xl: {
    min: 480,
    max: 599,
    name: '超大屏手机',
    devices: ['iPhone Pro Max', 'Android 大屏手机'],
    fontSize: '16px',
    padding: '24px',
    spacing: '12px'
  },

  // Tablets (600-1024px) - includes iPad Mini and all iPads
  tablet: {
    min: 600,
    max: 1024,
    name: '平板',
    devices: ['iPad Mini', 'iPad', 'iPad Pro', 'Android 平板'],
    fontSize: '16px',
    padding: '32px',
    spacing: '16px'
  },

  // Desktop (1025+)
  desktop: {
    min: 1025,
    max: Infinity,
    name: '桌面',
    devices: ['电脑', '笔记本'],
    fontSize: '16px',
    padding: '32px',
    spacing: '16px'
  }
} as const;

/**
 * Common device pixel ratios
 */
export const PIXEL_RATIOS = {
  standard: 1,      // Old devices
  retina: 2,        // Most iPhones, high-end Android
  superRetina: 3    // iPhone X and newer flagships
} as const;

/**
 * Viewport height categories for handling different aspect ratios
 */
export const VIEWPORT_HEIGHTS = {
  short: {
    max: 667,         // iPhone SE, iPhone 6/7/8
    name: '短屏'
  },
  standard: {
    min: 668,
    max: 812,         // iPhone X/XS/11 Pro
    name: '标准'
  },
  tall: {
    min: 813,
    max: 926,         // iPhone 12/13/14 Pro Max
    name: '长屏'
  },
  extraTall: {
    min: 927,
    name: '超长屏'    // Some Android devices
  }
} as const;

/**
 * Real device database for precise optimization
 */
export const DEVICE_DATABASE = {
  // Apple Devices
  'iPhone SE (1st)': { width: 320, height: 568, ratio: 2, category: 'xs' },
  'iPhone SE (2nd/3rd)': { width: 375, height: 667, ratio: 2, category: 'sm' },
  'iPhone 6/7/8': { width: 375, height: 667, ratio: 2, category: 'sm' },
  'iPhone 6+/7+/8+': { width: 414, height: 736, ratio: 3, category: 'md' },
  'iPhone X/XS/11 Pro': { width: 375, height: 812, ratio: 3, category: 'sm' },
  'iPhone XR/11': { width: 414, height: 896, ratio: 2, category: 'md' },
  'iPhone XS Max/11 Pro Max': { width: 414, height: 896, ratio: 3, category: 'md' },
  'iPhone 12 Mini/13 Mini': { width: 375, height: 812, ratio: 3, category: 'sm' },
  'iPhone 12/12 Pro/13/13 Pro': { width: 390, height: 844, ratio: 3, category: 'md' },
  'iPhone 12 Pro Max/13 Pro Max': { width: 428, height: 926, ratio: 3, category: 'lg' },
  'iPhone 14': { width: 390, height: 844, ratio: 3, category: 'md' },
  'iPhone 14 Plus': { width: 428, height: 926, ratio: 3, category: 'lg' },
  'iPhone 14 Pro': { width: 393, height: 852, ratio: 3, category: 'md' },
  'iPhone 14 Pro Max': { width: 430, height: 932, ratio: 3, category: 'lg' },
  'iPhone 15/15 Pro': { width: 393, height: 852, ratio: 3, category: 'md' },
  'iPhone 15 Plus/15 Pro Max': { width: 430, height: 932, ratio: 3, category: 'lg' },

  // Samsung Galaxy
  'Galaxy S8/S9': { width: 360, height: 740, ratio: 4, category: 'sm' },
  'Galaxy S10': { width: 360, height: 760, ratio: 4, category: 'sm' },
  'Galaxy S20': { width: 360, height: 800, ratio: 3, category: 'sm' },
  'Galaxy S21': { width: 360, height: 800, ratio: 3, category: 'sm' },
  'Galaxy S22': { width: 360, height: 780, ratio: 3, category: 'sm' },
  'Galaxy S23': { width: 360, height: 780, ratio: 3, category: 'sm' },
  'Galaxy Note 10': { width: 412, height: 869, ratio: 3, category: 'md' },
  'Galaxy Note 20': { width: 412, height: 915, ratio: 3, category: 'md' },
  'Galaxy A Series': { width: 360, height: 760, ratio: 2.75, category: 'sm' },

  // Google Pixel
  'Pixel 3/4/5': { width: 393, height: 851, ratio: 2.75, category: 'md' },
  'Pixel 6/7': { width: 412, height: 915, ratio: 2.625, category: 'md' },
  'Pixel 6 Pro/7 Pro': { width: 412, height: 892, ratio: 3, category: 'md' },

  // OnePlus
  'OnePlus 8/9': { width: 412, height: 915, ratio: 3, category: 'md' },

  // Xiaomi
  'Xiaomi Mi 11': { width: 393, height: 851, ratio: 3, category: 'md' },
  'Xiaomi Redmi Note': { width: 393, height: 873, ratio: 2.75, category: 'md' },

  // Tablets - all iPads use same 'tablet' category
  'iPad Mini': { width: 768, height: 1024, ratio: 2, category: 'tablet' },
  'iPad': { width: 810, height: 1080, ratio: 2, category: 'tablet' },
  'iPad Pro 11"': { width: 834, height: 1194, ratio: 2, category: 'tablet' },
  'iPad Pro 12.9"': { width: 1024, height: 1366, ratio: 2, category: 'tablet' }
} as const;

/**
 * Detect current device category
 */
export function detectDeviceCategory(): keyof typeof DEVICE_BREAKPOINTS {
  const width = window.innerWidth;

  if (width <= DEVICE_BREAKPOINTS.xs.max) return 'xs';
  if (width <= DEVICE_BREAKPOINTS.sm.max) return 'sm';
  if (width <= DEVICE_BREAKPOINTS.md.max) return 'md';
  if (width <= DEVICE_BREAKPOINTS.lg.max) return 'lg';
  if (width <= DEVICE_BREAKPOINTS.xl.max) return 'xl';
  if (width <= DEVICE_BREAKPOINTS.tablet.max) return 'tablet';
  return 'desktop';
}

/**
 * Detect viewport height category
 */
export function detectViewportHeight(): keyof typeof VIEWPORT_HEIGHTS {
  const height = window.innerHeight;

  if (height <= VIEWPORT_HEIGHTS.short.max) return 'short';
  if (height <= VIEWPORT_HEIGHTS.standard.max) return 'standard';
  if (height <= VIEWPORT_HEIGHTS.tall.max) return 'tall';
  return 'extraTall';
}

/**
 * Get optimal configuration for current device
 */
export function getDeviceConfig() {
  const category = detectDeviceCategory();
  const heightCategory = detectViewportHeight();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;

  return {
    category,
    heightCategory,
    pixelRatio,
    width,
    height,
    config: DEVICE_BREAKPOINTS[category],
    isSmallScreen: width <= 375,
    isShortScreen: height <= 667,
    isTallScreen: height >= 813,
    isRetina: pixelRatio >= 2,
    isSuperRetina: pixelRatio >= 3,
    isNotchDevice: height >= 812 && height <= 932 // iPhone X and newer
  };
}

/**
 * Get responsive font size based on device
 */
export function getResponsiveFontSize(baseSize: number): string {
  const category = detectDeviceCategory();
  const config = DEVICE_BREAKPOINTS[category];
  const baseFontSize = parseInt(config.fontSize);

  const scaledSize = (baseSize / 16) * baseFontSize;
  return `${scaledSize}px`;
}

/**
 * Get responsive spacing based on device
 */
export function getResponsiveSpacing(multiplier: number = 1): string {
  const category = detectDeviceCategory();
  const config = DEVICE_BREAKPOINTS[category];
  const baseSpacing = parseInt(config.spacing);

  return `${baseSpacing * multiplier}px`;
}

/**
 * Get responsive padding based on device
 */
export function getResponsivePadding(multiplier: number = 1): string {
  const category = detectDeviceCategory();
  const config = DEVICE_BREAKPOINTS[category];
  const basePadding = parseInt(config.padding);

  return `${basePadding * multiplier}px`;
}

/**
 * Check if device needs special layout adjustments
 */
export function needsLayoutAdjustment() {
  const { isSmallScreen, isShortScreen, isNotchDevice } = getDeviceConfig();

  return {
    compactMode: isSmallScreen || isShortScreen,
    needsSafeArea: isNotchDevice,
    useScrollableLayout: isShortScreen,
    stackButtons: isSmallScreen
  };
}
