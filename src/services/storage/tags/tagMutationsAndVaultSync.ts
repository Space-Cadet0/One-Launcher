import type { UserTagOverride, UserTagOverridesMap } from '../../../contracts/tags';
import {
  nextMonotonicIsoTimestamp,
  normalizeSafeIdKey,
  parseIsoTimestampMs,
} from '../storageRuntimeUtils';
import {
  dispatchUserTagOverridesUpdatedEvent,
  loadUserTagOverridesFromStore,
  persistUserTagOverridesMapToStorage,
} from './tagEnvelopeAndStore';
import { getUserTagOverrideForGame } from './tagLookupIndex';
import {
  expandAliasLookupVariants,
  extractGameTagPlatformAliases,
  getEquivalentTagKeys,
  MAX_USER_TAGS_PER_ARRAY,
  normalizeTagKey,
  sanitizeTagLabel,
  sanitizeUserTagOverride,
  type TagOverrideGameIdentity,
} from './tagSanitizerAndAliases';

function pruneAliasesFromSiblingRecords(
  current: UserTagOverridesMap,
  ownerGameId: string,
  aliasesToPrune?: readonly string[]
): { mutated: boolean; updatedSiblings: UserTagOverride[] } {
  if (!Array.isArray(aliasesToPrune) || aliasesToPrune.length === 0) {
    return { mutated: false, updatedSiblings: [] };
  }

  const pruneVariantSet = new Set<string>();
  for (const alias of aliasesToPrune) {
    for (const variant of expandAliasLookupVariants(alias)) {
      pruneVariantSet.add(variant);
      pruneVariantSet.add(variant.toLowerCase());
    }
  }
  if (pruneVariantSet.size === 0) {
    return { mutated: false, updatedSiblings: [] };
  }

  let mutated = false;
  const updatedBySiblingId = new Map<string, UserTagOverride>();
  const seenSiblings = new Set<string>();

  for (const rec of Object.values(current)) {
    if (!rec || !rec.gameId || rec.gameId === ownerGameId || seenSiblings.has(rec.gameId)) {
      continue;
    }
    seenSiblings.add(rec.gameId);
    if (!Array.isArray(rec.platformAliases) || rec.platformAliases.length === 0) {
      continue;
    }
    const filteredAliases = rec.platformAliases.filter((alias) => {
      const variants = expandAliasLookupVariants(alias);
      return !variants.some((v) => pruneVariantSet.has(v) || pruneVariantSet.has(v.toLowerCase()));
    });
    if (filteredAliases.length !== rec.platformAliases.length) {
      mutated = true;
      const updatedSibling: UserTagOverride = {
        ...rec,
        platformAliases: filteredAliases.length > 0 ? filteredAliases : undefined,
        updatedAt: nextMonotonicIsoTimestamp(rec.updatedAt),
      };
      updatedBySiblingId.set(rec.gameId, updatedSibling);
    }
  }

  for (const [key, rec] of Object.entries(current)) {
    if (!rec || !rec.gameId || rec.gameId === ownerGameId) continue;

    if (
      key !== rec.gameId &&
      (pruneVariantSet.has(key) || pruneVariantSet.has(key.toLowerCase()))
    ) {
      delete current[key];
      mutated = true;
      continue;
    }

    const updatedSibling = updatedBySiblingId.get(rec.gameId);
    if (updatedSibling) {
      current[key] = updatedSibling;
    }
  }

  return {
    mutated,
    updatedSiblings: Array.from(updatedBySiblingId.values()),
  };
}

function syncSiblingsToOfflineVault(siblings: readonly UserTagOverride[]): void {
  if (
    siblings.length === 0 ||
    typeof window === 'undefined' ||
    typeof window.electronAPI?.offlineVault?.saveUserTagOverride !== 'function'
  ) {
    return;
  }
  for (const sibling of siblings) {
    try {
      const ipcPayload: UserTagOverride = {
        ...sibling,
        platformAliases: Array.isArray(sibling.platformAliases) ? sibling.platformAliases : [],
      };
      void window.electronAPI.offlineVault
        .saveUserTagOverride(sibling.gameId, ipcPayload)
        ?.catch?.(() => {});
    } catch (vaultErr) {
      console.warn('Failed to sync pruned sibling user tag override to offlineVault:', vaultErr);
    }
  }
}

