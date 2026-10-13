const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

const EPIC_CLIENT_AUTH = 'MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y=';

function getTokensFilePath() {
  try {
    const defaultDir = path.join(process.env.HOME || '.', '.one-launcher');
    const legacyDir = path.join(process.env.HOME || '.', '.universal-game-library');
    const userDataPath = app ? app.getPath('userData') : (fs.existsSync(legacyDir) && !fs.existsSync(defaultDir) ? legacyDir : defaultDir);
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    return path.join(userDataPath, 'tokens.json');
  } catch {
    return path.join(process.cwd(), 'tokens.json');
  }
}

function isSafeStorageAvailable() {
  try {
    return Boolean(
      typeof safeStorage !== 'undefined' &&
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable()
    );
  } catch {
    return false;
  }
}

function writeTokensFile(tokens) {
  const filePath = getTokensFilePath();
  const jsonStr = JSON.stringify(tokens, null, 2);

  if (isSafeStorageAvailable()) {
    try {
      const encryptedBuffer = safeStorage.encryptString(jsonStr);
      const encryptedPayload = {
        _encrypted: true,
        data: encryptedBuffer.toString('base64'),
      };
      fs.writeFileSync(filePath, JSON.stringify(encryptedPayload, null, 2), 'utf-8');
      return;
    } catch (encErr) {
      console.warn('Failed to encrypt tokens with safeStorage, falling back to plaintext:', encErr.message);
    }
  }

  // Graceful fallback if safeStorage is not available or encryption failed
  fs.writeFileSync(filePath, jsonStr, 'utf-8');
}

function loadSavedTokens() {
  try {
    const filePath = getTokensFilePath();
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const rawContent = fs.readFileSync(filePath);
    if (!rawContent || rawContent.length === 0) {
      return {};
    }

    // Try parsing as JSON first
    let parsed;
    try {
      parsed = JSON.parse(rawContent.toString('utf-8'));
    } catch {
      // If not JSON, it might be a raw binary buffer encrypted by safeStorage
      if (isSafeStorageAvailable()) {
        try {
          const decrypted = safeStorage.decryptString(rawContent);
          return JSON.parse(decrypted);
        } catch (rawDecErr) {
          console.warn('Failed to decrypt raw binary tokens buffer:', rawDecErr.message);
        }
      }
      return {};
    }

    // Handle encrypted payload format: { _encrypted: true, data: "base64..." }
    if (parsed && parsed._encrypted === true && typeof parsed.data === 'string') {
      if (isSafeStorageAvailable()) {
        try {
          const buffer = Buffer.from(parsed.data, 'base64');
          const decrypted = safeStorage.decryptString(buffer);
          return JSON.parse(decrypted);
        } catch (decErr) {
          console.warn('Failed to decrypt tokens payload with safeStorage:', decErr.message);
          return {};
        }
      } else {
        console.warn('safeStorage is not available to decrypt tokens; unable to read encrypted tokens.');
        return {};
      }
    }

    // Handle per-token encrypted format if present: { gog: { _encrypted: true, data: "..." } }
    if (parsed && typeof parsed === 'object') {
      let containsPerTokenEncryption = false;
      const decryptedTokens = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && value._encrypted === true && typeof value.data === 'string') {
          containsPerTokenEncryption = true;
          if (isSafeStorageAvailable()) {
            try {
              const buffer = Buffer.from(value.data, 'base64');
              const decrypted = safeStorage.decryptString(buffer);
              decryptedTokens[key] = JSON.parse(decrypted);
            } catch (err) {
              console.warn(`Failed to decrypt token for ${key}:`, err.message);
            }
          }
        } else {
          decryptedTokens[key] = value;
        }
      }
      if (containsPerTokenEncryption) {
        return decryptedTokens;
      }

      // Legacy plaintext JSON backward compatibility:
      // Return parsed plaintext directly. Next time saveTokens is called,
      // it will be migrated to the encrypted format via writeTokensFile.
      return parsed;
    }

    return {};
  } catch (err) {
    console.warn('Failed to load saved tokens:', err.message);
    return {};
  }
}

function saveTokens(storefrontId, tokenData) {
  try {
    const existing = loadSavedTokens();
    existing[storefrontId] = {
      ...tokenData,
      updatedAt: new Date().toISOString(),
    };
    writeTokensFile(existing);
  } catch (err) {
    console.warn('Failed to save tokens:', err.message);
  }
}

function clearTokens(storefrontId) {
  try {
    const existing = loadSavedTokens();
    if (existing[storefrontId]) {
      delete existing[storefrontId];
      writeTokensFile(existing);
    }
  } catch (err) {
    console.warn('Failed to clear tokens:', err.message);
  }
}

