import React from 'react';

export interface StoreFeatureIconProps {
  categoryId?: number;
  description?: string;
  className?: string;
}

type FeatureIconKind =
  | 'single_player'
  | 'multi_player'
  | 'pvp'
  | 'coop'
  | 'lan'
  | 'split_screen'
  | 'cross_platform'
  | 'achievements'
  | 'controller'
  | 'trading_cards'
  | 'workshop'
  | 'captions'
  | 'in_app_purchases'
  | 'cloud'
  | 'anti_cheat'
  | 'stats'
  | 'leaderboards'
  | 'hdr'
  | 'family_sharing'
  | 'remote_play'
  | 'vr';

const CATEGORY_ID_TO_KIND: Record<number, FeatureIconKind> = {
  1: 'multi_player', // Multi-player
  2: 'single_player', // Single-player
  8: 'anti_cheat', // Valve Anti-Cheat enabled
  9: 'coop', // Co-op
  13: 'captions', // Captions available
  15: 'stats', // Stats
  16: 'workshop', // Includes Source SDK
  17: 'workshop', // Includes level editor
  18: 'controller', // Partial Controller Support
  20: 'multi_player', // MMO
  22: 'achievements', // Steam Achievements
  23: 'cloud', // Steam Cloud
  24: 'split_screen', // Shared/Split Screen
  25: 'leaderboards', // Steam Leaderboards
  27: 'cross_platform', // Cross-Platform Multiplayer
  28: 'controller', // Full controller support
  29: 'trading_cards', // Steam Trading Cards
  30: 'workshop', // Steam Workshop
  31: 'vr', // VR Support
  32: 'cloud', // Steam Turn Notifications
  35: 'in_app_purchases', // In-App Purchases
  36: 'pvp', // Online PvP
  37: 'split_screen', // Shared/Split Screen PvP
  38: 'coop', // Online Co-op
  39: 'split_screen', // Shared/Split Screen Co-op
  40: 'vr', // SteamVR Collectibles
  41: 'remote_play', // Remote Play on Phone
  42: 'remote_play', // Remote Play on Tablet
  43: 'remote_play', // Remote Play on TV
  44: 'remote_play', // Remote Play Together
  47: 'lan', // LAN PvP
  48: 'lan', // LAN Co-op
  49: 'pvp', // PvP
  51: 'workshop', // Steam Workshop
  52: 'vr', // Tracked Controller Support
  53: 'vr', // VR Supported
  54: 'vr', // VR Only
  55: 'controller',
  56: 'controller',
  57: 'controller',
  58: 'controller',
  59: 'controller',
  60: 'controller',
  61: 'hdr', // HDR available
  62: 'family_sharing', // Family Sharing
};

function resolveFeatureIconKind(categoryId?: number, description?: string): FeatureIconKind {
  if (typeof categoryId === 'number' && CATEGORY_ID_TO_KIND[categoryId]) {
    return CATEGORY_ID_TO_KIND[categoryId];
  }

  const norm = (description || '').trim().toLowerCase();
  if (!norm) return 'single_player';

  if (norm.includes('achievement')) return 'achievements';
  if (norm.includes('cloud')) return 'cloud';
  if (norm.includes('controller') || norm.includes('gamepad') || norm.includes('steam input')) {
    return 'controller';
  }
  if (norm.includes('hdr')) return 'hdr';
  if (norm.includes('family sharing')) return 'family_sharing';
  if (norm.includes('remote play')) return 'remote_play';
  if (norm.includes('trading card')) return 'trading_cards';
  if (norm.includes('workshop') || norm.includes('mod') || norm.includes('level editor') || norm.includes('sdk')) {
    return 'workshop';
  }
  if (norm.includes('caption') || norm.includes('subtitle')) return 'captions';
  if (norm.includes('in-app purchase') || norm.includes('microtransaction')) {
    return 'in_app_purchases';
  }
  if (norm.includes('anti-cheat') || norm.includes('vac')) return 'anti_cheat';
  if (norm.includes('leaderboard')) return 'leaderboards';
  if (norm.includes('stat')) return 'stats';
  if (/\bvr\b|virtual reality|tracked controller/.test(norm)) return 'vr';
  if (norm.includes('cross-platform') || norm.includes('crossplay')) return 'cross_platform';
  if (norm.includes('split screen') || norm.includes('shared/split')) return 'split_screen';
  if (/\blan\b/.test(norm)) return 'lan';
  if (norm.includes('pvp')) return 'pvp';
  if (norm.includes('co-op') || norm.includes('coop')) return 'coop';
  if (norm.includes('multi-player') || norm.includes('multiplayer') || norm.includes('mmo')) {
    return 'multi_player';
  }
  if (norm.includes('single-player') || norm.includes('singleplayer')) return 'single_player';

  return 'single_player';
}