/**
 * Rebinds a canonical record and its current aliases in `targetMap`, removing any stale
 * alias pointers that previously referenced the same `gameId`.
 */
function rebindCanonicalTagRecord(
  targetMap: UserTagOverridesMap,
  record: UserTagOverride
): void {
  for (const [k, existingRec] of Object.entries(targetMap)) {
    if (k !== record.gameId && existingRec && existingRec.gameId === record.gameId) {
      delete targetMap[k];
    }
  }
  targetMap[record.gameId] = record;
  if (Array.isArray(record.platformAliases)) {
    for (const alias of record.platformAliases) {
      const existingAtAlias = Object.hasOwn(targetMap, alias) ? targetMap[alias] : undefined;
      // Never overwrite another game's canonical record if `alias` collides with a `gameId`
      if (!existingAtAlias || existingAtAlias.gameId !== alias) {
        targetMap[alias] = record;
      }
    }
  }
}

/**
 * Persists a canonical `UserTagOverride` keyed strictly under `override.gameId` with ONLY
 * `override.platformAliases`, pruning overlapping aliases from sibling split-game records
 * without mutating those sibling records' own tags or `user_overrides.json`.
 */
export function saveUserTagOverride(
  override: UserTagOverride,
  options?: { silentEvent?: boolean }
): UserTagOverride | null {
  if (!override || !override.gameId) return null;
  const sanitized = sanitizeUserTagOverride(override.gameId, {
    ...override,
    updatedAt: override.updatedAt || new Date().toISOString(),
  });
  if (!sanitized) return null;

  if (sanitized.addedTags.length === 0 && sanitized.removedTags.length === 0) {
    removeUserTagOverride(sanitized.gameId, {
      pruneSiblingAliases: sanitized.platformAliases,
      silentEvent: options?.silentEvent,
    });
    return null;
  }

  try {
    const current: UserTagOverridesMap = { ...loadUserTagOverridesFromStore() };

    // Prune aliases claimed by `sanitized` from any sibling records (`F7` split-game isolation)
    const pruned = pruneAliasesFromSiblingRecords(
      current,
      sanitized.gameId,
      sanitized.platformAliases
    );

    rebindCanonicalTagRecord(current, sanitized);

    persistUserTagOverridesMapToStorage(current);

    if (!options?.silentEvent) {
      dispatchUserTagOverridesUpdatedEvent({ gameId: sanitized.gameId });
    }

    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.offlineVault?.saveUserTagOverride === 'function'
    ) {
      try {
        void window.electronAPI.offlineVault
          .saveUserTagOverride(sanitized.gameId, sanitized)
          ?.catch?.(() => {});
      } catch (vaultErr) {
        console.warn('Failed to sync user tag override to offlineVault:', vaultErr);
      }
    }
    syncSiblingsToOfflineVault(pruned.updatedSiblings);

    return sanitized;
  } catch (err) {
    console.error('Failed to save user tag override:', err);
    return null;
  }
}

/**
 * Removes a `UserTagOverride` by canonical `gameId` (and any explicitly supplied `aliasKeys`),
 * optionally pruning `pruneSiblingAliases` from sibling records while leaving sibling tags intact.
 */
