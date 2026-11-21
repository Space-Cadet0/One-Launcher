const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
const UNIX_SECONDS_THRESHOLD = 10_000_000_000;

/**
 * Parses any timestamp representation (Unix seconds, Unix milliseconds, ISO 8601 string, or number)
 * into a valid millisecond epoch timestamp. Returns null if unparseable, non-finite, out-of-range, or <= 0.
 */
export function parseTimestampMs(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === '' || value === 'Never' || value === 0 || value === '0') {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Values less than 10 billion are Unix timestamps in seconds (up to year 2286)
    const ms = value < UNIX_SECONDS_THRESHOLD ? value * 1000 : value;
    return Number.isFinite(ms) && ms > 0 && ms <= MAX_VALID_DATE_MS ? ms : null;
  }

  const str = String(value).trim();
  if (!str) return null;

  if (/^\d+$/.test(str)) {
    const num = Number(str);
    if (!Number.isFinite(num) || num <= 0) return null;
    const ms = num < UNIX_SECONDS_THRESHOLD ? num * 1000 : num;
    return Number.isFinite(ms) && ms > 0 && ms <= MAX_VALID_DATE_MS ? ms : null;
  }

  const parsed = Date.parse(str);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_VALID_DATE_MS) {
    return parsed;
  }

  return null;
}

/**
 * Formats a last played timestamp into human-readable date (e.g. "14 Sep, 2024").
 * Returns "Never" if null/zero/invalid.
 */
export function formatLastPlayedDate(value: string | number | undefined | null): string {
  const ms = parseTimestampMs(value);
  if (ms === null) return 'Never';

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'Never';
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
  if (minutes === undefined || minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
    return '0 hrs';
  }
  if (minutes < 60) {
    return `${minutes} mins`;
  }
  const hours = (minutes / 60).toFixed(1);
  return `${hours.endsWith('.0') ? parseInt(hours, 10) : hours} hrs`;
}
