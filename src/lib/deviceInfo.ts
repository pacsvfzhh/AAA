export type DeviceOsFamily = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'unknown';
export type DeviceType = 'phone' | 'tablet' | 'desktop' | 'unknown';
export type BrowserFamily = 'chrome' | 'safari' | 'edge' | 'firefox' | 'webview' | 'opera' | 'samsung' | 'other' | 'unknown';
export type DeviceInfoSource = 'client_hints' | 'user_agent' | 'fallback';

export interface LoginDeviceInfo {
  os_family: DeviceOsFamily;
  os_version: string | null;
  device_type: DeviceType;
  device_model: string | null;
  browser_family: BrowserFamily;
  browser_version: string | null;
  source: DeviceInfoSource;
}

interface UserAgentDataLike {
  brands?: Array<{ brand: string; version: string }>;
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    brands?: Array<{ brand: string; version: string }>;
    fullVersionList?: Array<{ brand: string; version: string }>;
    mobile?: boolean;
    model?: string;
    platform?: string;
    platformVersion?: string;
  }>;
}

interface DeviceParseHints {
  brands?: Array<{ brand: string; version: string }>;
  mobile?: boolean;
  model?: string;
  platform?: string;
  platformVersion?: string;
  navigatorPlatform?: string;
  maxTouchPoints?: number;
  screenWidth?: number;
  fromClientHints?: boolean;
}

const OS_FAMILIES: DeviceOsFamily[] = ['android', 'ios', 'windows', 'macos', 'linux', 'chromeos', 'unknown'];
const DEVICE_TYPES: DeviceType[] = ['phone', 'tablet', 'desktop', 'unknown'];
const BROWSER_FAMILIES: BrowserFamily[] = ['chrome', 'safari', 'edge', 'firefox', 'webview', 'opera', 'samsung', 'other', 'unknown'];
const INFO_SOURCES: DeviceInfoSource[] = ['client_hints', 'user_agent', 'fallback'];

const firstMatch = (userAgent: string, pattern: RegExp) => userAgent.match(pattern)?.[1] || null;

const normalizeVersion = (value: string | null | undefined) => {
  const version = value?.trim().replace(/_/g, '.') || '';
  return version && !/^0(?:\.0)*$/.test(version) ? version : null;
};

const nonEmptyString = (value: unknown) => typeof value === 'string' && value.trim()
  ? value.trim()
  : null;

const isKnownValue = <T extends string>(value: unknown, values: readonly T[]): value is T => (
  typeof value === 'string' && values.includes(value as T)
);

const parseOs = (userAgent: string, hints: DeviceParseHints): DeviceOsFamily => {
  const platform = hints.platform?.toLowerCase();
  const isDesktopModeIpad = hints.navigatorPlatform === 'MacIntel'
    && (hints.maxTouchPoints || 0) > 1;

  if (/Windows Phone/i.test(userAgent) || platform?.startsWith('win')) return 'windows';
  if (/Android/i.test(userAgent) || platform === 'android') return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent) || isDesktopModeIpad) return 'ios';
  if (/CrOS/i.test(userAgent) || platform === 'chrome os') return 'chromeos';
  if (/Windows NT/i.test(userAgent)) return 'windows';
  if (/Mac OS X/i.test(userAgent) || platform?.startsWith('mac')) return 'macos';
  if (/Linux/i.test(userAgent) || platform?.includes('linux')) return 'linux';
  return 'unknown';
};

