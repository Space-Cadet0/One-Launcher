export interface EpicCodenameMapping {
  title: string;
  steamAppId?: number;
  developer?: string;
  description?: string;
  headerImage?: string;
  capsuleImage?: string;
  iconUrl?: string;
}

export const KNOWN_EPIC_APP_NAMES: Record<string, EpicCodenameMapping> = {};

/**
 * Known internal Epic Store project codenames that do not map to standalone user-facing games
 * (e.g. trial branches, closed tests, or unmapped internal project aliases).
 */
export const UNMAPPED_EPIC_INTERNAL_CODENAMES: ReadonlySet<string> = new Set([
  'bobcat',
  'boxfish',
  'calluna',
  'catnip',
  'cormorant',
  'hazelnut',
  'hazlenut',
  'herring',
  'boga',
  'barbet',
  'basil',
  'batfish',
  'batfishs2',
  'blobfish',
  'speedwell',
  'wombat',
  'blackcoral',
  'blunderbuss',
  'boysenberry',
  'brilliantrose',
  'cadmiumred',
  'capsicum',
  'alabaster',
  'kingletaztec',
]);

