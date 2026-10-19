export type FilterType =
  | 'developer'
  | 'publisher'
  | 'genre'
  | 'tag'
  | 'feature'
  | 'opencritic'
  | 'rating'
  | 'critic'
  | 'review'
  | 'franchise'
  | 'platform'
  | 'os'
  | 'status';

export interface ActiveGameFilter {
  type: FilterType;
  label: string; // e.g. 'Developer', 'Publisher', 'Genre', 'Tag', 'Feature', 'Rating', 'Reviews', 'Native OS'
  value: string; // e.g. 'Larian Studios', 'HDR available', 'Mighty', 'Mostly Positive', 'RPG', 'mac', 'windows'
}