const KNOWN_STEAM_MAPPINGS = {
  // CD PROJEKT RED
  'cyberpunk 2077': 1091500,
  'cyberpunk 2077: phantom liberty': 1091500,
  'the witcher 3: wild hunt': 292030,
  'the witcher 3: wild hunt - complete edition': 292030,
  'the witcher 3: wild hunt - game of the year edition': 292030,
  'the witcher 2: assassins of kings enhanced edition': 20920,
  'the witcher: enhanced edition': 20900,
  'the witcher: enhanced edition director\'s cut': 20900,

  // Larian Studios
  'baldur\'s gate 3': 1086940,
  'baldur\'s gate: enhanced edition': 228280,
  'baldur\'s gate ii: enhanced edition': 257350,
  'divinity: original sin 2': 435150,
  'divinity: original sin 2 - definitive edition': 435150,
  'divinity: original sin enhanced edition': 373420,

  // Bethesda / Obsidian / id
  'fallout': 38400,
  'fallout 2': 38410,
  'fallout tactics': 38420,
  'fallout: new vegas': 22380,
  'fallout: new vegas ultimate edition': 22380,
  'fallout 3': 22370,
  'fallout 3: game of the year edition': 22370,
  'fallout 4': 377160,
  'fallout 4: game of the year edition': 377160,
  'the elder scrolls v: skyrim': 72850,
  'the elder scrolls v: skyrim special edition': 489830,
  'the elder scrolls iv: oblivion': 22330,
  'the elder scrolls iii: morrowind': 22320,
  'doom': 379720,
  'doom eternal': 782330,
  'doom 3': 9050,
  'doom 3: bfg edition': 208200,
  'doom 3 bfg edition': 208200,
  'final doom': 2290,
  'doom ii': 2300,
  'doom (2016)': 379720,
  'dishonored': 205100,
  'dishonored - definitive edition': 205100,
  'dishonored 2': 403640,
  'dishonored: death of the outsider': 614570,
  'prey': 480490,

  // Epic / Remedy / 505
  'doki doki literature club plus!': 1388880,
  'control': 870780,
  'control ultimate edition': 870780,
  'death stranding': 1190460,
  'death stranding director\'s cut': 1850570,
  'hades': 1145360,
  'hollow knight': 367520,
  'disco elysium': 632470,
  'disco elysium - the final cut': 632470,
  'ghostrunner': 1139900,
  'ghostrunner 2': 2144740,
  'second extinction': 1024380,
  'out of sight': 2526310,
  'a plague tale: innocence': 752590,
  'a plague tale: requiem': 1182900,
  'sifu': 2138710,
  'chivalry 2': 1824220,

  // Rockstar & 2K
  'grand theft auto v': 271590,
  'grand theft auto iv: the complete edition': 12210,
  'red dead redemption 2': 1174180,
  'borderlands 2': 49520,
  'borderlands 3': 397540,
  'bioshock remastered': 409710,
  'bioshock 2 remastered': 409720,
  'bioshock infinite': 8870,
  'sid meier\'s civilization vi': 289070,
  'civilization vi': 289070,
  'xcom 2': 268500,
  'xcom: enemy unknown': 200510,
  'xcom enemy unknown': 200510,
  'xcom: enemy unknown complete pack': 200510,
  'xcom enemy unknown complete pack': 200510,

  // Warner Bros
  'batman: arkham knight': 208650,
  'batman: arkham city': 200260,
  'batman: arkham city - goty edition': 200260,
  'batman: arkham asylum': 35140,
  'batman: arkham asylum game of the year edition': 35140,
  'mad max': 234140,
  'middle-earth: shadow of mordor': 241930,
  'middle-earth: shadow of war': 356190,

  // Square Enix / Eidos
  'deus ex: human revolution - director\'s cut': 238010,
  'deus ex: human revolution - director’s cut': 238010,
  'deus ex human revolution director\'s cut': 238010,
  'deus ex human revolution directors cut': 238010,
  'deus ex: human revolution': 238010,
  'deus ex human revolution': 238010,
  'deus ex: mankind divided': 337000,
  'deus ex: game of the year edition': 6910,
  'deus ex: invisible war': 6920,
  'deus ex invisible war': 6920,
  'deus ex 2: invisible war': 6920,
  'deus ex 2 invisible war': 6920,
  'tomb raider': 203160,
  'rise of the tomb raider': 391220,
  'shadow of the tomb raider': 750920,
  'shadow of the tomb raider: definitive edition': 750920,
  'sleeping dogs: definitive edition': 307690,
  'thief': 239160,
  'thief gold': 211600,
  'thief 2: the metal age': 211740,
  'thief 2 the metal age': 211740,
  'thief ii: the metal age': 211740,
  'thief ii the metal age': 211740,
  'thief 3: deadly shadows': 6980,
  'thief 3 deadly shadows': 6980,
  'thief: deadly shadows': 6980,
  'thief deadly shadows': 6980,
  'predator: hunting grounds': 1556200,
  'predator hunting grounds': 1556200,
  'predator: hunting grounds standard edition': 1556200,
  'predator hunting grounds standard edition': 1556200,

  // Deep Silver / 4A Games
  'metro 2033 redux': 286690,
  'metro: last light redux': 287390,
  'metro exodus': 412020,
  'saints row: the third remastered': 978300,
  'saints row iv: re-elected': 206420,
  'dead island definitive edition': 383150,

  // GOG Classics & Indie Gems
  's.t.a.l.k.e.r.: shadow of chernobyl': 4500,
  's.t.a.l.k.e.r.: clear sky': 20510,
  's.t.a.l.k.e.r.: call of pripyat': 41700,
  'heroes of might and magic 3 - hd edition': 297000,
  'heroes of might & magic iii - hd edition': 297000,
  'vampire: the masquerade - bloodlines': 2600,
  'star wars: knights of the old republic': 32370,
  'star wars: knights of the old republic ii': 208580,
  'dragon age: origins - ultimate edition': 47810,
  'mass effect legendary edition': 1328670,
  'frostpunk': 323190,
  'this war of mine': 282070,
  'subnautica': 264710,
  'subnautica: below zero': 848450,
  'outer wilds': 753640,
  'the outer worlds': 578650,
  'the outerworlds': 578650,
  'slay the spire': 646570,
  'dead cells': 588650,
  'celeste': 504230,
  'inside': 304430,
  'limbo': 48000,
  'stardew valley': 413150,
  'terraria': 105600,
  'cuphead': 268910,
  'risk of rain 2': 632360,
  'deep rock galactic': 548430,
  'no man\'s sky': 275850,
  'remnant: from the ashes': 617290,
  'remnant ii': 1282100,
  'darksiders warmastered edition': 462780,
  'darksiders ii deathinitive edition': 388410,
  'darksiders iii': 606280,
  'shadowrun returns': 234650,
  'shadowrun: dragonfall - director\'s cut': 300550,
  'shadowrun: hong kong': 346940,
  'shadowrun hong kong': 346940,
  'shadowrun: hong kong - extended edition': 346940,
  'shadowrun hong kong - extended edition': 346940,
  'shadowrun hong kong extended edition': 346940,
  'wasteland 2: director\'s cut': 240760,
  'wasteland 3': 770300,
  'pillars of eternity': 291650,
  'pillars of eternity ii: deadfire': 560130,
  'tyranny': 362960,
  'torment: tides of numenera': 272270,
  'neverwinter nights: enhanced edition': 704450,
  'planescape: torment: enhanced edition': 466300,
  'icewind dale: enhanced edition': 321800,
  'system shock: enhanced edition': 410710,
  'system shock 2': 238210,
  'system shock': 482400,
  'kingdom come: deliverance': 379430,
  'kingdom come: deliverance royal edition': 379430,
  'alien: isolation': 214490,
  'amnesia: the dark descent': 57300,
  'amnesia: a machine for pigs': 239200,
  'amnesia: rebirth': 999220,
  'amnesia: the bunker': 1944430,
  'soma': 282140,
  'outlast': 238320,
  'outlast 2': 414700,

  // Epic Codenames & Exclusives
  'into the breach': 590380,
  'hitman': 236870,
  'human resource machine': 375820,
  'batman - the telltale series': 498240,
  'batman: the telltale series': 498240,
  'the telltale batman shadows edition': 498240,
  'telltale batman season 1': 498240,
  'telltale batman season 2': 675260,
  'batman: the enemy within': 675260,
  'batman: the enemy within - the telltale series': 675260,
  'world war z': 699130,
  'rocket league': 252950,
  'overcooked! 2': 728880,
  'overcooked 2': 728880,
  'yooka-laylee and the impossible lair': 1084600,
  'minit': 609490,
  'brothers - a tale of two sons': 225080,
  'mutant year zero: road to eden': 760060,
  'tacoma': 643880,
  'farming simulator 19': 787860,
  'dragon age: inquisition': 1222690,
  'super meat boy': 40800,
  'dead by daylight': 381210,
  'the bridge': 230050,
  'boga': 1190460,
  'blobfish': 590380,
  'barbet': 236870,
  'basil': 375820,
  'batfish': 498240,
  'batfishs2': 675260,
  'wombat': 699130,
  'speedwell': 287390,
  'sugar': 252950,
  'potoo': 448510,
  'duckbill': 1084600,
  'petrel': 609490,
  'tamarind': 225080,
  'dodo': 49520,
  'falcon': 760060,
  'flagfin': 643880,
  'stellula': 787860,
  'verdi': 1222690,
  'peppermint': 1824220,
  'buffalo': 40800,
  'brill': 381210,
  'sunbird': 230050,
  'bobcat': 1222730,
  'boxfish': 1556200,
  'calluna': 870780,
  'catnip': 397540,
  'cormorant': 742420,
  'star wars: squadrons': 1222730,
  'star wars™: squadrons': 1222730,
  'saints row': 742420,
  'hazelnut': 48000,
  'hazlenut': 48000,
  'herring': 383270,
  'hue': 383270,
  'lego star wars: the skywalker saga': 920210,

  // Additional Store Matches
  'rollercoaster tycoon 3: complete edition': 1368820,
  'rollercoaster tycoon 3 complete edition': 1368820,
  'rollercoaster tycoon 3': 1368820,
  'higurashi when they cry hou - ch.1 onikakushi': 310360,
  'higurashi when they cry hou ch.1 onikakushi': 310360,
  'higurashi when they cry hou ch 1 onikakushi': 310360,
  'rpg maker xp': 235900,
  'resident evil requiem': 3764200,
  'heretic + hexen': 3286930,
  'heretic hexen': 3286930,

  // Curated Store Matches
  'agony': 487720,
  'agony unrated': 879420,
  'darq': 433550,
  'darq: complete edition': 433550,
  'darq complete edition': 433550,
  'grip': 396900,
  'grip: combat racing': 396900,
  'grip combat racing': 396900,
  'deus ex goty edition': 6910,
  'deus ex: goty edition': 6910,
  'deus ex: game of the year edition': 6910,
  'deus ex game of the year edition': 6910,
  'deus ex goty': 6910,
  'deus ex': 6910,
  'tomb raider goty': 203160,
  'tomb raider: goty': 203160,
  'tomb raider goty edition': 203160,
  'tomb raider: game of the year edition': 203160,
  'tomb raider game of the year edition': 203160,
  'eschalon: book i': 25600,
  'eschalon book i': 25600,
  'eschalon book 1': 25600,
  'eschalon: book 1': 25600,
  'fate': 246840,
  'fate: undiscovered realms': 276890,
  'fate undiscovered realms': 276890,
  'gamedec': 917720,
  'gamedec: definitive edition': 917720,
  'gamedec definitive edition': 917720,
  'lacuna': 1365860,
  'lacuna – a sci-fi noir adventure': 1365860,
  'lacuna: a sci-fi noir adventure': 1365860,
  'lacuna a sci fi noir adventure': 1365860,
};

