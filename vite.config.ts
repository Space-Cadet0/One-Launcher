import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function localSystemScannerPlugin(): Plugin {
  return {
    name: 'local-system-scanner',
    configureServer(server) {
      server.middlewares.use('/api/local-system/installed-games', (_req, res) => {
        try {
          const home = os.homedir();
          const steamDirs = [
            path.join(home, 'Library/Application Support/Steam/steamapps'),
            path.join(home, '.local/share/Steam/steamapps'),
            path.join(home, '.steam/steam/steamapps'),
            'C:\\Program Files (x86)\\Steam\\steamapps',
          ];

          // Parse libraryfolders.vdf if present to discover extra drives/libraries
          for (const base of [...steamDirs]) {
            const vdfPath = path.join(base, 'libraryfolders.vdf');
            if (fs.existsSync(vdfPath)) {
              try {
                const content = fs.readFileSync(vdfPath, 'utf8');
                const pathMatches = content.matchAll(/"path"\s+"([^"]+)"/g);
                for (const m of pathMatches) {
                  const customSteamApps = path.join(m[1], 'steamapps');
                  if (fs.existsSync(customSteamApps) && !steamDirs.includes(customSteamApps)) {
                    steamDirs.push(customSteamApps);
                  }
                }
              } catch {
                // Ignore parse errors
              }
            }
          }

          const installedSteamAppIds: number[] = [];
          for (const dir of steamDirs) {
            if (fs.existsSync(dir)) {
              try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                  const match = file.match(/^appmanifest_(\d+)\.acf$/);
                  if (match) {
                    const appId = parseInt(match[1], 10);
                    if (!installedSteamAppIds.includes(appId)) {
                      installedSteamAppIds.push(appId);
                    }
                  }
                }
              } catch {
                // Ignore read errors
              }
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              success: true,
              installedSteamAppIds,
              scannedAt: new Date().toISOString(),
            })
          );
        } catch (err: any) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: err.message, installedSteamAppIds: [] }));
        }
      });

      server.middlewares.use('/api/local-system/steam-achievements', (_req, res) => {
        try {
          const home = os.homedir();
          const steamUserDirs = [
            path.join(home, 'Library/Application Support/Steam/userdata'),
            path.join(home, '.local/share/Steam/userdata'),
            path.join(home, '.steam/steam/userdata'),
            'C:\\Program Files (x86)\\Steam\\userdata',
          ];

          const achievements: Record<number, { unlocked: number; total: number; percentage: number; source: string; syncedAt: string }> = {};

          for (const base of steamUserDirs) {
            if (!fs.existsSync(base)) continue;
            try {
              const userFolders = fs.readdirSync(base);
              for (const u of userFolders) {
                const lcDir = path.join(base, u, 'config/librarycache');
                if (!fs.existsSync(lcDir)) continue;

                const progressFile = path.join(lcDir, 'achievement_progress.json');
                if (fs.existsSync(progressFile)) {
                  try {
                    const raw = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
                    if (Array.isArray(raw.mapCache)) {
                      for (const [appId, data] of raw.mapCache) {
                        if (data && typeof data.unlocked === 'number' && typeof data.total === 'number') {
                          achievements[appId] = {
                            unlocked: data.unlocked,
                            total: data.total,
                            percentage: data.total > 0 ? Math.round((data.unlocked / data.total) * 100) : 0,
                            source: 'local_client_cache',
                            syncedAt: new Date().toISOString(),
                          };
                        }
                      }
                    }
                  } catch {}
                }

                const files = fs.readdirSync(lcDir);
                for (const file of files) {
                  const m = file.match(/^(\d+)\.json$/);
                  if (!m) continue;
                  const appId = parseInt(m[1], 10);
                  try {
                    const content = fs.readFileSync(path.join(lcDir, file), 'utf8');
                    const mTotal = content.match(/"nTotal"\s*:\s*(\d+)/);
                    const mAchieved = content.match(/"nAchieved"\s*:\s*(\d+)/);
                    if (mTotal || mAchieved) {
                      const total = mTotal ? parseInt(mTotal[1], 10) : 0;
                      const unlocked = mAchieved ? parseInt(mAchieved[1], 10) : 0;
                      if (total > 0 || unlocked > 0) {
                        if (!achievements[appId] || unlocked >= achievements[appId].unlocked) {
                          achievements[appId] = {
                            unlocked,
                            total: total > 0 ? total : (achievements[appId]?.total || unlocked),
                            percentage: total > 0 ? Math.round((unlocked / total) * 100) : 0,
                            source: 'local_client_cache',
                            syncedAt: new Date().toISOString(),
                          };
                        }
                      }
                    }
                  } catch {}
                }
              }
            } catch {}
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, achievements, scannedAt: new Date().toISOString() }));
        } catch (err: any) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: err.message, achievements: {} }));
        }
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), localSystemScannerPlugin()],
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api/steam-store': {
        target: 'https://store.steampowered.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/steam-store/, ''),
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
    },
  }
});
