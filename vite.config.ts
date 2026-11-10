import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

interface SteamLocalScannerModule {
  resolveLocalSteamUserdataDirs: (options?: Record<string, unknown>) => Promise<string[]>;
  scanLocalSteamAchievements: (
    options?: Record<string, unknown>
  ) => Promise<
    Record<number, { unlocked: number; total: number; percentage: number; isMastered: boolean }>
  >;
}

let cachedSteamScanner: SteamLocalScannerModule | null = null;

function loadSteamLocalScanner(): SteamLocalScannerModule {
  if (!cachedSteamScanner) {
    const cjsRequire = createRequire(import.meta.url);
    cachedSteamScanner = cjsRequire(
      './electron/storefronts/steamLocalScanner.cjs'
    ) as SteamLocalScannerModule;
  }
  return cachedSteamScanner;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err || 'unknown_error');
}

async function scanLocalInstalledSteamAppIds(): Promise<number[]> {
  const scanner = loadSteamLocalScanner();
  const userdataDirs = await scanner.resolveLocalSteamUserdataDirs();
  const steamappsDirs = new Set<string>();
  for (const ud of userdataDirs) {
    if (ud) {
      steamappsDirs.add(path.join(path.dirname(ud), 'steamapps'));
    }
  }

  for (const base of Array.from(steamappsDirs)) {
    try {
      const content = await fs.promises.readFile(path.join(base, 'libraryfolders.vdf'), 'utf8');
      const isBottleDir = /(?:^|[\\/])drive_c(?:[\\/]|$)/i.test(base);
      const driveCMatch = isBottleDir ? base.match(/^(.*?[\\/]drive_c)(?:[\\/]|$)/i) : null;
      for (const m of content.matchAll(/"path"\s+"([^"]+)"/gi)) {
        const rawLibPath = (m[1] || '').replace(/\\\\/g, '\\').trim();
        if (!rawLibPath) continue;
        if (driveCMatch && /^[a-zA-Z]:[\\/]/.test(rawLibPath)) {
          const driveLetter = rawLibPath[0].toLowerCase();
          const relWin = rawLibPath.slice(2).replace(/^[\\/]+/, '').replace(/\\/g, '/');
          if (driveLetter === 'c') {
            steamappsDirs.add(path.join(driveCMatch[1], relWin, 'steamapps'));
          } else if (driveLetter === 'z') {
            steamappsDirs.add(path.join('/', relWin, 'steamapps'));
          }
        } else {
          steamappsDirs.add(path.join(rawLibPath, 'steamapps'));
        }
      }
    } catch {
      // Ignore missing or unreadable libraryfolders.vdf
    }
  }

  const appIdSet = new Set<number>();
  for (const dir of steamappsDirs) {
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        const match = file.match(/^appmanifest_(\d+)\.acf$/);
        if (match) {
          const appId = Number.parseInt(match[1], 10);
          if (appId > 0) appIdSet.add(appId);
        }
      }
    } catch {
      // Ignore non-existent or unreadable steamapps directory
    }
  }
  return Array.from(appIdSet);
}

function localSystemScannerPlugin(): Plugin {
  return {
    name: 'local-system-scanner',
    configureServer(server) {
      server.middlewares.use('/api/local-system/installed-games', (_req, res) => {
        void (async () => {
          try {
            const installedSteamAppIds = await scanLocalInstalledSteamAppIds();
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                success: true,
                installedSteamAppIds,
                scannedAt: new Date().toISOString(),
              })
            );
          } catch (err: unknown) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 500;
            res.end(
              JSON.stringify({
                success: false,
                error: getErrorMessage(err),
                installedSteamAppIds: [],
              })
            );
          }
        })();
      });

      server.middlewares.use('/api/local-system/steam-achievements', (_req, res) => {
        void (async () => {
          try {
            const scanner = loadSteamLocalScanner();
            const rawAchievements = await scanner.scanLocalSteamAchievements();
            const scannedAt = new Date().toISOString();
            const achievements: Record<
              number,
              {
                unlocked: number;
                total: number;
                percentage: number;
                isMastered?: boolean;
                source: 'local_client_cache';
                syncedAt: string;
              }
            > = {};

            for (const [appIdKey, record] of Object.entries(rawAchievements || {})) {
              const appId = Number(appIdKey);
              if (appId > 0 && record) {
                achievements[appId] = {
                  unlocked: record.unlocked,
                  total: record.total,
                  percentage: record.percentage,
                  isMastered: record.isMastered,
                  source: 'local_client_cache',
                  syncedAt: scannedAt,
                };
              }
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, achievements, scannedAt }));
          } catch (err: unknown) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 500;
            res.end(
              JSON.stringify({
                success: false,
                error: getErrorMessage(err),
                achievements: {},
              })
            );
          }
        })();
      });
    },
  };
}

const PACKAGED_CSP_META_TAG =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob: ol-media: https:; media-src \'self\' data: blob: ol-media: https:; connect-src \'self\' ol-media: https:; font-src \'self\' data:; frame-src https://www.youtube-nocookie.com https://www.youtube.com; object-src \'none\'; base-uri \'self\'; form-action \'none\';">';