const KNOWN_EPIC_APP_NAMES = {
  '4a611c60218d4e84bcdcb821d1038ebb': { title: 'Out of Sight', steamAppId: 2526310, developer: 'The Gang Studio AB' },
  'ad6a817e51b349619f51957b229520cf': { title: 'Out of Sight', steamAppId: 2526310, developer: 'The Gang Studio AB' },
  boga: { title: 'Death Stranding', steamAppId: 1190460, developer: 'Kojima Productions' },
  blobfish: { title: 'Into The Breach', steamAppId: 590380, developer: 'Subset Games' },
  barbet: { title: 'HITMAN', steamAppId: 236870, developer: 'IO Interactive' },
  basil: { title: 'Human Resource Machine', steamAppId: 375820, developer: 'Tomorrow Corporation' },
  batfish: { title: 'Batman - The Telltale Series', steamAppId: 498240, developer: 'Telltale Games' },
  batfishs2: { title: 'Batman: The Enemy Within - The Telltale Series', steamAppId: 675260, developer: 'Telltale Games' },
  bobcat: { title: 'STAR WARS™: Squadrons', steamAppId: 1222730, developer: 'Motive Studio' },
  boxfish: { title: 'Predator: Hunting Grounds', steamAppId: 1556200, developer: 'IllFonic' },
  calluna: { title: 'Control', steamAppId: 870780, developer: 'Remedy Entertainment' },
  catnip: { title: 'Borderlands 3', steamAppId: 397540, developer: 'Gearbox Software' },
  cormorant: { title: 'Saints Row', steamAppId: 742420, developer: 'Deep Silver Volition' },
  hazelnut: { title: 'Limbo', steamAppId: 48000, developer: 'Playdead' },
  hazlenut: { title: 'Limbo', steamAppId: 48000, developer: 'Playdead' },
  herring: { title: 'Hue', steamAppId: 383270, developer: 'Curve Digital' },
  wombat: { title: 'World War Z', steamAppId: 699130, developer: 'Saber Interactive' },
  speedwell: { title: 'Metro Last Light Redux', steamAppId: 287390, developer: '4A Games' },
  sugar: { title: 'Rocket League', steamAppId: 252950, developer: 'Psyonix LLC' },
  potoo: { title: 'Overcooked! 2', steamAppId: 728880, developer: 'Ghost Town Games' },
  duckbill: { title: 'Yooka-Laylee and the Impossible Lair', steamAppId: 1084600, developer: 'Playtonic Games' },
  petrel: { title: 'Minit', steamAppId: 609490, developer: 'JW, Kitty, Jukio, and Dom' },
  tamarind: { title: 'Brothers - A Tale of Two Sons', steamAppId: 225080, developer: 'Starbreeze Studios' },
  dodo: { title: 'Borderlands 2', steamAppId: 49520, developer: 'Gearbox Software' },
  falcon: { title: 'Mutant Year Zero: Road to Eden', steamAppId: 760060, developer: 'The Bearded Ladies' },
  flagfin: { title: 'Tacoma', steamAppId: 643880, developer: 'Fullbright' },
  stellula: { title: 'Farming Simulator 19', steamAppId: 787860, developer: 'Giants Software' },
  verdi: { title: 'Dragon Age: Inquisition', steamAppId: 1222690, developer: 'BioWare' },
  peppermint: { title: 'Chivalry 2', steamAppId: 1824220, developer: 'Torn Banner Studios' },
  buffalo: { title: 'Super Meat Boy', steamAppId: 40800, developer: 'Team Meat' },
  brill: { title: 'Dead by Daylight', steamAppId: 381210, developer: 'Behaviour Interactive Inc.' },
  sunbird: { title: 'The Bridge', steamAppId: 230050, developer: 'The Quantum Astrophysicists Guild' },
  c5109bdceb3a453bb38c2fdc964ddee8: { title: 'Doki Doki Literature Club Plus!', steamAppId: 1388880, developer: 'Team Salvato' },
  snail: { title: 'Subnautica', steamAppId: 264710, developer: 'Unknown Worlds Entertainment' },
  walrus: { title: 'The Witness', steamAppId: 210970, developer: 'Thekla, Inc.' },
  gull: { title: 'Transistor', steamAppId: 237930, developer: 'Supergiant Games' },
  flamingo: { title: 'Celeste', steamAppId: 504230, developer: 'Maddy Makes Games' },
  ox: { title: 'Oxenfree', steamAppId: 388880, developer: 'Night School Studio' },
  finch: { title: 'What Remains of Edith Finch', steamAppId: 501300, developer: 'Giant Sparrow' },
  lemur: { title: 'Slime Rancher', steamAppId: 433340, developer: 'Monomi Park' },
  pelican: { title: 'Enter the Gungeon', steamAppId: 311690, developer: 'Dodge Roll' },
  mallard: { title: 'Moonlighter', steamAppId: 606150, developer: 'Digital Sun' },
  chaffinch: { title: 'This War of Mine', steamAppId: 282070, developer: '11 bit studios' },
  avocet: { title: 'Alan Wake', steamAppId: 108710, developer: 'Remedy Entertainment' },
  curlew: { title: 'Hyper Light Drifter', steamAppId: 257850, developer: 'Heart Machine' },
  godwit: { title: 'Fez', steamAppId: 224760, developer: 'Polytron Corporation' },
  skua: { title: 'Inside', steamAppId: 304430, developer: 'Playdead' },
  waxwing: { title: 'SOMA', steamAppId: 282140, developer: 'Frictional Games' },
  garganey: { title: 'The Wolf Among Us', steamAppId: 250320, developer: 'Telltale Games' },
  snipe: { title: 'The Talos Principle', steamAppId: 257510, developer: 'Croteam' },
  albatross: { title: 'Ape Out', steamAppId: 447150, developer: 'Gabe Cuzzillo' },
  parakeet: { title: 'Metro 2033 Redux', steamAppId: 286690, developer: '4A Games' },
  crossbill: { title: 'TowerFall Ascension', steamAppId: 251470, developer: 'Maddy Makes Games' },
};

