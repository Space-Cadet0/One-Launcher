import React from 'react';
import {
  Star,
  Play,
  Clock,
  Trophy,
  Gamepad2,
  Heart,
  Flame,
  Zap,
  Sword,
  Shield,
  Crown,
  Rocket,
  Compass,
  Puzzle,
  Skull,
  Ghost,
  Sparkles,
  Gem,
  Target,
  Bookmark,
  Award,
  Globe,
  Layers,
  Folder,
} from 'lucide-react';

export interface CollectionIconOption {
  id: string;
  label: string;
  colorClass: string;
  activeColorClass: string;
}

export const COLLECTION_ICON_OPTIONS: CollectionIconOption[] = [
  { id: 'star', label: 'Star', colorClass: 'text-amber-400', activeColorClass: 'text-amber-400 fill-amber-400' },
  { id: 'play', label: 'Play', colorClass: 'text-emerald-400', activeColorClass: 'text-emerald-400 fill-emerald-400' },
  { id: 'clock', label: 'Clock', colorClass: 'text-blue-400', activeColorClass: 'text-blue-400' },
  { id: 'trophy', label: 'Trophy', colorClass: 'text-purple-400', activeColorClass: 'text-purple-400' },
  { id: 'gamepad', label: 'Gamepad', colorClass: 'text-cyan-400', activeColorClass: 'text-cyan-400' },
  { id: 'heart', label: 'Heart', colorClass: 'text-rose-400', activeColorClass: 'text-rose-400 fill-rose-400' },
  { id: 'flame', label: 'Flame', colorClass: 'text-orange-400', activeColorClass: 'text-orange-400 fill-orange-400' },
  { id: 'zap', label: 'Bolt', colorClass: 'text-yellow-400', activeColorClass: 'text-yellow-400 fill-yellow-400' },
  { id: 'sword', label: 'Sword', colorClass: 'text-red-400', activeColorClass: 'text-red-400' },
  { id: 'shield', label: 'Shield', colorClass: 'text-indigo-400', activeColorClass: 'text-indigo-400' },
  { id: 'crown', label: 'Crown', colorClass: 'text-amber-300', activeColorClass: 'text-amber-300 fill-amber-300' },
  { id: 'rocket', label: 'Rocket', colorClass: 'text-sky-400', activeColorClass: 'text-sky-400' },
  { id: 'compass', label: 'Compass', colorClass: 'text-teal-400', activeColorClass: 'text-teal-400' },
  { id: 'puzzle', label: 'Puzzle', colorClass: 'text-pink-400', activeColorClass: 'text-pink-400' },
  { id: 'skull', label: 'Skull', colorClass: 'text-slate-300', activeColorClass: 'text-slate-300' },
  { id: 'ghost', label: 'Ghost', colorClass: 'text-violet-300', activeColorClass: 'text-violet-300' },
  { id: 'sparkles', label: 'Sparkles', colorClass: 'text-fuchsia-400', activeColorClass: 'text-fuchsia-400' },
  { id: 'gem', label: 'Gem', colorClass: 'text-cyan-300', activeColorClass: 'text-cyan-300' },
  { id: 'target', label: 'Target', colorClass: 'text-red-500', activeColorClass: 'text-red-500' },
  { id: 'bookmark', label: 'Bookmark', colorClass: 'text-blue-300', activeColorClass: 'text-blue-300 fill-blue-300' },
  { id: 'award', label: 'Award', colorClass: 'text-yellow-500', activeColorClass: 'text-yellow-500' },
  { id: 'globe', label: 'Globe', colorClass: 'text-emerald-300', activeColorClass: 'text-emerald-300' },
  { id: 'layers', label: 'Layers', colorClass: 'text-indigo-300', activeColorClass: 'text-indigo-300' },
  { id: 'folder', label: 'Folder', colorClass: 'text-slate-400', activeColorClass: 'text-slate-300' },
];

const VALID_ICON_IDS = new Set(COLLECTION_ICON_OPTIONS.map((o) => o.id));

export function getEffectiveCollectionIconId(col: { id: string; icon?: string }): string {
  if (col.icon && VALID_ICON_IDS.has(col.icon)) {
    return col.icon;
  }
  switch (col.id) {
    case 'favorites':
      return 'star';
    case 'currently-playing':
      return 'play';
    case 'backlog':
      return 'clock';
    case 'completed':
      return 'trophy';
    default:
      return 'folder';
  }
}

export interface CollectionIconProps {
  iconId?: string;
  collectionId?: string;
  size?: number;
  className?: string;
}

export const CollectionIcon: React.FC<CollectionIconProps> = ({
  iconId,
  collectionId = '',
  size = 14,
  className = '',
}) => {
  const effectiveId = getEffectiveCollectionIconId({ id: collectionId, icon: iconId });
  const option =
    COLLECTION_ICON_OPTIONS.find((o) => o.id === effectiveId) ||
    COLLECTION_ICON_OPTIONS[COLLECTION_ICON_OPTIONS.length - 1];
  const combinedClass = `shrink-0 ${option.activeColorClass} ${className}`.trim();

  switch (effectiveId) {
    case 'star':
      return <Star size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'play':
      return <Play size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'clock':
      return <Clock size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'trophy':
      return <Trophy size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'gamepad':
      return <Gamepad2 size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'heart':
      return <Heart size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'flame':
      return <Flame size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'zap':
      return <Zap size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'sword':
      return <Sword size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'shield':
      return <Shield size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'crown':
      return <Crown size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'rocket':
      return <Rocket size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'compass':
      return <Compass size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'puzzle':
      return <Puzzle size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'skull':
      return <Skull size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'ghost':
      return <Ghost size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'sparkles':
      return <Sparkles size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'gem':
      return <Gem size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'target':
      return <Target size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'bookmark':
      return <Bookmark size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'award':
      return <Award size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'globe':
      return <Globe size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'layers':
      return <Layers size={size} className={combinedClass} data-collection-icon={effectiveId} />;
    case 'folder':
    default:
      return <Folder size={size} className={combinedClass} data-collection-icon="folder" />;
  }
};
