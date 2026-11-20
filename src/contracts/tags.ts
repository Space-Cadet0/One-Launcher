export interface UserTagOverride {
  gameId: string;
  platformAliases?: string[];
  addedTags: string[];
  removedTags: string[];
  updatedAt: string;
}

export type UserTagOverridesMap = Record<string, UserTagOverride>;

export interface TagFacetCount {
  key: string;
  label: string;
  count: number;
}

export interface ResolvedGameTag {
  label: string;
  key: string;
  source: 'user' | 'synced';
}

export interface ResolvedGameTagsResult {
  tags: string[];
  entries: ResolvedGameTag[];
  syncedTags: string[];
  userAddedTags: string[];
  hasUserEdits: boolean;
}

export interface RemoveUserTagOverrideOptions {
  gameId?: string;
  id?: string;
  aliasKeys?: string[];
  aliases?: string[];
  platformAliases?: string[];
}

export interface SaveUserTagOverrideBatchPayload {
  batchOverrides: Record<string, UserTagOverride>;
}

export interface UserTagOverrideMutationResult {
  success: boolean;
  gameId?: string;
  override?: UserTagOverride;
  overrides?: Record<string, UserTagOverride>;
  count?: number;
  error?: string;
}