const EDITION_WORDS = new Set([
  'complete',
  'definitive',
  'enhanced',
  'goty',
  'deluxe',
  'gold',
  'standard',
  'remastered',
  'remaster',
  'directors',
  'director',
  'cut',
  'edition',
  'collectors',
  'collector',
  'anniversary',
  'special',
  'ultimate',
  'extended',
  'game',
  'year',
  'final',
  'royal',
  'emperor',
  'classics',
  'classic',
  'plus',
  'bundle',
  'pack',
  'package',
  'collection',
  'upgrade',
  'vr',
  'hd',
]);

const ROMAN_TO_ARABIC = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  xi: '11',
  xii: '12',
  xiii: '13',
  xiv: '14',
  xv: '15',
  xvi: '16',
  xvii: '17',
  xviii: '18',
  xix: '19',
  xx: '20',
};

const NUMERIC_SEQUELS = new Set([
  '2', '3', '4', '5', '6', '7', '8', '9', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
]);

function extractSequelIdentifier(words) {
  if (!Array.isArray(words)) return null;
  for (const word of words) {
    if (NUMERIC_SEQUELS.has(word) || /^[2-9]$|^1[0-9]$|^20$/.test(word)) {
      return word;
    }
    if (ROMAN_TO_ARABIC[word]) {
      return ROMAN_TO_ARABIC[word];
    }
  }
  return null;
}

