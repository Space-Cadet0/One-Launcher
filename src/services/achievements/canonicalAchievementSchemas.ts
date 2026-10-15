import { DetailedAchievement } from '../../contracts/achievement';
import { StorefrontId } from '../../contracts/platform';

export const KNOWN_GAMES_WITHOUT_ACHIEVEMENTS = new Set<string>();

export const BALDURS_GATE_2_ACHIEVEMENTS: Array<{
  apiName: string;
  name: string;
  description: string;
  iconHash: string;
  pct: number;
  isSecret?: boolean;
}> = [];

export const ALAN_WAKE_2_ACHIEVEMENTS: Array<{
  name: string;
  description: string;
  pct: number;
  isSecret?: boolean;
}> = [];

export function buildBaldursGate2Achievements(_storefrontId: StorefrontId = 'steam'): DetailedAchievement[] {
  return [];
}

export function buildAlanWake2Achievements(): DetailedAchievement[] {
  return [];
}
