export interface GameCollection {
  id: string;
  name: string;
  icon?: string;
  gameIds: string[];
  isDefault?: boolean;
}