function packagedCspPlugin(): Plugin {
  return {
    name: 'one-launcher-packaged-csp',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) {
          return html;
        }
        return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n    ${PACKAGED_CSP_META_TAG}`);
      },
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), localSystemScannerPlugin(), packagedCspPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const normalizedId = id.replace(/\\/g, '/');

          if (normalizedId.includes('/node_modules/')) {
            if (
              normalizedId.includes('/node_modules/react/') ||
              normalizedId.includes('/node_modules/react-dom/') ||
              normalizedId.includes('/node_modules/scheduler/') ||
              normalizedId.includes('/node_modules/@tanstack/react-virtual/') ||
              normalizedId.includes('/node_modules/@tanstack/virtual-core/')
            ) {
              return 'vendor-react';
            }
            if (normalizedId.includes('/node_modules/lucide-react/')) {
              return 'vendor-icons';
            }
            if (normalizedId.includes('/node_modules/hls.js')) {
              return 'vendor-hls';
            }
            if (normalizedId.includes('/node_modules/axios/')) {
              return 'vendor-network';
            }
            if (normalizedId.includes('/node_modules/dompurify/')) {
              return 'vendor-sanitizer';
            }
          }

          // Layer 0 (Pure Foundation - zero imports from steam/integrations/critic/launcher):
          if (
            normalizedId.includes('/src/contracts/') ||
            normalizedId.includes('/src/services/common/') ||
            normalizedId.includes('/src/services/network/requestScheduler') ||
            normalizedId.includes('/src/services/network/onlineLifecycleManager') ||
            normalizedId.includes('/src/services/storage/indexedDbVault') ||
            normalizedId.includes('/src/services/storage/stagedCacheService') ||
            normalizedId.includes('/src/services/storage/userOverrideStorage') ||
            normalizedId.includes('/src/services/storage/knownGameAchievements') ||
            normalizedId.includes('/src/services/storage/achievementReconciliation')
          ) {
            return 'services-foundation';
          }

          // Layer 1 (Storefront Catalog, Metadata, Critic, Platform & Sync):
          if (
            normalizedId.includes('/src/services/steam/') ||
            normalizedId.includes('/src/services/integrations/') ||
            normalizedId.includes('/src/services/igdb/') ||
            normalizedId.includes('/src/services/critic/') ||
            normalizedId.includes('/src/services/opencritic/') ||
            normalizedId.includes('/src/services/hltb/') ||
            normalizedId.includes('/src/services/platform/') ||
            normalizedId.includes('/src/services/storage/') ||
            normalizedId.includes('/src/services/network/')
          ) {
            return 'services-catalog';
          }

          // Layer 2 (Launcher, Install & Wine/CrossOver Runtime):
          if (normalizedId.includes('/src/services/launcher/')) {
            return 'services-launcher';
          }

          if (normalizedId.includes('/src/components/SteamStoreDetail/')) {
            return 'ui-store-detail';
          }

          return undefined;
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api/steam-store': {
        target: 'https://store.steampowered.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/steam-store/, ''),
        headers: {
          Cookie:
            'Steam_Language=english; birthtime=568022401; mature_content=1; wants_mature_content=1',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      '/api/steam-api': {
        target: 'https://api.steampowered.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/steam-api/, ''),
      },
      '/api/steam-community': {
        target: 'https://steamcommunity.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/steam-community/, ''),
      },
      '/api/gog-embed': {
        target: 'https://embed.gog.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gog-embed/, ''),
      },
      '/api/gog-auth': {
        target: 'https://auth.gog.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gog-auth/, ''),
      },
      '/api/gog-menu': {
        target: 'https://menu.gog.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gog-menu/, ''),
      },
      '/api/gog-profile': {
        target: 'https://www.gog.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gog-profile/, ''),
      },
      '/api/epic-oauth': {
        target: 'https://account-public-service-prod03.ol.epicgames.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/epic-oauth/, ''),
      },
      '/api/epic-library': {
        target: 'https://library-service.live.use1a.on.epicgames.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/epic-library/, ''),
      },
      '/api/epic-catalog': {
        target: 'https://catalog-public-service-prod06.ol.epicgames.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/epic-catalog/, ''),
      },
      '/api/epic-content': {
        target: 'https://store-content.ak.epicgames.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/epic-content/, ''),
      },
      '/api/epic-graphql': {
        target: 'https://launcher.store.epicgames.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/epic-graphql/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
        },
      },
      '/api/gog-product': {
        target: 'https://api.gog.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gog-product/, ''),
      },
      '/api/hltb': {
        target: 'https://howlongtobeat.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hltb/, ''),
        headers: {
          Referer: 'https://howlongtobeat.com/',
        },
      },
      '/api/lutris': {
        target: 'https://lutris.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/lutris/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
      },
      '/api/opencritic': {
        target: 'https://api.opencritic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/opencritic/, ''),
        headers: {
          Referer: 'https://opencritic.com/',
          Origin: 'https://opencritic.com',
        },
      },
      '/api/metacritic': {
        target: 'https://www.metacritic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/metacritic/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.metacritic.com/',
        },
      },
      '/api/metacritic-backend': {
        target: 'https://backend.metacritic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/metacritic-backend/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.metacritic.com/',
          Origin: 'https://www.metacritic.com',
        },
      },
    },
  }
});