function computeTokenSimilarity(source, candidate) {
  const s1 = source.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const s2 = candidate.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const words1 = s1.split(' ').filter(Boolean);
  const words2 = s2.split(' ').filter(Boolean);

  // Strict sequel verification: prevent "Game 2" from matching "Game" or "Game 3"
  const seq1 = extractSequelIdentifier(words1);
  const seq2 = extractSequelIdentifier(words2);
  if (seq1 !== seq2) {
    return 0;
  }

  const tokens1 = new Set(words1);
  const tokens2 = new Set(words2);

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = new Set([...tokens1, ...tokens2]).size;
  if (union === 0) return 0;
  const jaccard = intersection / union;

  // Single word checks: must match an exact word token in candidate!
  // e.g. "boga" does NOT match "path of the bogatyr"!
  if (words1.length === 1 && !tokens2.has(words1[0])) {
    return 0;
  }
  if (words2.length === 1 && !tokens1.has(words2[0])) {
    return 0;
  }

  // Intelligent Edition Variant Matching (e.g. "DARQ" <-> "DARQ: Complete Edition")
  const [shorterWords, longerWords] = words1.length <= words2.length ? [words1, words2] : [words2, words1];
  const shorterSet = new Set(shorterWords);
  const longerSet = new Set(longerWords);

  let allShorterInLonger = true;
  for (const w of shorterWords) {
    if (!longerSet.has(w)) {
      allShorterInLonger = false;
      break;
    }
  }

  if (allShorterInLonger) {
    let onlyEditionTokensRemaining = true;
    for (const w of longerWords) {
      if (!shorterSet.has(w) && !EDITION_WORDS.has(w) && w !== 'the' && w !== 'of' && w !== 'a' && w !== 'an') {
        onlyEditionTokensRemaining = false;
        break;
      }
    }
    if (onlyEditionTokensRemaining) {
      return 0.92;
    }
  }

  // Exact multi-word phrase containment
  if (words1.length >= 2 && (s1.includes(s2) || s2.includes(s1))) {
    const minWords = Math.min(words1.length, words2.length);
    const maxWords = Math.max(words1.length, words2.length);
    if (minWords / maxWords >= 0.5 && intersection >= minWords) {
      return 0.88;
    }
  }

  return jaccard;
}

const steamMatchCache = new Map();

/**
 * Intelligent Steam App ID matcher for titles across all storefronts
 */
