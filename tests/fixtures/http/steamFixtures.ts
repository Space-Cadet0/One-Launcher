import { FixtureRequest, FixtureResponse } from './types';

function renderBg2CommunityHtml(): string {
  const rows: string[] = [
    `<div class="achieveRow "><img src="https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/257350/ach_escape.jpg"><h3>A Daring Escape</h3><h5>Escape from the dungeon of the wizard Irenicus.</h5><div class="achievePercent">32.0%</div></div>`,
  ];
  for (let i = 2; i <= 93; i++) {
    rows.push(
      `<div class="achieveRow "><img src="https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/257350/ach_${i}.jpg"><h3>Amnian Valor ${i}</h3><h5>Complete heroic milestone ${i} in Amn.</h5><div class="achievePercent">${Math.max(1.5, Math.round((40 - i * 0.35) * 10) / 10)}%</div></div>`
    );
  }
  return `<!DOCTYPE html><html><body>${rows.join('\n')}</body></html>`;
}

interface SteamAppFixture {
  appId: number;
  name: string;
  releaseYear: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  shortDescription?: string;
  metacriticScore?: number;
  metacriticUrl?: string;
  totalPositive?: number;
  totalNegative?: number;
}

const STEAM_APPS: SteamAppFixture[] = [
  { appId: 220, name: 'Half-Life 2', releaseYear: '2004', developers: ['Valve'], publishers: ['Valve'], genres: ['Action'], metacriticScore: 96, metacriticUrl: 'https://www.metacritic.com/game/pc/half-life-2?ftag=MCD-06-10aaa1f', totalPositive: 185000, totalNegative: 4500 },
  { appId: 2320, name: 'Quake II', releaseYear: '1997', developers: ['id Software'], publishers: ['Bethesda Softworks'], genres: ['Action'], metacriticScore: 85, metacriticUrl: 'https://www.metacritic.com/game/pc/quake-ii', totalPositive: 6200, totalNegative: 320 },
  { appId: 6060, name: 'STAR WARS™ Battlefront™ II (Classic, 2005)', releaseYear: '2005', developers: ['Pandemic Studios'], genres: ['Action'], metacriticScore: 83, metacriticUrl: 'https://www.metacritic.com/game/pc/star-wars-battlefront-ii-2005', totalPositive: 46000, totalNegative: 2400 },
  { appId: 6920, name: 'Deus Ex: Invisible War', releaseYear: '2003', developers: ['Ion Storm'], genres: ['RPG'], metacriticScore: 80, metacriticUrl: 'https://www.metacritic.com/game/pc/deus-ex-invisible-war', totalPositive: 1900, totalNegative: 720 },
  { appId: 22380, name: 'Fallout: New Vegas', releaseYear: '2010', developers: ['Obsidian Entertainment'], genres: ['RPG'], metacriticScore: 84, metacriticUrl: 'https://www.metacritic.com/game/pc/fallout-new-vegas', totalPositive: 172000, totalNegative: 6200 },
  { appId: 24880, name: 'The Saboteur', releaseYear: '2009', developers: ['Pandemic Studios'], publishers: ['Electronic Arts'], genres: ['Action'], metacriticScore: 76, metacriticUrl: 'https://www.metacritic.com/game/pc/the-saboteur', totalPositive: 2800, totalNegative: 320 },
  { appId: 43160, name: 'Metro: Last Light', releaseYear: '2013', developers: ['4A Games'], genres: ['Action'], metacriticScore: 82, metacriticUrl: 'https://www.metacritic.com/game/pc/metro-last-light', totalPositive: 31000, totalNegative: 2900 },
  { appId: 200170, name: 'Worms Revolution', releaseYear: '2012', developers: ['Team17'], genres: ['Strategy'], metacriticScore: 73, metacriticUrl: 'https://www.metacritic.com/game/pc/worms-revolution', totalPositive: 3600, totalNegative: 650 },
  { appId: 200510, name: 'XCOM: Enemy Unknown', releaseYear: '2012', developers: ['Firaxis Games'], genres: ['Strategy'], metacriticScore: 89, metacriticUrl: 'https://www.metacritic.com/game/pc/xcom-enemy-unknown', totalPositive: 49000, totalNegative: 2500 },
  { appId: 219950, name: 'NiGHTS into Dreams...', releaseYear: '2012', developers: ['SEGA'], genres: ['Action'], metacriticScore: 72, metacriticUrl: 'https://www.metacritic.com/game/pc/nights-into-dreams-2012', totalPositive: 1400, totalNegative: 190 },
  { appId: 105600, name: 'Terraria', releaseYear: '2011', developers: ['Re-Logic'], genres: ['Adventure'], totalPositive: 520, totalNegative: 55 },
  { appId: 257350, name: "Baldur's Gate II: Enhanced Edition", releaseYear: '2013', developers: ['Beamdog'], genres: ['RPG'], metacriticScore: 78, metacriticUrl: 'https://www.metacritic.com/game/pc/baldurs-gate-ii-enhanced-edition', totalPositive: 12000, totalNegative: 1100 },
  { appId: 287390, name: 'Metro: Last Light Redux', releaseYear: '2014', developers: ['4A Games'], genres: ['Action'], metacriticScore: 76, metacriticUrl: 'https://www.metacritic.com/game/pc/metro-last-light-redux', totalPositive: 54000, totalNegative: 5800 },
  { appId: 292030, name: 'The Witcher 3: Wild Hunt', releaseYear: '2015', developers: ['CD PROJEKT RED'], publishers: ['CD PROJEKT RED'], genres: ['RPG'], metacriticScore: 93, metacriticUrl: 'https://www.metacritic.com/game/pc/the-witcher-3-wild-hunt', totalPositive: 720000, totalNegative: 19000 },
  { appId: 1794680, name: 'Vampire Survivors', releaseYear: '2022', developers: ['poncle'], genres: ['Action', 'Indie'], totalPositive: 480, totalNegative: 70 },
  { appId: 355790, name: 'Styx: Shards of Darkness', releaseYear: '2017', developers: ['Cyanide Studio'], genres: ['Action'], metacriticScore: 72, metacriticUrl: 'https://www.metacritic.com/game/pc/styx-shards-of-darkness', totalPositive: 3800, totalNegative: 620 },
  { appId: 368230, name: 'Kingdom: Classic', releaseYear: '2015', developers: ['Noio'], genres: ['Strategy'], totalPositive: 17000, totalNegative: 1900 },
  { appId: 409720, name: 'BioShock 2 Remastered', releaseYear: '2016', developers: ['2K Marin'], genres: ['Action'], totalPositive: 16000, totalNegative: 4800 },
  { appId: 728880, name: 'Overcooked! 2', releaseYear: '2018', developers: ['Ghost Town Games'], genres: ['Indie'], metacriticScore: 81, metacriticUrl: 'https://www.metacritic.com/game/pc/overcooked-2', totalPositive: 45000, totalNegative: 4100 },
  { appId: 813780, name: 'Age of Empires II: Definitive Edition', releaseYear: '2019', developers: ['Forgotten Empires'], genres: ['Strategy'], metacriticScore: 84, metacriticUrl: 'https://www.metacritic.com/game/pc/age-of-empires-ii-definitive-edition', totalPositive: 132000, totalNegative: 6500 },
  { appId: 870780, name: 'Control Ultimate Edition', releaseYear: '2020', developers: ['Remedy Entertainment'], genres: ['Action'], metacriticScore: 85, metacriticUrl: 'https://www.metacritic.com/game/pc/control', totalPositive: 38000, totalNegative: 4200 },
  { appId: 879420, name: 'Agony UNRATED', releaseYear: '2018', developers: ['Madmind Studio'], genres: ['Action'], totalPositive: 1450, totalNegative: 1050 },
  { appId: 1086940, name: "Baldur's Gate 3", releaseYear: '2023', developers: ['Larian Studios'], genres: ['RPG'], metacriticScore: 96, metacriticUrl: 'https://www.metacritic.com/game/pc/baldurs-gate-3', totalPositive: 620000, totalNegative: 18000 },
  { appId: 1091500, name: 'Cyberpunk 2077', releaseYear: '2020', developers: ['CD PROJEKT RED'], publishers: ['CD PROJEKT RED'], genres: ['RPG', 'Action'], shortDescription: 'Cyberpunk 2077 is an open-world, action-adventure RPG set in Night City.', metacriticScore: 86, metacriticUrl: 'https://www.metacritic.com/game/pc/cyberpunk-2077', totalPositive: 550000, totalNegative: 104210 },
  { appId: 1556200, name: 'Predator: Hunting Grounds', releaseYear: '2021', developers: ['IllFonic'], genres: ['Action'], metacriticScore: 56, metacriticUrl: 'https://www.metacritic.com/game/pc/predator-hunting-grounds', totalPositive: 2900, totalNegative: 950 },
  { appId: 892970, name: 'Valheim', releaseYear: '2021', developers: ['Iron Gate AB'], genres: ['Simulation', 'RPG'], totalPositive: 680, totalNegative: 150 },
  { appId: 1966900, name: '20 Minutes Till Dawn', releaseYear: '2023', developers: ['flanne'], genres: ['Action'], totalPositive: 26000, totalNegative: 1800 },
  { appId: 2417610, name: 'METAL GEAR SOLID Δ: SNAKE EATER', releaseYear: '2025', developers: ['KONAMI'], genres: ['Action'], metacriticScore: 85, metacriticUrl: 'https://www.metacritic.com/game/pc/metal-gear-solid-delta-snake-eater', totalPositive: 9500, totalNegative: 800 },
];

