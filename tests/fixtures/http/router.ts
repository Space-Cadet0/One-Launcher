import { handleEpicAndLutrisEndpoints } from './epicAndLutrisFixtures';
import { handleGogEndpoints } from './gogFixtures';
import { handleMetacriticSearch, handleMetacriticWeb } from './metacriticFixtures';
import { handleOpenCriticApi } from './openCriticFixtures';
import { handleSteamCommunityAndApi, handleSteamStore } from './steamFixtures';
import { FixtureRequest, FixtureResponse, OfflineNetworkGuardError } from './types';

export function resolveOfflineFixture(req: FixtureRequest): FixtureResponse {
  const host = req.url.hostname.toLowerCase();

  let matched: FixtureResponse | null = null;

  if (host === 'www.metacritic.com' || host === 'metacritic.com') {
    matched = handleMetacriticWeb(req);
  } else if (host === 'backend.metacritic.com') {
    matched = handleMetacriticSearch(req);
  } else if (host === 'api.opencritic.com') {
    matched = handleOpenCriticApi(req);
  } else if (host === 'store.steampowered.com') {
    matched = handleSteamStore(req);
  } else if (host === 'steamcommunity.com' || host === 'api.steampowered.com') {
    matched = handleSteamCommunityAndApi(req);
  } else if (
    host === 'catalog.gog.com' ||
    host === 'api.gog.com' ||
    host === 'www.gog.com' ||
    host === 'auth.gog.com' ||
    host === 'gameplay.gog.com'
  ) {
    matched = handleGogEndpoints(req);
  } else if (
    host === 'launcher.store.epicgames.com' ||
    host === 'store-content.ak.epicgames.com' ||
    host === 'account-public-service-prod03.ol.epicgames.com' ||
    host === 'lutris.net'
  ) {
    matched = handleEpicAndLutrisEndpoints(req);
  } else if (host === 'local-system.onelauncher.internal') {
    matched = {
      status: 200,
      body: { success: true, achievements: {}, installedGames: [], games: [] },
    };
  }

  if (!matched) {
    throw new OfflineNetworkGuardError(req.rawUrl, req.method);
  }

  return matched;
}