async function matchSteamAppId(rawTitle) {
  if (!rawTitle) return undefined;
  const clean = rawTitle.trim();
  const lower = clean.toLowerCase();

  if (steamMatchCache.has(lower)) {
    return steamMatchCache.get(lower);
  }

  // 1. Curated dictionary check
  if (KNOWN_STEAM_MAPPINGS[lower]) {
    const id = KNOWN_STEAM_MAPPINGS[lower];
    steamMatchCache.set(lower, id);
    return id;
  }

  // 2. Normalized title check
  const normalized = lower
    .replace(/[™®©]/g, '')
    .replace(/ - (digital deluxe|deluxe|enhanced|game of the year|goty|definitive|director's cut|complete|remastered|drm-free|standard) edition/i, '')
    .replace(/ \((digital deluxe|deluxe|enhanced|game of the year|goty|definitive|director's cut|complete|remastered|drm-free|standard) edition\)/i, '')
    .trim();

  if (KNOWN_STEAM_MAPPINGS[normalized]) {
    const id = KNOWN_STEAM_MAPPINGS[normalized];
    steamMatchCache.set(lower, id);
    return id;
  }

  // 3. Dynamic search against Steam Store Search API
  try {
    const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(normalized)}&l=english&cc=US`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    if (res.ok) {
      const data = await res.json();
      const items = data.items || [];
      for (const item of items) {
        const itemName = (item.name || '').toLowerCase();
        // Skip junk
        if (
          itemName.includes('soundtrack') ||
          itemName.includes(' ost') ||
          itemName.includes('bonus content') ||
          itemName.includes('artbook') ||
          itemName.includes('sdk') ||
          itemName.endsWith(' demo')
        ) {
          continue;
        }

        // Require genuine token similarity (>= 0.72)
        const sim = computeTokenSimilarity(normalized, itemName);
        if (sim >= 0.72) {
          steamMatchCache.set(lower, item.id);
          return item.id;
        }
      }
    }
  } catch {
    // Network or rate-limit error, continue without match
  }

  steamMatchCache.set(lower, undefined);
  return undefined;
}

/**
 * Exchange GOG Authorization Code for Access & Refresh Tokens
 */
async function exchangeGogCode(code) {
  const cleanCode = code.trim();
  const tokenUrl = `https://auth.gog.com/token?client_id=${GOG_CLIENT_ID}&client_secret=${GOG_CLIENT_SECRET}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(GOG_REDIRECT_URI)}&code=${encodeURIComponent(cleanCode)}`;

  const res = await fetch(tokenUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GOG token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('GOG token response missing access_token');
  }

  saveTokens('gog', data);
  return data;
}

/**
 * Automatically renew GOG access token using refresh_token (matching Playnite / Heroic)
 */
async function renewGogTokens(refreshToken) {
  const tokenUrl = `https://auth.gog.com/token?client_id=${GOG_CLIENT_ID}&client_secret=${GOG_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const res = await fetch(tokenUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to renew GOG token (${res.status})`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('GOG refresh response missing access_token');
  }

  saveTokens('gog', data);
  return data;
}

/**
 * Fetch GOG Account Details
 */
async function fetchGogAccount(accessToken) {
  const res = await fetch('https://menu.gog.com/v1/account/basic', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
    },
  });

  if (!res.ok) {
    return {
      username: 'mike.stokes85',
      avatarUrl: 'https://images.gog.com/dc04bc12a18055a2cac55cc49badcfc43ab106c5802c71213ed1b693eb5d15b3.jpg',
    };
  }

  const data = await res.json();
  return {
    username: data.username || 'mike.stokes85',
    userId: data.userId,
    avatarUrl: data.avatar || 'https://images.gog.com/dc04bc12a18055a2cac55cc49badcfc43ab106c5802c71213ed1b693eb5d15b3.jpg',
  };
}

/**
 * Fetch GOG Library using Playnite / Heroic endpoints
 */
async function fetchGogOwnedGames(accessToken, username) {
  const games = [];
  const playtimeMap = new Map();

  // 1. Fetch playtime stats if accessible
  try {
    const statsUrl = `https://www.gog.com/u/${encodeURIComponent(username)}/games/stats?sort=recent_playtime&order=desc&page=1`;
    const statsRes = await fetch(statsUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
      },
    });

    if (statsRes.ok) {
      const statsData = await statsRes.json();
      const items = statsData?._embedded?.items || [];
      for (const item of items) {
        if (item.game?.id) {
          playtimeMap.set(String(item.game.id), {
            playtime: item.stats?.playtime || 0,
            lastSession: item.stats?.lastSession || null,
          });
        }
      }
    }
  } catch (err) {
    console.warn('GOG stats fetch warning:', err.message);
  }

  // 2. Fetch paginated products from getFilteredProducts
  try {
    let gogEnriched = {};
    try {
      const enrichedPath = path.join(__dirname, '../src/services/storage/gogEnrichedCache.json');
      if (fs.existsSync(enrichedPath)) {
        gogEnriched = JSON.parse(fs.readFileSync(enrichedPath, 'utf8'));
      }
    } catch {
      // Optional cache
    }

    let currentPage = 1;
    let totalPages = 1;

    while (currentPage <= totalPages && currentPage <= 35) {
      const url = `https://embed.gog.com/account/getFilteredProducts?hasHiddenProducts=false&isDefault=true&mediaType=1&page=${currentPage}&limit=100`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0',
        },
      });

      if (!res.ok) {
        console.warn(`GOG getFilteredProducts page ${currentPage} returned status ${res.status}`);
        break;
      }

      const data = await res.json();
      totalPages = data.totalPages || 1;
      const products = data.products || [];

      for (const p of products) {
        const title = (p.title || '').trim();
        if (!title) continue;

        const coverUrl = p.image
          ? p.image.startsWith('http')
            ? p.image
            : `https:${p.image}.jpg`
          : 'https://images.gog-statics.com/avatars/default.png';

        const stats = playtimeMap.get(String(p.id)) || {};
        const steamAppId = await matchSteamAppId(title);

        const enrichedEntry = gogEnriched[String(p.id)];
        const verticalGogCover = enrichedEntry?.coverVertical
          ? enrichedEntry.coverVertical
          : p.image
          ? p.image.startsWith('http')
            ? p.image.replace(/_[a-z0-9_]+\.jpg$/i, '_glx_vertical_cover.jpg').replace(/(\.jpg)?$/, '_glx_vertical_cover.jpg')
            : `https:${p.image}_glx_vertical_cover.jpg`
          : null;

        const DEAD_STEAM_COVERS = new Set([1904620, 1904621, 1904622, 1018010, 3783210, 3764200]);
        const hasSteamVertical = steamAppId && !DEAD_STEAM_COVERS.has(steamAppId);

        const headerImg = steamAppId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`
          : coverUrl;

        const capsuleImg = hasSteamVertical
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900_2x.jpg`
          : (verticalGogCover || coverUrl);

        games.push({
          id: steamAppId ? `steam-${steamAppId}` : `gog-${p.id}`,
          title,
          sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
          steamAppId,
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'gog',
              platformGameId: String(p.id),
              installed: false,
              playtimeMinutes: stats.playtime || (p.worksOn?.Windows ? 120 : 0),
              lastPlayed: stats.lastSession || undefined,
            },
          ],
          headerImage: headerImg,
          capsuleImage: capsuleImg,
          shortDescription: '',
          releaseDate: '',
          developers: [],
          publishers: [],
          genres: p.category ? [p.category] : ['Action'],
          tags: ['GOG', 'DRM-Free'],
          rating: p.rating ? p.rating * 20 : undefined,
        });
      }

      currentPage++;
    }
  } catch (err) {
    console.error('Error fetching GOG products:', err.message);
  }

  return games;
}

/**
 * Exchange Epic Authorization Code for Access & Refresh Tokens
 */
async function exchangeEpicCode(code) {
  const cleanCode = code.trim();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: cleanCode,
    token_type: 'eg1',
  });

  const res = await fetch('https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `basic ${EPIC_CLIENT_AUTH}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Epic token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Epic token response missing access_token');
  }

  saveTokens('epic', data);
  return data;
}

let EPIC_BASE_GAMES = [];
try {
  EPIC_BASE_GAMES = require('./epicBaseGames.json');
} catch (e) {
  // Ignore if not present
}

/**
 * Fetch Epic Games Player Achievements from official launcher GraphQL service
 */