const BY_APP_ID = new Map<number, SteamAppFixture>(STEAM_APPS.map((a) => [a.appId, a]));

function norm(s: string): string {
  return s.toLowerCase().replace(/\u0394/g, 'delta').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function handleSteamStore(req: FixtureRequest): FixtureResponse | null {
  if (req.url.pathname === '/api/appdetails') {
    const rawId = req.url.searchParams.get('appids') || '';
    const appId = Number(rawId);
    const app = BY_APP_ID.get(appId);
    if (!app) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { [rawId || '0']: { success: false } },
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        [String(appId)]: {
          success: true,
          data: {
            type: 'game',
            name: app.name,
            steam_appid: app.appId,
            short_description: app.shortDescription || `${app.name} official Steam store description.`,
            detailed_description: `<p>${app.name} full detailed description on Steam.</p>`,
            about_the_game: `<p>${app.name} about the game synopsis.</p>`,
            header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${app.appId}/header.jpg`,
            capsule_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${app.appId}/capsule_231x87.jpg`,
            developers: app.developers || ['Studio'],
            publishers: app.publishers || app.developers || ['Publisher'],
            genres: (app.genres || ['Action']).map((d, idx) => ({ id: String(idx + 1), description: d })),
            categories: [{ id: 2, description: 'Single-player' }],
            platforms: { windows: true, mac: false, linux: false },
            release_date: { coming_soon: false, date: `15 May, ${app.releaseYear}` },
            metacritic: app.metacriticScore
              ? { score: app.metacriticScore, url: app.metacriticUrl || 'https://www.metacritic.com' }
              : undefined,
            recommendations: app.totalPositive ? { total: app.totalPositive + (app.totalNegative || 0) } : undefined,
            screenshots: [
              {
                id: 0,
                path_thumbnail: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${app.appId}/ss_1_600x338.jpg`,
                path_full: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${app.appId}/ss_1_1920x1080.jpg`,
              },
            ],
          },
        },
      },
    };
  }

  if (req.url.pathname === '/api/storesearch/' || req.url.pathname === '/api/storesearch') {
    const term = req.url.searchParams.get('term') || '';
    const numericId = /^\d+$/.test(term.trim()) ? Number(term.trim()) : NaN;
    const normTerm = norm(term).replace(/\bcomplete pack\b/g, '').trim();
    const matches = STEAM_APPS.filter((a) => {
      if (!Number.isNaN(numericId)) return a.appId === numericId;
      if (!normTerm) return false;
      const an = norm(a.name);
      return an === normTerm || (normTerm.length >= 5 && (an.includes(normTerm) || normTerm.includes(an)));
    }).map((a) => ({
      id: a.appId,
      type: 'app',
      name: a.name,
      tiny_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${a.appId}/capsule_231x87.jpg`,
      metascore: a.metacriticScore ? String(a.metacriticScore) : '',
      platforms: { windows: true, mac: false, linux: false },
    }));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { total: matches.length, items: matches },
    };
  }

  const revMatch = req.url.pathname.match(/^\/appreviews\/(\d+)\/?$/);
  if (revMatch) {
    const appId = Number(revMatch[1]);
    const app = BY_APP_ID.get(appId);
    const pos = app?.totalPositive || 0;
    const neg = app?.totalNegative || 0;
    const total = pos + neg;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        success: 1,
        query_summary: {
          num_reviews: total > 0 ? 20 : 0,
          review_score: total > 0 ? 8 : 0,
          review_score_desc: total > 0 ? 'Very Positive' : 'No user reviews',
          total_positive: pos,
          total_negative: neg,
          total_reviews: total,
        },
        reviews: [],
      },
    };
  }

  const appPageMatch = req.url.pathname.match(/^\/app\/(\d+)\/?$/);
  if (appPageMatch) {
    const appId = Number(appPageMatch[1]);
    const app = BY_APP_ID.get(appId);
    if (!app) {
      return { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/html' }, body: '<html><body>Not Found</body></html>' };
    }
    const mcBlock = app.metacriticScore
      ? `<div id="game_area_metascore"><div class="score">${app.metacriticScore}</div><a href="${app.metacriticUrl}">Read Critic Reviews</a></div>`
      : '';
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `<!DOCTYPE html><html><body><div class="apphub_AppName">${app.name}</div>${mcBlock}</body></html>`,
    };
  }

  return null;
}

function renderCommunityAchievementsHtml(appId: number, count: number, titlePrefix: string): string {
  const rows: string[] = [];
  for (let i = 1; i <= count; i++) {
    rows.push(
      `<div class="achieveRow "><img src="https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${appId}/ach_${i}.jpg"><h3>${titlePrefix} ${i}</h3><h5>Complete ${titlePrefix.toLowerCase()} milestone ${i}.</h5><div class="achievePercent">${Math.max(2.0, Math.round((75 - i * 1.1) * 10) / 10)}%</div></div>`
    );
  }
  return `<!DOCTYPE html><html><body>${rows.join('\n')}</body></html>`;
}

export function handleSteamCommunityAndApi(req: FixtureRequest): FixtureResponse | null {
  if (req.url.hostname === 'steamcommunity.com') {
    const statsMatch = req.url.pathname.match(/^\/stats\/(\d+)\/achievements\/?$/i);
    if (statsMatch) {
      const appId = Number(statsMatch[1]);
      const html =
        appId === 257350
          ? renderBg2CommunityHtml()
          : appId === 1091500
            ? renderCommunityAchievementsHtml(1091500, 44, 'Night City Legend')
            : appId === 782330
              ? renderCommunityAchievementsHtml(782330, 33, 'Slayer Milestone')
              : '<html><body></body></html>';
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
    }
    if (/^\/(?:id|profiles)\/[^/]*\/stats\/[^/]+\/?$/i.test(req.url.pathname)) {
      return { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8' }, body: '<response><error>The specified profile could not be found.</error></response>' };
    }
  }

  if (req.url.hostname === 'api.steampowered.com') {
    if (req.url.pathname.includes('/ISteamUserStats/GetGlobalAchievementPercentagesForApp/')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { achievementpercentages: { achievements: [] } },
      };
    }
  }

  return null;
}
