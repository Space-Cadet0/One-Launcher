/**
 * OpenCritic & Critic Score Integration Service
 * Re-exports from unified CriticScoreService with verified scores and zero fabrication.
 */

export type {
  CriticTier,
  CriticSource,
  CriticScoreData,
  OpenCriticTier,
  OpenCriticData,
} from '../../contracts/critic';

export {
  calculateTier,
  getTierColor,
  KNOWN_CRITIC_SCORES,
  KNOWN_CRITIC_SCORES as OPENCRITIC_DATABASE,
  KNOWN_UNRATED_TITLES,
  normalizeCriticTitleKey,
  criticScoreService,
  getOpenCriticData,
} from '../critic/criticScoreService';
