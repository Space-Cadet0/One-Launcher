const fs = require('fs');
const path = require('path');
const https = require('https');

// Import compiled or raw storage data
const { FULL_USER_STEAM_GAMES } = require('../src/services/storage/fullUserSteamGames.ts');
const { GOG_USER_LIBRARY } = require('../src/services/storage/gogUserLibrary.ts');
const { EPIC_USER_LIBRARY } = require('../src/services/storage/epicUserLibrary.ts');
const steamEnrichedCache = require('../src/services/storage/steamEnrichedCache.json');

console.log('Script loaded successfully.');
