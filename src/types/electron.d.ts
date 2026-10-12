import type { CanonicalGame } from '../contracts/game';

export interface ElectronAPI {
  isElectron: boolean;
  loginStore: (storefrontId: string) => Promise<any>;
  syncStore: (storefrontId: string) => Promise<{ success: boolean; games?: CanonicalGame[]; error?: string }>;
  exchangeCode: (storefrontId: string, code: string) => Promise<any>;
  getSavedTokens: () => Promise<Record<string, any>>;
  clearTokens: (storefrontId: string) => Promise<void>;
  scanLocalGames: () => Promise<{ success: boolean; installedSteamAppIds?: number[]; installedGames?: any[]; error?: string }>;
  scanSteamAchievements: () => Promise<{ success: boolean; achievements?: Record<number, any>; error?: string }>;
  openExternal: (url: string) => Promise<boolean>;
  searchHltb: (title: string) => Promise<{ success: boolean; data?: any[]; error?: string }>;
  fetchEpicAchievements: (accountId: string, accessToken?: string) => Promise<Record<string, any>>;
  fetchIgdbCover: (title: string) => Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
