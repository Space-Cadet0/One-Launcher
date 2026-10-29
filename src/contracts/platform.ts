export type StorefrontId =
  | 'steam'
  | 'gog'
  | 'epic'
  | 'amazon'
  | 'xbox'
  | 'ubisoft'
  | 'ea'
  | 'bnet'
  | 'itch'
  | 'rockstar'
  | 'humble'
  | 'custom';

export interface StorefrontMetadata {
  id: StorefrontId;
  name: string;
  icon: string;
  brandColor: string;
  badgeBg: string;
  badgeText: string;
  tier: 1 | 2 | 3;
}

export const STOREFRONT_REGISTRY: Record<StorefrontId, StorefrontMetadata> = {
  steam: {
    id: 'steam',
    name: 'Steam',
    icon: 'Steam',
    brandColor: '#171a21',
    badgeBg: 'bg-[#171a21]/80 border-[#2a475e]',
    badgeText: 'text-[#66c0f4]',
    tier: 1,
  },
  gog: {
    id: 'gog',
    name: 'GOG Galaxy',
    icon: 'Compass',
    brandColor: '#5c1e7a',
    badgeBg: 'bg-[#5c1e7a]/40 border-[#8e3ebc]',
    badgeText: 'text-[#d78bff]',
    tier: 1,
  },
  epic: {
    id: 'epic',
    name: 'Epic Games',
    icon: 'Gamepad2',
    brandColor: '#2f2f2f',
    badgeBg: 'bg-[#2b2b2b] border-[#555555]',
    badgeText: 'text-[#ffffff]',
    tier: 1,
  },
  amazon: {
    id: 'amazon',
    name: 'Amazon Prime',
    icon: 'Package',
    brandColor: '#00a8e1',
    badgeBg: 'bg-[#003852]/60 border-[#00a8e1]/60',
    badgeText: 'text-[#00c8ff]',
    tier: 1,
  },
  xbox: {
    id: 'xbox',
    name: 'Xbox / Game Pass',
    icon: 'Tv',
    brandColor: '#107c10',
    badgeBg: 'bg-[#107c10]/30 border-[#107c10]',
    badgeText: 'text-[#52d652]',
    tier: 1,
  },
  ubisoft: {
    id: 'ubisoft',
    name: 'Ubisoft Connect',
    icon: 'Boxes',
    brandColor: '#0070ff',
    badgeBg: 'bg-[#003980]/50 border-[#0070ff]',
    badgeText: 'text-[#66b0ff]',
    tier: 2,
  },
  ea: {
    id: 'ea',
    name: 'EA App',
    icon: 'Sparkles',
    brandColor: '#ff4747',
    badgeBg: 'bg-[#5c1010]/40 border-[#ff4747]/70',
    badgeText: 'text-[#ff7878]',
    tier: 2,
  },
  bnet: {
    id: 'bnet',
    name: 'Battle.net',
    icon: 'Flame',
    brandColor: '#00a2ff',
    badgeBg: 'bg-[#002f5c]/60 border-[#00a2ff]',
    badgeText: 'text-[#7ad3ff]',
    tier: 2,
  },
  itch: {
    id: 'itch',
    name: 'Itch.io',
    icon: 'Dices',
    brandColor: '#fa5c5c',
    badgeBg: 'bg-[#4d1616]/50 border-[#fa5c5c]/60',
    badgeText: 'text-[#ff9494]',
    tier: 3,
  },
  rockstar: {
    id: 'rockstar',
    name: 'Rockstar Games',
    icon: 'Star',
    brandColor: '#fcaf17',
    badgeBg: 'bg-[#4a3407]/50 border-[#fcaf17]/70',
    badgeText: 'text-[#fcd268]',
    tier: 3,
  },
  humble: {
    id: 'humble',
    name: 'Humble Bundle',
    icon: 'Gift',
    brandColor: '#cb2026',
    badgeBg: 'bg-[#451012]/50 border-[#cb2026]/70',
    badgeText: 'text-[#ff757a]',
    tier: 3,
  },
  custom: {
    id: 'custom',
    name: 'Custom / DRM-Free',
    icon: 'HardDrive',
    brandColor: '#71717a',
    badgeBg: 'bg-[#27272a] border-[#52525b]',
    badgeText: 'text-[#a1a1aa]',
    tier: 3,
  },
};

export interface RawImportedGame {
  platformId: StorefrontId;
  platformGameId: string;
  title: string;
  installed: boolean;
  installPath?: string;
  playtimeMinutes?: number;
  lastPlayed?: string;
  steamAppIdHint?: number;
}

export interface StorefrontAdapter {
  readonly platformId: StorefrontId;
  readonly displayName: string;
  scanLocalManifests(): Promise<RawImportedGame[]>;
  fetchCloudLibrary?(credentials?: Record<string, string>): Promise<RawImportedGame[]>;
}
