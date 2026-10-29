import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Explicitly allowlisted mathematical base constants and synthetic test fixture SteamID64s.
 * Every real personal 17-digit SteamID64 (`7656119...`) outside this set is rejected.
 */
export const ALLOWED_SYNTHETIC_STEAM_IDS: ReadonlySet<string> = new Set([
  '76561197960265728', // Valve 64-bit SteamID base constant (0x0110000100000000)
  '76561197960265729', // Minimum mathematical SteamID64 bound (base + 1)
  '76561198000000000',
  '76561198000000001',
  '76561198000000002',
  '76561198000000042',
  '76561198012345678',
  '76561198099999999',
]);

/**
 * Explicitly allowlisted sequential/synthetic 32-hex Epic account_id test fixtures.
 */
export const ALLOWED_SYNTHETIC_EPIC_ACCOUNT_IDS: ReadonlySet<string> = new Set([
  'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  'a0b1c2d3e4f5061728394a5b6c7d8e9f',
  '0123456789abcdef0123456789abcdef',
  'fedcba9876543210fedcba9876543210',
]);

/**
 * Structural pattern for obviously synthetic 32-hex Epic account IDs
 * (e.g., 16+ leading zeros/ones, repeated 'a'/'f', deadbeef/cafebabe, or zero-filled middle).
 */
export const SYNTHETIC_EPIC_ACCOUNT_HEX_REGEX =
  /^(?:0{16,}|1{16,}|a{8,}|f{8,}|deadbeef|cafebabe|[0-9a-f]{4}0000000000000000)[0-9a-f]*$/i;

export interface LocalKeyedHmacConfig {
  key: Buffer;
  blockedHmacs: ReadonlySet<string>;
}

