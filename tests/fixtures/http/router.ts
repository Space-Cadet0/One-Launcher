import { handleEpicAndLutrisEndpoints } from './epicAndLutrisFixtures';
import { handleGogEndpoints } from './gogFixtures';
import {
  handleMetacriticComposer,
  handleMetacriticSearch,
  handleMetacriticWeb,
} from './metacriticFixtures';
import { handleOpenCriticApi, handleOpenCriticWeb } from './openCriticFixtures';
import { handleSteamCommunityAndApi, handleSteamStore } from './steamFixtures';
import { FixtureRequest, FixtureResponse, OfflineNetworkGuardError } from './types';
import { handleWikidataEndpoints } from './wikidataFixtures';

export function resolveOfflineFixture(req: FixtureRequest): FixtureResponse {
  const host = req.url.hostname.toLowerCase();

  let matched: FixtureResponse | null = null;

  if (host === 'www.metacritic.com' || host === 'metacritic.com') {
    matched = handleMetacriticWeb(req);
  } else if (host === 'backend.metacritic.com') {
    matched = handleMetacriticComposer(req) ?? handleMetacriticSearch(req);
  } else if (host === 'api.opencritic.com') {
    matched = handleOpenCriticApi(req);
  } else if (host === 'opencritic.com' || host === 'www.opencritic.com') {
    matched = handleOpenCriticWeb(req);
  } else if (
    host === 'query.wikidata.org' ||
    host === 'www.wikidata.org' ||
    host === 'wikidata.org'
  ) {
    matched = handleWikidataEndpoints(req);
  } else if (host === 'store.steampowered.com') {
    matched = handleSteamStore(req);
  } else if (host === 'steamcommunity.com' || host === 'api.steampowered.com') {
    matched = handleSteamCommunityAndApi(req);
  } else if (
    host === 'catalog.gog.com' ||
    host === 'api.gog.com' ||
    host === 'www.gog.com' ||
    host === 'auth.gog.com' ||
    host === 'gameplay.gog.com' ||
    host === 'content-system.gog.com'
  ) {
    matched = handleGogEndpoints(req);
  } else if (
    host === 'launcher.store.epicgames.com' ||
    host === 'store-content.ak.epicgames.com' ||
    host === 'account-public-service-prod03.ol.epicgames.com' ||
    host === 'api.epicgames.dev' ||
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