export function removeUserTagOverride(
  gameId: string,
  options?: { aliasKeys?: string[]; pruneSiblingAliases?: readonly string[]; silentEvent?: boolean }
): boolean {
  const safeId = normalizeSafeIdKey(gameId);
  if (!safeId) return false;

  try {
    const current: UserTagOverridesMap = { ...loadUserTagOverridesFromStore() };
    const extraDeleteSet = new Set<string>();
    if (Array.isArray(options?.aliasKeys)) {
      for (const k of options.aliasKeys) {
        const safe = normalizeSafeIdKey(k);
        if (safe && safe !== safeId) {
          extraDeleteSet.add(safe);
        }
      }
    }

    let removedAny = false;
    for (const [k, rec] of Object.entries(current)) {
      if (
        k === safeId ||
        (rec && rec.gameId === safeId) ||
        extraDeleteSet.has(k) ||
        (rec && rec.gameId && extraDeleteSet.has(rec.gameId))
      ) {
        delete current[k];
        removedAny = true;
      }
    }

    const pruned = pruneAliasesFromSiblingRecords(
      current,
      safeId,
      options?.pruneSiblingAliases
    );

    if (removedAny || pruned.mutated) {
      persistUserTagOverridesMapToStorage(current);
      if (!options?.silentEvent) {
        dispatchUserTagOverridesUpdatedEvent({ gameId: safeId });
      }
    }

    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.offlineVault?.removeUserTagOverride === 'function'
    ) {
      try {
        void window.electronAPI.offlineVault
          .removeUserTagOverride({
            gameId: safeId,
            ...(extraDeleteSet.size > 0 ? { aliasKeys: Array.from(extraDeleteSet) } : {}),
          })
          ?.catch?.(() => {});
      } catch (vaultErr) {
        console.warn('Failed to remove user tag override in offlineVault:', vaultErr);
      }
    }
    syncSiblingsToOfflineVault(pruned.updatedSiblings);

    return removedAny || pruned.mutated;
  } catch (err) {
    console.error('Failed to remove user tag override:', err);
    return false;
  }
}

/**
 * Adds a user tag (or restores a previously removed synced tag) for `game`.
 * On write, keys strictly under `game.id` and records ONLY `platformAliases` currently present on `game`.
 */
export function addUserTagForGame(
  game: TagOverrideGameIdentity,
  rawTag: string,
  currentSyncedTags?: readonly string[]
): UserTagOverride | null {
  const gameId = normalizeSafeIdKey(game?.id);
  const label = sanitizeTagLabel(rawTag);
  const key = label.toLowerCase();
  if (!gameId || !label || !key) {
    return getUserTagOverrideForGame(game) ?? null;
  }

  const existing = getUserTagOverrideForGame(game);
  const equivKeys = new Set(getEquivalentTagKeys(key));

  const nextAdded = existing ? [...existing.addedTags] : [];
  const nextRemoved = existing
    ? existing.removedTags.filter((t) => !equivKeys.has(normalizeTagKey(t)))
    : [];

  const wasRemoved = existing
    ? existing.removedTags.some((t) => equivKeys.has(normalizeTagKey(t)))
    : false;

  const existingAddedIdx = nextAdded.findIndex((t) => normalizeTagKey(t) === key);
  const matchingSyncedTag = Array.isArray(currentSyncedTags)
    ? currentSyncedTags.find((t) => equivKeys.has(normalizeTagKey(t)))
    : undefined;

  if (existingAddedIdx >= 0) {
    // Update user display casing in place
    nextAdded[existingAddedIdx] = label;
  } else if (wasRemoved && matchingSyncedTag && matchingSyncedTag === label) {
    // Simply un-hiding a previously removed synced tag with identical casing restores it cleanly
  } else if (!wasRemoved && matchingSyncedTag && matchingSyncedTag === label) {
    // Tag is already active on the game with identical casing — no redundant user delta needed
    if (!existing || existing.gameId === gameId) {
      return existing ?? null;
    }
  } else if (nextAdded.length < MAX_USER_TAGS_PER_ARRAY) {
    nextAdded.push(label);
  }

  if (nextAdded.length === 0 && nextRemoved.length === 0) {
    removeUserTagOverride(gameId, {
      pruneSiblingAliases: extractGameTagPlatformAliases(game),
    });
    return null;
  }

  const record: UserTagOverride = {
    gameId,
    platformAliases: extractGameTagPlatformAliases(game),
    addedTags: nextAdded,
    removedTags: nextRemoved,
    updatedAt: nextMonotonicIsoTimestamp(existing?.updatedAt),
  };
  return saveUserTagOverride(record);
}

/**
 * Removes a tag from `game`: deletes it from `addedTags`, and if present in `currentSyncedTags`
 * (or when `currentSyncedTags` is omitted and the tag wasn't user-added), records it in `removedTags`
 * so future storefront syncs cannot resurrect it. Automatically deletes empty delta records.
 */
