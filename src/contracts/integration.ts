import { StorefrontId } from './platform';

export type AuthMethod =
  | 'web_api'
  | 'web_auth'
  | 'public_profile'
  | 'oauth'
  | 'local_client';

export interface StorefrontCredentials {
  steamId?: string;
  apiKey?: string;
  profileUrl?: string;
  vanityUrl?: string;
  webToken?: string;
  gogUsername?: string;
  gogToken?: string;
  epicAccountId?: string;
  epicToken?: string;
  epicRefreshToken?: string;
  epicTokenExpiresAt?: string | number;
}

export interface StorefrontIntegration {
  storefrontId: StorefrontId;
  name: string;
  isConnected: boolean;
  accountName?: string;
  accountId?: string;
  avatarUrl?: string;
  gamesCount: number;
  lastSyncedAt?: string;
  authMethod?: AuthMethod;
  credentials?: StorefrontCredentials;
  statusMessage?: string;
}

export interface SyncResult {
  success: boolean;
  storefrontId: StorefrontId;
  gamesCount: number;
  message?: string;
}
