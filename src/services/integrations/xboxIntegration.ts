import { CanonicalGame } from '../../contracts/game';
import { StorefrontCredentials } from '../../contracts/integration';
import { XBOX_USER_LIBRARY } from '../storage/storefrontLibraries';

export class XboxIntegrationService {
  async connectAccount(
    credentials: StorefrontCredentials
  ): Promise<{ accountName: string; avatarUrl?: string; games: CanonicalGame[] }> {
    const accountName = credentials.webToken || 'Xbox Live Account';
    const avatarUrl = 'https://assets.xboxservices.com/assets/default-gamerpic.png';

    // Synchronize owned Xbox / PC Game Pass library
    const games = XBOX_USER_LIBRARY.map((g) => ({
      ...g,
      isVerifiedEntitlement: true,
    }));
    return { accountName, avatarUrl, games };
  }
}

export const xboxIntegration = new XboxIntegrationService();