export function removeUserTagForGame(
  game: TagOverrideGameIdentity,
  rawTag: string,
  currentSyncedTags?: readonly string[]
): UserTagOverride | null {
  const gameId = normalizeSafeIdKey(game?.id);
  const label = sanitizeTagLabel(rawTag);
  const key = label.toLowerCase();
  if (!gameId || !label || !key) {
    return getUserTagOverrideForGame(game) ?? null;
  }

  const existing = getUserTagOverrideForGame(game);
  const equivKeys = new Set(getEquivalentTagKeys(key));

  const hadInAdded = existing
    ? existing.addedTags.some((t) => normalizeTagKey(t) === key)
    : false;
  const nextAdded = existing
    ? existing.addedTags.filter((t) => normalizeTagKey(t) !== key)
    : [];
  const nextRemoved = existing ? [...existing.removedTags] : [];

  const existsInSynced = Array.isArray(currentSyncedTags)
    ? currentSyncedTags.some((t) => equivKeys.has(normalizeTagKey(t)))
    : !hadInAdded;

  if (existsInSynced) {
    const alreadyInRemoved = nextRemoved.some((t) => normalizeTagKey(t) === key);
    if (!alreadyInRemoved && nextRemoved.length < MAX_USER_TAGS_PER_ARRAY) {
      nextRemoved.push(label);
    }
  }

  if (nextAdded.length === 0 && nextRemoved.length === 0) {
    removeUserTagOverride(gameId, {
      pruneSiblingAliases: extractGameTagPlatformAliases(game),
    });
    return null;
  }

  const record: UserTagOverride = {
    gameId,
    platformAliases: extractGameTagPlatformAliases(game),
    addedTags: nextAdded,
    removedTags: nextRemoved,
    updatedAt: nextMonotonicIsoTimestamp(existing?.updatedAt),
  };
  return saveUserTagOverride(record);
}

/**
 * Resets all user tag edits for `game` back to synced defaults.
 * Preserves sibling split-game records: only deletes `game.id` plus any legacy alias-matched record
 * whose entire `platformAliases` set is a strict subset of `game`'s own current aliases, while
 * pruning `game`'s current aliases from remaining sibling records so split games cannot resurrect
 * tags from a former merged parent (`F7`).
 */
export function resetUserTagsForGame(game: TagOverrideGameIdentity): boolean {
  const gameId = normalizeSafeIdKey(game?.id);
  if (!gameId) return false;

  const map = loadUserTagOverridesFromStore();
  const currentAliasesList = extractGameTagPlatformAliases(game);
  const currentAliases = new Set(currentAliasesList);
  const subsumedLegacyIds: string[] = [];

  if (currentAliases.size > 0) {
    const seen = new Set<string>();
    for (const rec of Object.values(map)) {
      if (!rec || !rec.gameId || rec.gameId === gameId || seen.has(rec.gameId)) continue;
      seen.add(rec.gameId);
      const recAliases = Array.isArray(rec.platformAliases) ? rec.platformAliases : [];
      if (recAliases.length > 0 && recAliases.every((a) => currentAliases.has(a))) {
        subsumedLegacyIds.push(rec.gameId);
      }
    }
  }

  return removeUserTagOverride(gameId, {
    aliasKeys: subsumedLegacyIds,
    pruneSiblingAliases: currentAliasesList,
  });
}

let inFlightVaultTagSync: Promise<boolean> | null = null;

/**
 * Reconciles canonical `UserTagOverride` records between renderer `localStorage` and Electron
 * `offlineVault` (`user_tag_overrides.json`) using newest-`updatedAt`-wins resolution,
 * pruning stale aliases when a newer vault record overwrites an older local record.
 */