const STEAM_ID64_REGEX = /\b7656119\d{10}\b/g;
const GOG_REAL_USER_ID_REGEX = /\b4968\d{13}\b/g;
const EPIC_ACCOUNT_HEX_ASSIGNMENT_REGEX =
  /["']?(?:account_id|epicAccountId|accountId|in_app_id)["']?\s*[:=]\s*["']([0-9a-fA-F]{32})["']/g;
const STEAM3_BRACKET_ID_REGEX = /\[U:1:\d{5,10}\]/g;
const STEAM_USERDATA_PATH_REGEX =
  /Steam[\\/]userdata[\\/](?!12345678\b|123456789\b|999999\b|111111\b|222222\b|424242\b|100\b|200\b)\d{6,10}\b/gi;

const MAC_PERSONAL_HOME_REGEX =
  /(?<![a-zA-Z0-9.:/])\/Users\/(?!Shared\b|(?:test|player|mock|fake|sample|synthetic|demo|portable)[^\s\\/]*|user\b|runner\b|admin\b|crossover\b|example\b|guest\b)[a-zA-Z0-9._-]{3,}\//i;
const LINUX_PERSONAL_HOME_REGEX =
  /(?<![a-zA-Z0-9.:/])\/home\/(?!runner\b|(?:test|player|mock|fake|sample|synthetic|demo|portable)[^\s\\/]*|user\b|admin\b|crossover\b|example\b|guest\b|deck\b|steam\b|ubuntu\b|linux\b)[a-zA-Z0-9._-]{3,}\//i;
const WINDOWS_PERSONAL_HOME_REGEX =
  /C:(?:\\+|\/)Users(?:\\+|\/)(?!Public\b|Default\b|All Users\b|(?:test|player|mock|fake|sample|synthetic|demo|portable)[^\s\\/]*|user\b|runner\b|admin\b|crossover\b|example\b|guest\b|WDAGUtilityAccount\b)[a-zA-Z0-9._-]{3,}(?:\\+|\/)/i;
const DARWIN_PRIVATE_TEMP_BUCKET_REGEX =
  /var[\\/]folders[\\/][a-z0-9]{2}[\\/][a-z0-9_]{10,}/i;

const PERSONAL_WEBMAIL_REGEX =
  /@(?:(?:gmail|googlemail|outlook|hotmail|live|icloud|yahoo|protonmail)\.com|proton\.me)\b/i;
const HARDCODED_BEARER_TOKEN_REGEX = /Bearer [A-Za-z0-9+/=_.-]{25,}/;

const SKIPPED_WALK_DIRS = new Set(['node_modules', 'dist', '.git', 'release']);

export function walkHygieneFiles(
  targetPath: string,
  extRegex: RegExp,
  acc: string[] = []
): string[] {
  if (!fs.existsSync(targetPath)) return acc;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    if (extRegex.test(path.basename(targetPath))) {
      acc.push(targetPath);
    }
    return acc;
  }
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (SKIPPED_WALK_DIRS.has(entry.name)) continue;
    const full = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      walkHygieneFiles(full, extRegex, acc);
    } else if (entry.isFile() && extRegex.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Loads optional developer-local keyed HMAC-SHA256 PII guard configuration from
 * untracked `.pii-guard.local.json` or `ONE_LAUNCHER_PII_HMAC_KEY` + `ONE_LAUNCHER_PII_HMAC_TAGS`.
 * Zero personal hashes, salts, or keys are ever committed to the repository.
 */
export function loadLocalKeyedHmacConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): LocalKeyedHmacConfig | null {
  let keyBuf: Buffer | null = null;
  const blocked = new Set<string>();

  const localJsonPath = path.join(repoRoot, '.pii-guard.local.json');
  if (fs.existsSync(localJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(localJsonPath, 'utf8')) as {
        hmacKeyHex?: unknown;
        blockedHmacs?: unknown;
      };
      if (typeof parsed.hmacKeyHex === 'string' && parsed.hmacKeyHex.trim().length > 0) {
        const trimmedKey = parsed.hmacKeyHex.trim();
        keyBuf = /^[0-9a-f]{32,}$/i.test(trimmedKey) && trimmedKey.length % 2 === 0
          ? Buffer.from(trimmedKey, 'hex')
          : Buffer.from(trimmedKey, 'utf8');
      }
      if (Array.isArray(parsed.blockedHmacs)) {
        for (const tag of parsed.blockedHmacs) {
          if (typeof tag === 'string' && tag.trim().length > 0) {
            blocked.add(tag.trim().toLowerCase());
          }
        }
      }
    } catch {
      // Ignore malformed local untracked config
    }
  }

  const envKey = env.ONE_LAUNCHER_PII_HMAC_KEY?.trim();
  const envTags = env.ONE_LAUNCHER_PII_HMAC_TAGS?.trim();
  if (envKey) {
    keyBuf = /^[0-9a-f]{32,}$/i.test(envKey) && envKey.length % 2 === 0
      ? Buffer.from(envKey, 'hex')
      : Buffer.from(envKey, 'utf8');
  }
  if (envTags) {
    if (envTags.startsWith('[')) {
      try {
        const arr = JSON.parse(envTags) as unknown[];
        if (Array.isArray(arr)) {
          for (const t of arr) {
            if (typeof t === 'string' && t.trim()) blocked.add(t.trim().toLowerCase());
          }
        }
      } catch {
        // Fall back to delimiter split below
      }
    }
    if (blocked.size === 0 || !envTags.startsWith('[')) {
      for (const part of envTags.split(/[\s,;]+/)) {
        if (part.trim()) blocked.add(part.trim().toLowerCase());
      }
    }
  }

  if (!keyBuf || keyBuf.length === 0 || blocked.size === 0) {
    return null;
  }

  return { key: keyBuf, blockedHmacs: blocked };
}

export function isAllowedSyntheticEpicAccountHex(hex32: string): boolean {
  const lower = hex32.trim().toLowerCase();
  return (
    ALLOWED_SYNTHETIC_EPIC_ACCOUNT_IDS.has(lower) ||
    SYNTHETIC_EPIC_ACCOUNT_HEX_REGEX.test(lower)
  );
}

/**
 * Scans a single file's text content for structural PII, personal paths, webmail literals,
 * hardcoded Bearer tokens, and (if locally configured) keyed HMAC-SHA256 matches.
 */