const parseOsVersion = (
  userAgent: string,
  osFamily: DeviceOsFamily,
  hints: DeviceParseHints,
) => {
  const platformVersion = normalizeVersion(hints.platformVersion);

  if (osFamily === 'android') {
    if (platformVersion) return platformVersion;
    if (/Android\s+10(?:\.0)*;\s*K(?:[;)])/i.test(userAgent)) return null;
    return normalizeVersion(firstMatch(userAgent, /Android\s+([\d.]+)/i));
  }
  if (osFamily === 'ios') {
    return normalizeVersion(firstMatch(userAgent, /(?:CPU(?: iPhone)? OS|iPhone OS)\s+([\d_]+)/i));
  }
  if (osFamily === 'windows') {
    const windowsPhoneVersion = normalizeVersion(firstMatch(userAgent, /Windows Phone(?: OS)?\s+([\d.]+)/i));
    if (windowsPhoneVersion) return windowsPhoneVersion;

    if (platformVersion) {
      const major = Number.parseInt(platformVersion, 10);
      if (major >= 13) return '11';
      if (major > 0) return '10';
    }

    const ntVersion = firstMatch(userAgent, /Windows NT\s+([\d.]+)/i);
    return ntVersion ? ({
      '10.0': '10/11',
      '6.3': '8.1',
      '6.2': '8',
      '6.1': '7',
      '6.0': 'Vista',
      '5.1': 'XP',
    } as Record<string, string>)[ntVersion] || ntVersion : null;
  }
  if (osFamily === 'macos') {
    return platformVersion || normalizeVersion(firstMatch(userAgent, /Mac OS X\s+([\d_]+)/i));
  }
  if (osFamily === 'chromeos') {
    return platformVersion || normalizeVersion(firstMatch(userAgent, /CrOS\s+[^\s)]+\s+([\d.]+)/i));
  }
  return null;
};

const parseDeviceModel = (userAgent: string, osFamily: DeviceOsFamily, hints: DeviceParseHints) => {
  const model = nonEmptyString(hints.model)
    || (osFamily === 'android'
      ? nonEmptyString(firstMatch(userAgent, /;\s*([^;()]+?)\s+Build\/[^;)]+/i))
      : null);

  return model && !/^(?:K|Mobile|Tablet|wv)$/i.test(model) ? model : null;
};

const parseBrowser = (userAgent: string, hints: DeviceParseHints) => {
  const hintedVersion = (brandPattern: RegExp) => normalizeVersion(
    hints.brands?.find(({ brand }) => brandPattern.test(brand))?.version,
  );
  const hintedChromeVersion = hintedVersion(/Google Chrome/i) || hintedVersion(/Chromium/i);

  const edgeVersion = firstMatch(userAgent, /(?:Edg|EdgA|EdgiOS|Edge)\/([\d.]+)/i);
  if (edgeVersion) return { family: 'edge' as const, version: hintedVersion(/edge/i) || edgeVersion };

  const operaVersion = firstMatch(userAgent, /OPR\/([\d.]+)/i);
  if (operaVersion) return { family: 'opera' as const, version: hintedVersion(/opera/i) || operaVersion };

  const samsungVersion = firstMatch(userAgent, /SamsungBrowser\/([\d.]+)/i);
  if (samsungVersion) return { family: 'samsung' as const, version: hintedVersion(/samsung/i) || samsungVersion };

  const firefoxVersion = firstMatch(userAgent, /(?:Firefox|FxiOS)\/([\d.]+)/i);
  if (firefoxVersion) return { family: 'firefox' as const, version: firefoxVersion };

  if (/(?:;\s*wv\)|\bwv\b)/i.test(userAgent)) {
    return {
      family: 'webview' as const,
      version: hintedChromeVersion || firstMatch(userAgent, /Chrome\/([\d.]+)/i),
    };
  }

  const chromeVersion = firstMatch(userAgent, /(?:Chrome|CriOS)\/([\d.]+)/i);
  if (chromeVersion) return { family: 'chrome' as const, version: hintedChromeVersion || chromeVersion };

  const safariVersion = firstMatch(userAgent, /Version\/([\d.]+).*Safari\//i);
  if (safariVersion) return { family: 'safari' as const, version: safariVersion };

  const hintedBrand = hints.brands?.find(({ brand }) => /edge/i.test(brand))
    || hints.brands?.find(({ brand }) => /opera/i.test(brand))
    || hints.brands?.find(({ brand }) => /chrome|chromium/i.test(brand));
  if (hintedBrand) {
    const brand = hintedBrand.brand.toLowerCase();
    return {
      family: /edge/.test(brand) ? 'edge' as const : /opera/.test(brand) ? 'opera' as const : 'chrome' as const,
      version: normalizeVersion(hintedBrand.version),
    };
  }

  if (userAgent) return { family: 'other' as const, version: null };
  return { family: 'unknown' as const, version: null };
};