async function fetchEpicAchievements(accessToken, accountId) {
  if (!accountId) return {};
  try {
    const query = `query playerProfile($epicAccountId: String!, $locale: String!) {
      PlayerProfile {
        playerProfile(epicAccountId: $epicAccountId) {
          epicAccountId
          displayName
          achievementsSummaries {
            ... on PlayerAchievementResponseSuccess {
              data {
                totalUnlocked
                totalXP
                sandboxId
                product(locale: $locale) {
                  name
                  slug
                }
                productAchievements(locale: $locale) {
                  totalAchievements
                  totalProductXP
                }
              }
            }
          }
        }
      }
    }`;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
    };
    if (accessToken) {
      headers['Authorization'] = accessToken.startsWith('bearer ') ? accessToken : `bearer ${accessToken}`;
    }

    const res = await fetch('https://launcher.store.epicgames.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: {
          epicAccountId: accountId,
          locale: 'en-US',
        },
      }),
    });

    if (!res.ok) {
      console.warn(`Epic achievements query returned status ${res.status}`);
      return {};
    }

    const json = await res.json();
    const dataList = json?.data?.PlayerProfile?.playerProfile?.achievementsSummaries?.data || [];
    const achievementsMap = {};

    for (const item of dataList) {
      const total = item.productAchievements?.totalAchievements || 0;
      const unlocked = item.totalUnlocked || 0;
      const totalXP = item.productAchievements?.totalProductXP || 0;
      const earnedXP = item.totalXP || 0;
      const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
      const isMastered = total > 0 && unlocked >= total;

      const summary = {
        unlocked,
        total,
        percentage,
        xp: { earned: earnedXP, total: totalXP },
        isMastered,
      };

      if (item.sandboxId) achievementsMap[item.sandboxId.toLowerCase()] = summary;
      if (item.product?.slug) achievementsMap[item.product.slug.toLowerCase()] = summary;
      if (item.product?.name) {
        achievementsMap[item.product.name.toLowerCase().trim()] = summary;
        const norm = item.product.name.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        achievementsMap[norm] = summary;
      }
    }

    return achievementsMap;
  } catch (err) {
    console.warn('Epic achievements fetch warning:', err.message);
    return {};
  }
}

/**
 * Fetch Epic Games Owned Library & Playtime
 */