export function scanContentForPiiViolations(
  content: string,
  relPath: string,
  hmacConfig?: LocalKeyedHmacConfig | null
): string[] {
  const normalizedRel = relPath.replace(/\\/g, '/');
  const violations: string[] = [];

  // (a) Structural Storefront Account ID Bans
  for (const match of content.matchAll(STEAM_ID64_REGEX)) {
    if (!ALLOWED_SYNTHETIC_STEAM_IDS.has(match[0])) {
      violations.push(
        `${normalizedRel}: non-synthetic 17-digit SteamID64 literal (${match[0]})`
      );
    }
  }

  for (const match of content.matchAll(GOG_REAL_USER_ID_REGEX)) {
    violations.push(
      `${normalizedRel}: real-range 17-digit GOG user_id literal (${match[0]})`
    );
  }

  for (const match of content.matchAll(EPIC_ACCOUNT_HEX_ASSIGNMENT_REGEX)) {
    const hexId = match[1];
    if (!isAllowedSyntheticEpicAccountHex(hexId)) {
      violations.push(
        `${normalizedRel}: non-synthetic 32-hex Epic account identifier (${hexId.slice(0, 4)}...${hexId.slice(-4)})`
      );
    }
  }

  if (STEAM3_BRACKET_ID_REGEX.test(content)) {
    violations.push(`${normalizedRel}: Steam3 personal account identifier ([U:1:...])`);
  }

  if (STEAM_USERDATA_PATH_REGEX.test(content)) {
    violations.push(`${normalizedRel}: non-synthetic Steam userdata/<accountId32> path`);
  }

  // (b) Universal Personal Home Path & Temp Bucket Bans
  if (MAC_PERSONAL_HOME_REGEX.test(content)) {
    violations.push(`${normalizedRel}: macOS non-synthetic home path (/Users/<non-synthetic>/)`);
  }

  if (LINUX_PERSONAL_HOME_REGEX.test(content)) {
    violations.push(`${normalizedRel}: Linux non-synthetic home path (/home/<non-synthetic>/)`);
  }

  if (WINDOWS_PERSONAL_HOME_REGEX.test(content)) {
    violations.push(
      `${normalizedRel}: Windows non-synthetic home path (C:\\Users\\<non-synthetic>\\)`
    );
  }

  if (DARWIN_PRIVATE_TEMP_BUCKET_REGEX.test(content)) {
    violations.push(`${normalizedRel}: Darwin private temp bucket path (var/folders/...)`);
  }

  // (c) Personal Webmail & Hardcoded Bearer Token Bans
  if (PERSONAL_WEBMAIL_REGEX.test(content)) {
    violations.push(`${normalizedRel}: personal webmail address literal`);
  }

  if (
    /^(?:src|electron|scripts)\//.test(normalizedRel) &&
    HARDCODED_BEARER_TOKEN_REGEX.test(content)
  ) {
    violations.push(`${normalizedRel}: hardcoded Bearer token in runtime/script source`);
  }

  // (e) Optional Local Keyed HMAC-SHA256 Guard (0 bits committed in repo)
  if (hmacConfig && hmacConfig.blockedHmacs.size > 0) {
    const candidateTokens = content.match(/\b[a-z0-9][a-z0-9._@-]{2,63}\b/gi) || [];
    const checked = new Set<string>();
    for (const rawTok of candidateTokens) {
      const lowerTok = rawTok.toLowerCase();
      if (checked.has(lowerTok)) continue;
      checked.add(lowerTok);
      const tag = crypto
        .createHmac('sha256', hmacConfig.key)
        .update(lowerTok)
        .digest('hex');
      if (hmacConfig.blockedHmacs.has(tag)) {
        violations.push(`${normalizedRel}: matched local keyed HMAC-SHA256 PII guard`);
      }
    }
  }

  return violations;
}

/**
 * Walks all specified repo targets and returns any zero-oracle PII or hygiene violations.
 */
export function scanRepoForPiiViolations(
  repoRoot: string,
  targets: string[],
  extRegex: RegExp,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const hmacConfig = loadLocalKeyedHmacConfig(repoRoot, env);
  const violations: string[] = [];

  for (const target of targets) {
    const files = walkHygieneFiles(path.join(repoRoot, target), extRegex);
    for (const file of files) {
      const rel = path.relative(repoRoot, file);
      const content = fs.readFileSync(file, 'utf8');
      violations.push(...scanContentForPiiViolations(content, rel, hmacConfig));
    }
  }

  return violations;
}

/**
 * Checks workspace root (`fs.readdirSync(repoRoot)`) for polluted Windows drive-letter
 * (`C:...`, `D:...`) or backslash (`\var\folders\...`) directory/file entries.
 */
export function scanWorkspaceRootForPollutedEntries(
  repoRoot: string,
  entriesOverride?: string[]
): string[] {
  const entries = Array.isArray(entriesOverride)
    ? entriesOverride
    : fs.existsSync(repoRoot)
      ? fs.readdirSync(repoRoot)
      : [];
  return entries.filter((entry) => entry.includes('\\') || /^[A-Za-z]:/.test(entry));
}