const parseDeviceType = (userAgent: string, osFamily: DeviceOsFamily, hints: DeviceParseHints): DeviceType => {
  const isIpad = /iPad/i.test(userAgent) || (
    osFamily === 'ios'
    && hints.navigatorPlatform === 'MacIntel'
    && (hints.maxTouchPoints || 0) > 1
  );
  if (isIpad || /Android/i.test(userAgent) && !/Mobile/i.test(userAgent)) return 'tablet';
  if (/iPhone|iPod|Mobile/i.test(userAgent) || hints.mobile === true) return 'phone';
  if (osFamily !== 'unknown') return 'desktop';
  return 'unknown';
};

export function parseLoginDeviceInfo(
  userAgent: string | null | undefined,
  hints: DeviceParseHints = {},
): LoginDeviceInfo {
  const normalizedUserAgent = typeof userAgent === 'string' ? userAgent : '';
  const os = parseOs(normalizedUserAgent, hints);
  const browser = parseBrowser(normalizedUserAgent, hints);

  return {
    os_family: os,
    os_version: parseOsVersion(normalizedUserAgent, os, hints),
    device_type: parseDeviceType(normalizedUserAgent, os, hints),
    device_model: parseDeviceModel(normalizedUserAgent, os, hints),
    browser_family: browser.family,
    browser_version: browser.version,
    source: hints.fromClientHints ? 'client_hints' : normalizedUserAgent ? 'user_agent' : 'fallback',
  };
}

export async function collectLoginDeviceInfo(): Promise<LoginDeviceInfo> {
  if (typeof navigator === 'undefined') return parseLoginDeviceInfo(null);

  const navigatorWithHints = navigator as Navigator & { userAgentData?: UserAgentDataLike };
  const userAgentData = navigatorWithHints.userAgentData;
  let highEntropyValues: Awaited<ReturnType<NonNullable<UserAgentDataLike['getHighEntropyValues']>>> | undefined;

  if (userAgentData?.getHighEntropyValues) {
    try {
      highEntropyValues = await userAgentData.getHighEntropyValues([
        'brands',
        'fullVersionList',
        'mobile',
        'model',
        'platform',
        'platformVersion',
      ]);
    } catch {
      highEntropyValues = undefined;
    }
  }

  const hasClientHints = Boolean(userAgentData || highEntropyValues);
  return parseLoginDeviceInfo(navigator.userAgent, {
    brands: highEntropyValues?.fullVersionList || highEntropyValues?.brands || userAgentData?.brands,
    mobile: highEntropyValues?.mobile ?? userAgentData?.mobile,
    model: highEntropyValues?.model,
    platform: highEntropyValues?.platform || userAgentData?.platform,
    platformVersion: highEntropyValues?.platformVersion,
    navigatorPlatform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    screenWidth: typeof window !== 'undefined' ? window.screen.width : undefined,
    fromClientHints: hasClientHints,
  });
}

export function resolveLoginDeviceInfo(value: unknown, userAgent: string | null | undefined): LoginDeviceInfo {
  const fallback = parseLoginDeviceInfo(userAgent);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;

  const stored = value as Record<string, unknown>;
  const storedOsFamily = isKnownValue(stored.os_family, OS_FAMILIES) && stored.os_family !== 'unknown'
    ? stored.os_family
    : fallback.os_family;
  const storedBrowserFamily = isKnownValue(stored.browser_family, BROWSER_FAMILIES) && stored.browser_family !== 'unknown'
    ? stored.browser_family
    : fallback.browser_family;

  return {
    os_family: storedOsFamily,
    os_version: nonEmptyString(stored.os_version) || fallback.os_version,
    device_type: isKnownValue(stored.device_type, DEVICE_TYPES) && stored.device_type !== 'unknown'
      ? stored.device_type
      : fallback.device_type,
    device_model: nonEmptyString(stored.device_model) || fallback.device_model,
    browser_family: storedBrowserFamily,
    browser_version: nonEmptyString(stored.browser_version) || fallback.browser_version,
    source: isKnownValue(stored.source, INFO_SOURCES) ? stored.source : fallback.source,
  };
}