export async function hydrateUserTagOverridesFromVault(): Promise<boolean> {
  if (inFlightVaultTagSync) {
    return inFlightVaultTagSync;
  }
  if (
    typeof window === 'undefined' ||
    typeof window.electronAPI?.offlineVault?.getUserTagOverrides !== 'function'
  ) {
    return false;
  }

  inFlightVaultTagSync = (async (): Promise<boolean> => {
    try {
      const vaultRaw = await window.electronAPI!.offlineVault!.getUserTagOverrides!();
      const localMap: UserTagOverridesMap = { ...loadUserTagOverridesFromStore() };

      const canonicalLocal: Record<string, UserTagOverride> = {};
      for (const [key, rec] of Object.entries(localMap)) {
        const clean = sanitizeUserTagOverride(key, rec);
        if (!clean || (clean.addedTags.length === 0 && clean.removedTags.length === 0)) continue;
        const prev = Object.hasOwn(canonicalLocal, clean.gameId)
          ? canonicalLocal[clean.gameId]
          : undefined;
        if (!prev || parseIsoTimestampMs(clean.updatedAt) >= parseIsoTimestampMs(prev.updatedAt)) {
          canonicalLocal[clean.gameId] = clean;
        }
      }

      const canonicalVault: Record<string, UserTagOverride> = {};
      if (vaultRaw && typeof vaultRaw === 'object' && !Array.isArray(vaultRaw)) {
        for (const [key, rawRec] of Object.entries(vaultRaw)) {
          const clean = sanitizeUserTagOverride(key, rawRec);
          if (!clean || (clean.addedTags.length === 0 && clean.removedTags.length === 0)) continue;
          const prev = Object.hasOwn(canonicalVault, clean.gameId)
            ? canonicalVault[clean.gameId]
            : undefined;
          if (
            !prev ||
            parseIsoTimestampMs(clean.updatedAt) >= parseIsoTimestampMs(prev.updatedAt)
          ) {
            canonicalVault[clean.gameId] = clean;
          }
        }
      }

      const hydratedGameIds: string[] = [];
      for (const [gameId, vaultRec] of Object.entries(canonicalVault)) {
        const localRec = Object.hasOwn(canonicalLocal, gameId)
          ? canonicalLocal[gameId]
          : undefined;
        const vaultTs = parseIsoTimestampMs(vaultRec.updatedAt);
        const localTs = localRec ? parseIsoTimestampMs(localRec.updatedAt) : -1;
        if (!localRec || vaultTs > localTs) {
          // Prune stale aliases belonging to the overwritten gameId and any overlapping sibling aliases
          pruneAliasesFromSiblingRecords(localMap, gameId, vaultRec.platformAliases);
          rebindCanonicalTagRecord(localMap, vaultRec);
          hydratedGameIds.push(gameId);
        }
      }

      const missingOrNewerForVault: Record<string, UserTagOverride> = {};
      for (const [gameId, localRec] of Object.entries(canonicalLocal)) {
        const vaultRec = Object.hasOwn(canonicalVault, gameId)
          ? canonicalVault[gameId]
          : undefined;
        const localTs = parseIsoTimestampMs(localRec.updatedAt);
        const vaultTs = vaultRec ? parseIsoTimestampMs(vaultRec.updatedAt) : -1;
        if (!vaultRec || localTs > vaultTs) {
          missingOrNewerForVault[gameId] = localRec;
        }
      }

      if (hydratedGameIds.length > 0) {
        persistUserTagOverridesMapToStorage(localMap);
        dispatchUserTagOverridesUpdatedEvent({
          gameId: hydratedGameIds.length === 1 ? hydratedGameIds[0] : undefined,
          hydratedFromVault: true,
        });
      }

      const pushIds = Object.keys(missingOrNewerForVault);
      if (
        pushIds.length > 0 &&
        typeof window.electronAPI?.offlineVault?.saveUserTagOverride === 'function'
      ) {
        try {
          const batchRes = await window.electronAPI.offlineVault.saveUserTagOverride({
            batchOverrides: missingOrNewerForVault,
          });
          if (!batchRes || batchRes.success === false) {
            for (const [id, rec] of Object.entries(missingOrNewerForVault)) {
              await window.electronAPI.offlineVault
                .saveUserTagOverride(id, rec)
                ?.catch?.(() => {});
            }
          }
        } catch {
          for (const [id, rec] of Object.entries(missingOrNewerForVault)) {
            await window.electronAPI.offlineVault
              .saveUserTagOverride(id, rec)
              ?.catch?.(() => {});
          }
        }
      }

      return hydratedGameIds.length > 0 || pushIds.length > 0;
    } catch {
      return false;
    } finally {
      inFlightVaultTagSync = null;
    }
  })();

  return inFlightVaultTagSync;
}
