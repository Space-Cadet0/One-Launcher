import type { UserTagOverridesMap } from '../../contracts/tags';
import { isTestEnv } from './storageRuntimeUtils';
import {
  getUserTagOverridesRevision,
  loadUserTagOverridesFromStore,
  STORAGE_KEY_USER_TAG_OVERRIDES,
  USER_TAG_OVERRIDES_UPDATED_EVENT,
} from './tags/tagEnvelopeAndStore';
import { getUserTagOverrideForGame } from './tags/tagLookupIndex';
import {
  addUserTagForGame,
  hydrateUserTagOverridesFromVault,
  removeUserTagForGame,
  removeUserTagOverride,
  resetUserTagsForGame,
  saveUserTagOverride,
} from './tags/tagMutationsAndVaultSync';
import {
  extractGameTagPlatformAliases,
  MAX_USER_TAG_LENGTH,
  MAX_USER_TAG_PLATFORM_ALIASES,
  MAX_USER_TAGS_PER_ARRAY,
  normalizeTagKey,
  sanitizeTagLabel,
  type TagOverrideGameIdentity,
} from './tags/tagSanitizerAndAliases';

export {
  STORAGE_KEY_USER_TAG_OVERRIDES,
  USER_TAG_OVERRIDES_UPDATED_EVENT,
  MAX_USER_TAG_LENGTH,
  MAX_USER_TAGS_PER_ARRAY,
  MAX_USER_TAG_PLATFORM_ALIASES,
  type TagOverrideGameIdentity,
  sanitizeTagLabel,
  normalizeTagKey,
  extractGameTagPlatformAliases,
  getUserTagOverridesRevision,
  getUserTagOverrideForGame,
  saveUserTagOverride,
  removeUserTagOverride,
  addUserTagForGame,
  removeUserTagForGame,
  resetUserTagsForGame,
  hydrateUserTagOverridesFromVault,
};

/**
 * Loads all user tag overrides from `localStorage` (with in-memory caching).
 * Declared directly on the facade module so `vi.spyOn(userTagStorage, 'loadUserTagOverrides')`
 * intercepts catalog-wide preloading cleanly.
 */
export function loadUserTagOverrides(): UserTagOverridesMap {
  return loadUserTagOverridesFromStore();
}

if (
  !isTestEnv() &&
  typeof window !== 'undefined' &&
  typeof window.electronAPI?.offlineVault?.getUserTagOverrides === 'function'
) {
  void hydrateUserTagOverridesFromVault().catch(() => {});
}
