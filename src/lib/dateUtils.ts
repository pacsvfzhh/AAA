/**
 * Date utility functions for consistent UTC time handling across the application
 *
 * All date filtering should use UTC to match the database server timezone
 * and ensure consistent behavior across different user timezones.
 */

/**
 * Get the start of today in UTC (midnight UTC)
 * @returns ISO string representing midnight UTC today (e.g., "2025-11-02T00:00:00.000Z")
 */
export function getTodayStartUTC(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();

  const todayStart = new Date(Date.UTC(year, month, date, 0, 0, 0, 0));
  return todayStart.toISOString();
}

/**
 * Get the start of tomorrow in UTC (midnight UTC tomorrow)
 * @returns ISO string representing midnight UTC tomorrow
 */
export function getTomorrowStartUTC(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();

  const tomorrowStart = new Date(Date.UTC(year, month, date + 1, 0, 0, 0, 0));
  return tomorrowStart.toISOString();
}

/**
 * Get the start of a specific date in UTC
 * @param date - Date object or ISO string
 * @returns ISO string representing midnight UTC on that date
 */
export function getDateStartUTC(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const dateNum = d.getUTCDate();

  const dateStart = new Date(Date.UTC(year, month, dateNum, 0, 0, 0, 0));
  return dateStart.toISOString();
}

/**
 * Check if a date/timestamp is today (UTC)
 * @param dateStr - ISO timestamp string
 * @returns true if the date is today in UTC
 */
export function isToday(dateStr: string): boolean {
  const today = getTodayStartUTC();
  const tomorrow = getTomorrowStartUTC();

  return dateStr >= today && dateStr < tomorrow;
}

/**
 * Get current timestamp in ISO format
 * @returns Current timestamp as ISO string
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Format a date/timestamp as MM/DD/YYYY in UTC
 * @param dateStr - ISO timestamp string or Date object
 * @returns Formatted date string (e.g., "11/02/2025")
 */
export function formatDateUTC(dateStr: string | Date): string {
  const date = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${month}/${day}/${year}`;
}

/**
 * Format a date/timestamp as time in UTC (12-hour format)
 * @param dateStr - ISO timestamp string or Date object
 * @returns Formatted time string (e.g., "03:45 PM")
 */
export function formatTimeUTC(dateStr: string | Date): string {
  const date = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
  const hours = date.getUTCHours();
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${String(displayHours).padStart(2, '0')}:${minutes} ${period}`;
}

/**
 * Format a date/timestamp as full datetime in UTC
 * @param dateStr - ISO timestamp string or Date object
 * @returns Formatted datetime string (e.g., "11/02/2025, 03:45 PM")
 */
export function formatDateTimeUTC(dateStr: string | Date): string {
  return `${formatDateUTC(dateStr)}, ${formatTimeUTC(dateStr)}`;
}