export const StoreFeatureIcon: React.FC<StoreFeatureIconProps> = ({
  categoryId,
  description,
  className = 'w-4 h-4 text-[#66c0f4] group-hover:text-white transition-colors shrink-0',
}) => {
  const kind = resolveFeatureIconKind(categoryId, description);

  const svgProps = {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    'data-feature-icon': kind,
  };

  switch (kind) {
    case 'single_player':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="8" r="4" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      );
    case 'multi_player':
    case 'coop':
      return (
        <svg {...svgProps}>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M3 20a6 6 0 0 1 12 0" />
          <circle cx="17" cy="9" r="2.75" />
          <path d="M15.5 20a5 5 0 0 1 5.5-4.75" />
        </svg>
      );
    case 'pvp':
      return (
        <svg {...svgProps}>
          <path d="M14.5 17.5 3 6V3h3l11.5 11.5" />
          <path d="m13 19 6-6" />
          <path d="m16 16 4 4" />
          <path d="m19 21 2-2" />
          <path d="M9.5 17.5 21 6V3h-3L6.5 14.5" />
          <path d="m11 19-6-6" />
          <path d="m8 16-4 4" />
          <path d="m5 21-2-2" />
        </svg>
      );
    case 'lan':
      return (
        <svg {...svgProps}>
          <rect x="9" y="3" width="6" height="5" rx="1" />
          <rect x="3" y="16" width="6" height="5" rx="1" />
          <rect x="15" y="16" width="6" height="5" rx="1" />
          <path d="M12 8v4m-6 4v-4h12v4" />
        </svg>
      );
    case 'split_screen':
      return (
        <svg {...svgProps}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="12" y1="4" x2="12" y2="20" />
        </svg>
      );
    case 'cross_platform':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18" />
          <path d="M12 3a14 14 0 0 0 0 18" />
        </svg>
      );
    case 'achievements':
      return (
        <svg {...svgProps}>
          <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
          <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
          <path d="M4 22h16" />
          <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
          <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
          <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
        </svg>
      );
    case 'controller':
      return (
        <svg {...svgProps}>
          <line x1="6" y1="12" x2="10" y2="12" />
          <line x1="8" y1="10" x2="8" y2="14" />
          <circle cx="15" cy="13" r="0.8" fill="currentColor" />
          <circle cx="18" cy="11" r="0.8" fill="currentColor" />
          <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z" />
        </svg>
      );
    case 'trading_cards':
      return (
        <svg {...svgProps}>
          <rect x="4" y="4" width="11" height="15" rx="1.5" />
          <path d="M9 4h10a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20h-4" />
        </svg>
      );
    case 'workshop':
      return (
        <svg {...svgProps}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case 'captions':
      return (
        <svg {...svgProps}>
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M10 10.5a2 2 0 1 0 0 3" />
          <path d="M16 10.5a2 2 0 1 0 0 3" />
        </svg>
      );
    case 'in_app_purchases':
      return (
        <svg {...svgProps}>
          <circle cx="8" cy="20" r="1.5" />
          <circle cx="18" cy="20" r="1.5" />
          <path d="M2.5 3h2.5l2.4 11.5a1.5 1.5 0 0 0 1.5 1.2h8.8a1.5 1.5 0 0 0 1.4-1.1L21 7H6" />
        </svg>
      );
    case 'cloud':
      return (
        <svg {...svgProps}>
          <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
        </svg>
      );
    case 'anti_cheat':
      return (
        <svg {...svgProps}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case 'stats':
      return (
        <svg {...svgProps}>
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      );
    case 'leaderboards':
      return (
        <svg {...svgProps}>
          <path d="M8 21v-7H3v7h5Z" />
          <path d="M14.5 21V9h-5v12h5Z" />
          <path d="M21 21v-9h-5v9h5Z" />
          <path d="m12 3 1.2 2.4L16 5.8l-2 1.9.5 2.7L12 9.1 9.5 10.4l.5-2.7-2-1.9 2.8-.4L12 3Z" />
        </svg>
      );
    case 'hdr':
      return (
        <svg {...svgProps}>
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M6 9.5v5M9 9.5v5M6 12h3" />
          <path d="M11.5 9.5v5h1.5a2 2 0 0 0 2-2v-1a2 2 0 0 0-2-2h-1.5Z" />
          <path d="M17 14.5v-5h1.5a1.25 1.25 0 0 1 0 2.5H17m1.2 0 1.3 2.5" />
        </svg>
      );
    case 'family_sharing':
      return (
        <svg {...svgProps}>
          <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Z" />
          <circle cx="12" cy="12.5" r="2.2" />
          <path d="M8.5 18a3.8 3.8 0 0 1 7 0" />
        </svg>
      );
    case 'remote_play':
      return (
        <svg {...svgProps}>
          <rect x="2" y="4" width="20" height="14" rx="2" />
          <path d="M2 14a6 6 0 0 1 6 6" />
          <path d="M2 10a10 10 0 0 1 10 10" />
          <circle cx="3" cy="19" r="1" fill="currentColor" />
        </svg>
      );
    case 'vr':
      return (
        <svg {...svgProps}>
          <rect x="2" y="7" width="20" height="10" rx="3" />
          <path d="M9.5 17 11 14h2l1.5 3" />
          <circle cx="7.5" cy="12" r="1.5" />
          <circle cx="16.5" cy="12" r="1.5" />
        </svg>
      );
  }
};
