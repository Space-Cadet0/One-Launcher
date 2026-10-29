/**
 * Parses any timestamp representation (Unix seconds, Unix milliseconds, ISO 8601 string, or number)
 * into a valid millisecond epoch timestamp. Returns null if unparseable or zero.
 */
export function parseTimestampMs(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === '' || value === 'Never' || value === 0 || value === '0') {
    return null;
  }

  if (typeof value === 'number') {
    if (value <= 0) return null;
    // Values less than 10 billion are Unix timestamps in seconds (up to year 2286)
    return value < 10000000000 ? value * 1000 : value;
  }

  const str = String(value).trim();
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    if (num <= 0) return null;
    return num < 10000000000 ? num * 1000 : num;
  }

  const parsed = Date.parse(str);
  if (!isNaN(parsed) && parsed > 0) {
    return parsed;
  }

  return null;
}

/**
 * Formats a last played timestamp into human-readable date (e.g. "14 Sep, 2024").
 * Returns "Never" if null/zero.
 */
export function formatLastPlayedDate(value: string | number | undefined | null): string {
  const ms = parseTimestampMs(value);
  if (!ms) return 'Never';

  const date = new Date(ms);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Formats playtime in minutes to readable hours (e.g. "113.3 hrs", "30 mins", "0 hrs").
 */
export function formatPlaytime(minutes: number | undefined | null): string {
  if (!minutes || minutes <= 0) return '0 hrs';
  if (minutes < 60) return `${minutes} mins`;
  const hours = (minutes / 60).toFixed(1);
  return `${hours.endsWith('.0') ? parseInt(hours, 10) : hours} hrs`;
}