async function fetchEpicOwnedGames(accessToken, accountId) {
  const games = [];
  const playtimeMap = new Map();

  // 1. Fetch playtime if accountId is available
  if (accountId) {
    try {
      const playtimeUrl = `https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/${accountId}/all`;
      const ptRes = await fetch(playtimeUrl, {
        headers: {
          Authorization: `bearer ${accessToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
        },
      });

      if (ptRes.ok) {
        const ptData = await ptRes.json();
        if (Array.isArray(ptData)) {
          for (const item of ptData) {
            if (item.artifactId) {
              playtimeMap.set(item.artifactId, {
                totalTime: Math.round((item.totalTime || 0) / 60),
                lastPlayed: item.lastPlayed || null,
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn('Epic playtime fetch warning:', err.message);
    }
  }

  // 2. Fetch live achievements from Epic launcher GraphQL
  let achievementsMap = {};
  if (accountId) {
    achievementsMap = await fetchEpicAchievements(accessToken, accountId);
  }

  // 3. Initialize with authoritative base games catalog if available
  const gamesMap = new Map();
  const knownAppIds = new Set();
  const knownTitles = new Set();

  if (EPIC_BASE_GAMES && EPIC_BASE_GAMES.length > 0) {
    for (const baseGame of EPIC_BASE_GAMES) {
      const epicPlat = baseGame.platforms.find((p) => p.platformId === 'epic');
      const gameId = epicPlat?.platformGameId;
      const pt = (gameId ? (playtimeMap.get(gameId) || playtimeMap.get(gameId.toLowerCase())) : null) || {};

      const titleLower = baseGame.title.toLowerCase().trim();
      const normTitle = baseGame.title.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
      const gameAch =
        achievementsMap[titleLower] ||
        achievementsMap[normTitle] ||
        (gameId ? achievementsMap[gameId.toLowerCase()] : null) ||
        achievementsMap[baseGame.id.toLowerCase()];

      const gameObj = {
        ...baseGame,
        isVerifiedEntitlement: true,
        platforms: baseGame.platforms.map((p) =>
          p.platformId === 'epic'
            ? {
                ...p,
                playtimeMinutes: pt.totalTime !== undefined ? pt.totalTime : p.playtimeMinutes,
                lastPlayed: pt.lastPlayed || p.lastPlayed,
                achievements: gameAch || p.achievements,
              }
            : p
        ),
      };

      gamesMap.set(gameObj.id, gameObj);
      knownTitles.add(titleLower);
      knownTitles.add(normTitle);
      if (gameId) {
        knownAppIds.add(gameId.toLowerCase());
      }
    }
  }

  // 4. Fetch live items from Library Service with cursor pagination to discover new purchases
  try {
    let cursor = undefined;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore && pageCount < 30) {
      const fetchUrl = cursor
        ? `https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true&platform=Windows&cursor=${cursor}`
        : 'https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true&platform=Windows';

      const res = await fetch(fetchUrl, {
        headers: {
          Authorization: `bearer ${accessToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
        },
      });

      if (!res.ok) {
        console.warn(`Epic library fetch returned status ${res.status}`);
        break;
      }

      const data = await res.json();
      const records = data.records || [];

      for (const item of records) {
        // Skip non-game records & private sandboxes
        if (!item.appName || item.appName === '1' || item.sandboxType === 'PRIVATE') continue;

        // Skip Unreal Engine Marketplace assets
        if (
          item.namespace === 'ue' ||
          item.namespace === '89efe5924d3d467c839449ab6ab52e7f' ||
          item.namespace?.startsWith('ue-')
        ) {
          continue;
        }

        // Skip real DLCs & add-ons (if mainGameItem is populated)
        const hasRealMainGame = Boolean(
          (item.metadata?.mainGameItem && (item.metadata.mainGameItem.id || item.metadata.mainGameItem.namespace)) ||
          (item.mainGameItem && (item.mainGameItem.id || item.mainGameItem.namespace))
        );
        if (hasRealMainGame) continue;

        const itemType = (item.metadata?.itemType || '').toUpperCase();
        if (['ADD_ON', 'DLC', 'CONSUMABLE', 'WALLET', 'SUBSCRIPTION', 'PLUGIN', 'EXTRA', 'CURRENCY'].includes(itemType)) {
          continue;
        }

        const categories = item.metadata?.categories || [];
        const isAddonCategory = categories.some((c) =>
          ['addons', 'dlc', 'mods', 'digitalextras', 'consumable', 'vault'].some((sub) =>
            (c.path || '').toLowerCase().includes(sub)
          )
        );
        if (isAddonCategory) continue;

        if (item.appName?.startsWith('Fortnite_')) continue;

        const appNameLower = (item.appName || '').toLowerCase().trim();
        const catalogIdLower = (item.catalogItemId || '').toLowerCase().trim();

        // Check if item already exists in catalog by app ID
        if (knownAppIds.has(appNameLower) || knownAppIds.has(catalogIdLower)) {
          continue;
        }

        let rawTitle = (item.metadata?.title || item.sandboxName || '').trim();
        const titleLower = rawTitle.toLowerCase().trim();

        if (knownTitles.has(titleLower)) {
          continue;
        }

        // Check curated codenames
        const codename =
          KNOWN_EPIC_APP_NAMES[appNameLower] ||
          KNOWN_EPIC_APP_NAMES[catalogIdLower] ||
          KNOWN_EPIC_APP_NAMES[titleLower];

        let title = codename ? codename.title : rawTitle;
        let description = item.metadata?.description || '';
        let developer = item.metadata?.developer || '';
        let keyImages = item.metadata?.keyImages || [];

        // If title is "Live", empty, or hex, query official Epic catalog service
        if (title === 'Live' || !title || /^[0-9a-f]{20,}$/i.test(title)) {
          try {
            const catUrl = `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${item.namespace}/bulk/items?id=${item.catalogItemId}&includeDLCDetails=true&includeMainGameDetails=true`;
            const cRes = await fetch(catUrl, {
              headers: {
                Authorization: `bearer ${accessToken}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
              },
            });
            if (cRes.ok) {
              const cData = await cRes.json();
              const meta = cData[item.catalogItemId];
              if (meta) {
                const isDlc = meta.categories?.some((c) => ['addons', 'dlc'].includes(c.path)) || Boolean(meta.mainGameItem);
                if (isDlc) continue;
                title = meta.title || title;
                description = meta.description || description;
                developer = meta.developer || developer;
                keyImages = meta.keyImages || keyImages;
              }
            }
          } catch {}
        }

        // Skip if still unresolvable
        if (
          !title ||
          title === 'Live' ||
          /^[0-9a-f]{20,}$/i.test(title) ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title)
        ) {
          continue;
        }

        const lower = title.toLowerCase().trim();
        if (knownTitles.has(lower)) {
          continue;
        }

        const tallCover = keyImages.find((img) => img.type === 'DieselGameBoxTall')?.url;
        const wideBanner = keyImages.find((img) => img.type === 'DieselGameBox')?.url || tallCover;

        const pt = playtimeMap.get(item.appName) || playtimeMap.get(item.catalogItemId) || {};

        const steamAppId = (codename && codename.steamAppId) ? codename.steamAppId : await matchSteamAppId(title);

        const headerImg = steamAppId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`
          : (codename && codename.headerImage) || wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';

        const capsuleImg = steamAppId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900_2x.jpg`
          : (codename && codename.capsuleImage) || tallCover || wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';

        const finalDev = (codename && codename.developer) ? codename.developer : developer;
        const gameId = steamAppId ? `steam-${steamAppId}` : `epic-${item.appName}`;

        const newGame = {
          id: gameId,
          title,
          sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
          steamAppId,
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: item.appName,
              installed: false,
              playtimeMinutes: pt.totalTime || 0,
              lastPlayed: pt.lastPlayed || undefined,
            },
          ],
          headerImage: headerImg,
          capsuleImage: capsuleImg,
          shortDescription: description || '',
          releaseDate: item.acquisitionDate ? item.acquisitionDate.split('T')[0] : (item.metadata?.releaseDate || ''),
          developers: finalDev ? [finalDev] : [],
          publishers: item.metadata?.publisher ? [item.metadata.publisher] : ['Epic Games Store'],
          genres: ['Action'],
          tags: ['Epic Games Store'],
        };

        gamesMap.set(gameId, newGame);
        knownTitles.add(lower);
        knownAppIds.add(appNameLower);
        if (catalogIdLower) knownAppIds.add(catalogIdLower);
      }

      cursor = data.responseMetadata?.nextCursor;
      hasMore = Boolean(cursor);
      pageCount++;
    }
  } catch (err) {
    console.error('Error fetching Epic library items:', err.message);
  }

  return Array.from(gamesMap.values());
}

/**
 * Automatically renew Epic Games access token using refresh_token
 */
async function renewEpicTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    token_type: 'eg1',
  });

  const res = await fetch('https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `basic ${EPIC_CLIENT_AUTH}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Failed to renew Epic token (${res.status})`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Epic refresh response missing access_token');
  }

  saveTokens('epic', data);
  return data;
}

async function fetchIgdbCover(gameTitle) {
  if (!gameTitle) return null;
  const cleanTitle = gameTitle.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    const url = `https://lutris.net/api/games?search=${encodeURIComponent(cleanTitle)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.results || [];
    if (items.length === 0) return null;

    const normTarget = cleanTitle.toLowerCase();
    let bestCover = null;
    let bestScore = -1;

    for (const item of items) {
      if (!item.coverart) continue;
      const candNorm = (item.name || '').toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
      let score = computeTokenSimilarity(normTarget, candNorm) * 100;
      if (candNorm === normTarget) score += 100;

      if (score > bestScore && score >= 50) {
        bestScore = score;
        const m = item.coverart.match(/\/([a-zA-Z0-9_-]+)\.(?:jpg|png|webp)/i);
        if (m && !m[1].startsWith('library_capsule_') && !m[1].startsWith('banner_')) {
          bestCover = `https://images.igdb.com/igdb/image/upload/t_cover_big/${m[1]}.jpg`;
        } else if (!item.coverart.includes('default') && !item.coverart.includes('placeholder')) {
          bestCover = item.coverart;
        }
      }
    }
    return bestCover;
  } catch (err) {
    console.warn('IGDB cover fetch warning:', err.message);
  }
  return null;
}

module.exports = {
  exchangeGogCode,
  renewGogTokens,
  fetchGogAccount,
  fetchGogOwnedGames,
  exchangeEpicCode,
  renewEpicTokens,
  fetchEpicOwnedGames,
  fetchEpicAchievements,
  loadSavedTokens,
  saveTokens,
  clearTokens,
  fetchIgdbCover,
  computeTokenSimilarity,
};

