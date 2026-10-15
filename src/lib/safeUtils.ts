/**
 * Safe Utility Functions
 *
 * Defensive programming utilities to prevent null/undefined errors
 */

/**
 * Safely converts a number to locale string
 * Returns "0" if value is null, undefined, or NaN
 */
export function safeToLocaleString(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) {
    return '0';
  }
  return value.toLocaleString();
}

/**
 * Safely gets a number value with a default fallback
 */
export function safeNumber(value: number | null | undefined, defaultValue: number = 0): number {
  if (value === null || value === undefined || isNaN(value)) {
    return defaultValue;
  }
  return value;
}

/**
 * Safely gets a string value with a default fallback
 */
export function safeString(value: string | null | undefined, defaultValue: string = ''): string {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  return value;
}

/**
 * Safely formats a date string
 * Returns default value if date is invalid
 */
export function safeDate(
  value: string | Date | null | undefined,
  defaultValue: string = 'N/A'
): string {
  if (!value) return defaultValue;

  try {
    const date = typeof value === 'string' ? new Date(value) : value;
    if (isNaN(date.getTime())) {
      return defaultValue;
    }
    return date.toLocaleDateString();
  } catch {
    return defaultValue;
  }
}

/**
 * Safely formats a datetime string
 */
export function safeDateTime(
  value: string | Date | null | undefined,
  defaultValue: string = 'N/A'
): string {
  if (!value) return defaultValue;

  try {
    const date = typeof value === 'string' ? new Date(value) : value;
    if (isNaN(date.getTime())) {
      return defaultValue;
    }
    return date.toLocaleString();
  } catch {
    return defaultValue;
  }
}

/**
 * Safely access nested object properties
 * Returns default value if path doesn't exist
 */
export function safeGet<T>(
  obj: unknown,
  path: string,
  defaultValue: T
): T {
  if (!obj) return defaultValue;

  const keys = path.split('.');
  let result: unknown = obj;

  for (const key of keys) {
    if (result === null || typeof result !== 'object' || !(key in result)) {
      return defaultValue;
    }
    result = (result as Record<string, unknown>)[key];
  }

  return result === null || result === undefined ? defaultValue : result as T;
}

/**
 * Safely parse JSON with fallback
 */
export function safeJsonParse<T>(
  json: string | null | undefined,
  defaultValue: T
): T {
  if (!json) return defaultValue;

  try {
    return JSON.parse(json);
  } catch {
    return defaultValue;
  }
}

/**
 * Safely format currency
 */
export function safeCurrency(
  value: number | null | undefined,
  currency: string = 'USDC'
): string {
  const num = safeNumber(value, 0);
  return `${num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} ${currency}`;
}

/**
 * Type guard to check if value is not null/undefined
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Filter array removing null/undefined values
 */
export function filterDefined<T>(array: (T | null | undefined)[]): T[] {
  return array.filter(isDefined);
}
