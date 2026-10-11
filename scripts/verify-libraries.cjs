const fs = require('fs');
const path = require('path');

// Helper to load TS exports by parsing JSON data
function loadExportedArray(filePath, exportName) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const start = content.indexOf(`export const ${exportName}: CanonicalGame[] = [\n`) + `export const ${exportName}: CanonicalGame[] = `.length;
  const end = content.lastIndexOf('];') + 1;
  const jsonStr = content.substring(start, end);
  return JSON.parse(jsonStr);
}

const gogGames = loadExportedArray('./src/services/storage/gogUserLibrary.ts', 'GOG_USER_LIBRARY');
const epicGames = loadExportedArray('./src/services/storage/epicUserLibrary.ts', 'EPIC_USER_LIBRARY');
const steamGames = loadExportedArray('./src/services/storage/fullUserSteamGames.ts', 'FULL_USER_STEAM_GAMES');

console.log('--- RAW LIBRARIES ---');
console.log(`GOG_USER_LIBRARY length: ${gogGames.length}`);
console.log(`EPIC_USER_LIBRARY length: ${epicGames.length}`);
console.log(`FULL_USER_STEAM_GAMES length: ${steamGames.length}`);

// Test Steam games integrity
const nfsHeatInSteam = steamGames.filter(g => g.steamAppId === 1222680 || g.title.toLowerCase().includes('need for speed'));
console.log(`Need for Speed Heat in Steam library: ${nfsHeatInSteam.length} (Expected: 0)`);
const bfInSteam = steamGames.filter(g => g.title.toLowerCase().includes('battlefield'));
console.log(`Battlefield in Steam library: ${bfInSteam.length} (Expected: 0)`);

// Test duplicate titles within GOG
const gogTitles = new Set();
const gogDups = [];
for (const g of gogGames) {
  if (gogTitles.has(g.title)) gogDups.push(g.title);
  gogTitles.add(g.title);
}
console.log(`GOG duplicate titles: ${gogDups.length}`);

// Test duplicate titles within Epic
const epicTitles = new Set();
const epicDups = [];
for (const g of epicGames) {
  if (epicTitles.has(g.title)) epicDups.push(g.title);
  epicTitles.add(g.title);
}
console.log(`Epic duplicate titles: ${epicDups.length}`);

// Check for Hades in Epic
const hadesInEpic = epicGames.filter(g => g.title.toLowerCase().includes('hades') || (g.platforms && g.platforms.some(p => p.platformId === 'epic' && (p.platformGameId || '').toLowerCase().includes('hades'))));
console.log(`Hades in Epic library: ${hadesInEpic.length}`);

// Check for codenames in Epic library
const codenames = ['hazlenut', 'hazelnut', 'herring', 'bobcat', 'boxfish', 'calluna', 'catnip', 'cormorant', 'boga', 'barbet', 'basil', 'batfish', 'blobfish'];
const foundCodenames = epicGames.filter(g => codenames.includes(g.title.toLowerCase()));
console.log(`Codename titles in Epic library: ${foundCodenames.length} ${foundCodenames.map(g => g.title).join(', ')}`);

// Check Limbo and Hue
const limbo = epicGames.find(g => g.title === 'Limbo');
const hue = epicGames.find(g => g.title === 'Hue');
console.log(`Limbo in Epic: ${limbo ? `Found (steamAppId: ${limbo.steamAppId})` : 'MISSING'}`);
console.log(`Hue in Epic: ${hue ? `Found (steamAppId: ${hue.steamAppId})` : 'MISSING'}`);
