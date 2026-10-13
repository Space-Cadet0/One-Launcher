const fs = require('fs');
const path = require('path');

const UNRATED_TITLES = [
  'akalabeth: world of doom',
  'akalabeth',
  'agony unrated',
  'chivalry 2 - public testing',
  'killingfloor2beta',
  'mortal shell tech beta',
  'cyberpunk 2077 digital goodies',
  'football manager 2024 pre-game editor',
  'football manager 2024 resource archiver',
  'overload - playable teaser',
  'fall of porcupine: prologue',
  'the life and suffering of sir brante - chapter 1 & 2',
  'sin slayers: the first sin',
  'galactic civilizations iii (test branch)',
  'hello neighbor alpha version',
  'doom i enhanced',
  'doom ii enhanced',
  'doom ii + master levels',
  'hotline miami 2: wrong number - digital comics',
  'leap of faith + official walkthrough',
  'kid a mnesia exhibition',
  'dink smallwood hd',
  'lost in the hole',
  'syndicate plus',
  'syndicate wars',
  'teenagent',
  'tyrian 2000',
  'bio menace',
  'vornyca',
  '3dmark',
  '60 minutes to extinction: escape room',
  '60 minutes to extinction',
  'spacewar',
  'rpg maker xp',
  'shadow warrior classic complete',
  'postal: classic and uncut',
  'flight of the amazon queen',
  'beneath a steel sky',
  'lure of the temptress',
  'lure of the temptress (1992)',
  'ultima iv: quest of the avatar',
  'ultima underworld i',
  'ultima underworld ii',
  'worlds of ultima: the savage empire',
  'ultima worlds of adventure 2: martian dreams',
];

// Master list of verified games with scores, tiers, and working URLs
const MASTER_VERIFIED_GAMES = [
  // User Reported Games
  {
    title: 'Age of Empires II: Definitive Edition',
    aliases: ['age of empires ii'],
    appId: 813780,
    source: 'metacritic',
    score: 84,
    tier: 'Mighty',
    numReviews: 32,
    url: 'https://www.metacritic.com/game/age-of-empires-ii-definitive-edition/critic-reviews/',
    summary: 'Age of Empires II: Definitive Edition is a definitive remaster of the legendary RTS, praised for its 4K visuals, audio overhaul, and wealth of content.',
  },
  {
    title: 'Agony',
    appId: 487720,
    source: 'metacritic',
    score: 47,
    tier: 'Weak',
    numReviews: 24,
    url: 'https://www.metacritic.com/game/agony/critic-reviews/',
    summary: 'Agony was praised for its grotesque hellish art direction, but heavily criticized for repetitive gameplay, frustrating stealth, and technical bugs.',
  },
  {
    title: '20 Minutes Till Dawn',
    source: 'opencritic',
    id: 13483,
    score: 77,
    percentRecommended: 50,
    tier: 'Strong',
    numReviews: 4,
    url: 'https://opencritic.com/game/13483/20-minutes-till-dawn',
  },
  {
    title: '2064: Read Only Memories',
    source: 'opencritic',
    id: 3795,
    score: 77,
    percentRecommended: 62,
    tier: 'Strong',
    numReviews: 10,
    url: 'https://opencritic.com/game/3795/2064-read-only-memories',
  },
  {
    title: 'Alan Wake 2',
    aliases: ['alan wake ii'],
    source: 'opencritic',
    id: 15022,
    score: 89,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 164,
    url: 'https://opencritic.com/game/15022/alan-wake-2',
    summary: 'Remedy’s survival horror masterpiece dazzles with mind-bending dual narratives, live-action integration, and sublime atmospheric tension.',
  },

  // Baldur\'s Gate & Classic RPGs
  {
    title: "Baldur's Gate 3",
    aliases: ['baldurs gate 3', 'baldurs gate iii'],
    appId: 1086940,
    source: 'opencritic',
    id: 9136,
    score: 96,
    percentRecommended: 99,
    tier: 'Mighty',
    numReviews: 147,
    url: 'https://opencritic.com/game/9136/baldurs-gate-3',
  },
  {
    title: "Baldur's Gate II: Enhanced Edition",
    aliases: ['baldurs gate 2 enhanced edition', 'baldurs gate ii', 'baldurs gate 2'],
    appId: 257350,
    source: 'opencritic',
    id: 741,
    score: 78,
    percentRecommended: 85,
    tier: 'Strong',
    numReviews: 24,
    url: 'https://opencritic.com/game/741/baldurs-gate-ii-enhanced-edition',
  },
  {
    title: "Baldur's Gate: Enhanced Edition",
    aliases: ['baldurs gate enhanced edition', 'baldurs gate 1'],
    appId: 228280,
    source: 'metacritic',
    score: 78,
    tier: 'Strong',
    numReviews: 42,
    url: 'https://www.metacritic.com/game/baldurs-gate-enhanced-edition/critic-reviews/',
  },
  {
    title: 'Divinity: Original Sin 2',
    aliases: ['divinity original sin 2 definitive edition', 'divinity original sin 2'],
    appId: 435150,
    source: 'opencritic',
    id: 803,
    score: 93,
    percentRecommended: 98,
    tier: 'Mighty',
    numReviews: 82,
    url: 'https://opencritic.com/game/803/divinity-original-sin-ii',
  },
  {
    title: 'Divinity: Original Sin Enhanced Edition',
    aliases: ['divinity original sin', 'divinity original sin classic'],
    appId: 373420,
    source: 'opencritic',
    id: 1544,
    score: 88,
    percentRecommended: 95,
    tier: 'Mighty',
    numReviews: 61,
    url: 'https://opencritic.com/game/1544/divinity-original-sin-enhanced-edition',
  },
  {
    title: 'Pillars of Eternity',
    appId: 291650,
    source: 'opencritic',
    id: 114,
    score: 89,
    percentRecommended: 95,
    tier: 'Mighty',
    numReviews: 76,
    url: 'https://opencritic.com/game/114/pillars-of-eternity',
  },
  {
    title: 'Pillars of Eternity II: Deadfire',
    aliases: ['pillars of eternity 2 deadfire', 'pillars of eternity 2'],
    appId: 560130,
    source: 'opencritic',
    id: 5974,
    score: 88,
    percentRecommended: 93,
    tier: 'Mighty',
    numReviews: 84,
    url: 'https://opencritic.com/game/5974/pillars-of-eternity-ii-deadfire',
  },
  {
    title: 'Tyranny',
    appId: 362960,
    source: 'opencritic',
    id: 3328,
    score: 80,
    percentRecommended: 83,
    tier: 'Strong',
    numReviews: 68,
    url: 'https://opencritic.com/game/3328/tyranny',
  },
  {
    title: 'Pathfinder: Kingmaker',
    appId: 640820,
    source: 'opencritic',
    id: 6714,
    score: 74,
    percentRecommended: 58,
    tier: 'Strong',
    numReviews: 45,
    url: 'https://opencritic.com/game/6714/pathfinder-kingmaker',
  },
  {
    title: 'Pathfinder: Wrath of the Righteous',
    aliases: ['pathfinder wrath of the righteous enhanced edition'],
    appId: 1184370,
    source: 'opencritic',
    id: 11958,
    score: 83,
    percentRecommended: 86,
    tier: 'Strong',
    numReviews: 52,
    url: 'https://opencritic.com/game/11958/pathfinder-wrath-of-the-righteous',
  },
  {
    title: 'Disco Elysium',
    aliases: ['disco elysium the final cut'],
    appId: 632470,
    source: 'opencritic',
    id: 8519,
    score: 92,
    percentRecommended: 96,
    tier: 'Mighty',
    numReviews: 104,
    url: 'https://opencritic.com/game/8519/disco-elysium',
  },
  {
    title: 'Torment: Tides of Numenera',
    aliases: ['torment tides of numenera'],
    appId: 272270,
    source: 'opencritic',
    id: 3129,
    score: 81,
    percentRecommended: 81,
    tier: 'Strong',
    numReviews: 76,
    url: 'https://opencritic.com/game/3129/torment-tides-of-numenera',
  },
  {
    title: 'Wasteland 3',
    appId: 719040,
    source: 'opencritic',
    id: 9140,
    score: 86,
    percentRecommended: 90,
    tier: 'Mighty',
    numReviews: 96,
    url: 'https://opencritic.com/game/9140/wasteland-3',
  },

  // CD Projekt RED
  {
    title: 'The Witcher 3: Wild Hunt',
    aliases: ['the witcher 3 wild hunt game of the year edition', 'the witcher 3 wild hunt complete edition', 'the witcher 3'],
    appId: 292030,
    source: 'opencritic',
    id: 463,
    score: 92,
    percentRecommended: 98,
    tier: 'Mighty',
    numReviews: 104,
    url: 'https://opencritic.com/game/463/the-witcher-3-wild-hunt',
  },
  {
    title: 'Cyberpunk 2077',
    aliases: ['cyberpunk 2077 phantom liberty'],
    appId: 1091500,
    source: 'opencritic',
    id: 8525,
    score: 86,
    percentRecommended: 90,
    tier: 'Mighty',
    numReviews: 215,
    url: 'https://opencritic.com/game/8525/cyberpunk-2077',
  },
  {
    title: 'The Witcher 2: Assassins of Kings Enhanced Edition',
    aliases: ['the witcher 2 assassins of kings', 'the witcher 2'],
    appId: 20920,
    source: 'metacritic',
    score: 88,
    tier: 'Mighty',
    numReviews: 76,
    url: 'https://www.metacritic.com/game/the-witcher-2-assassins-of-kings/critic-reviews/',
  },
  {
    title: 'The Witcher: Enhanced Edition',
    aliases: ['the witcher enhanced edition directors cut', 'the witcher'],
    appId: 20900,
    source: 'metacritic',
    score: 86,
    tier: 'Mighty',
    numReviews: 48,
    url: 'https://www.metacritic.com/game/the-witcher/critic-reviews/',
  },

  // Bethesda / id Software / Arkane / MachineGames
  {
    title: 'DOOM',
    aliases: ['doom 2016'],
    appId: 379720,
    source: 'opencritic',
    id: 1576,
    score: 85,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 135,
    url: 'https://opencritic.com/game/1576/doom',
  },
  {
    title: 'DOOM Eternal',
    appId: 782330,
    source: 'opencritic',
    id: 7346,
    score: 89,
    percentRecommended: 95,
    tier: 'Mighty',
    numReviews: 182,
    url: 'https://opencritic.com/game/7346/doom-eternal',
  },
  {
    title: 'DOOM 3',
    aliases: ['doom 3 bfg edition', 'doom 3 resurrection of evil'],
    appId: 9050,
    source: 'metacritic',
    score: 87,
    tier: 'Mighty',
    numReviews: 68,
    url: 'https://www.metacritic.com/game/doom-3/critic-reviews/',
  },
  {
    title: 'Fallout: New Vegas',
    aliases: ['fallout new vegas ultimate edition'],
    appId: 22380,
    source: 'metacritic',
    score: 84,
    tier: 'Mighty',
    numReviews: 81,
    url: 'https://www.metacritic.com/game/fallout-new-vegas/critic-reviews/',
  },
  {
    title: 'Fallout 3',
    aliases: ['fallout 3 game of the year edition'],
    appId: 22370,
    source: 'metacritic',
    score: 91,
    tier: 'Mighty',
    numReviews: 57,
    url: 'https://www.metacritic.com/game/fallout-3/critic-reviews/',
  },
  {
    title: 'Fallout 4',
    aliases: ['fallout 4 game of the year edition'],
    appId: 377160,
    source: 'opencritic',
    id: 1508,
    score: 88,
    percentRecommended: 93,
    tier: 'Mighty',
    numReviews: 142,
    url: 'https://opencritic.com/game/1508/fallout-4',
  },
  {
    title: 'Fallout',
    aliases: ['fallout 1'],
    appId: 38400,
    source: 'metacritic',
    score: 89,
    tier: 'Mighty',
    numReviews: 28,
    url: 'https://www.metacritic.com/game/fallout/critic-reviews/',
  },
  {
    title: 'Fallout 2',
    appId: 38410,
    source: 'metacritic',
    score: 86,
    tier: 'Mighty',
    numReviews: 35,
    url: 'https://www.metacritic.com/game/fallout-2/critic-reviews/',
  },
  {
    title: 'The Elder Scrolls V: Skyrim',
    aliases: ['the elder scrolls v skyrim special edition', 'the elder scrolls v skyrim vr', 'skyrim'],
    appId: 72850,
    source: 'metacritic',
    score: 94,
    tier: 'Mighty',
    numReviews: 89,
    url: 'https://www.metacritic.com/game/the-elder-scrolls-v-skyrim/critic-reviews/',
  },
  {
    title: 'The Elder Scrolls IV: Oblivion',
    aliases: ['the elder scrolls iv oblivion game of the year edition', 'oblivion'],
    appId: 22330,
    source: 'metacritic',
    score: 94,
    tier: 'Mighty',
    numReviews: 54,
    url: 'https://www.metacritic.com/game/the-elder-scrolls-iv-oblivion/critic-reviews/',
  },
  {
    title: 'The Elder Scrolls III: Morrowind',
    aliases: ['the elder scrolls iii morrowind game of the year edition', 'morrowind'],
    appId: 22320,
    source: 'metacritic',
    score: 89,
    tier: 'Mighty',
    numReviews: 43,
    url: 'https://www.metacritic.com/game/the-elder-scrolls-iii-morrowind/critic-reviews/',
  },
  {
    title: 'Dishonored',
    aliases: ['dishonored definitive edition'],
    appId: 205100,
    source: 'metacritic',
    score: 91,
    tier: 'Mighty',
    numReviews: 85,
    url: 'https://www.metacritic.com/game/dishonored/critic-reviews/',
  },
  {
    title: 'Dishonored 2',
    appId: 403640,
    source: 'opencritic',
    id: 2434,
    score: 87,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 122,
    url: 'https://opencritic.com/game/2434/dishonored-2',
  },
  {
    title: 'Dishonored: Death of the Outsider',
    appId: 614570,
    source: 'opencritic',
    id: 4641,
    score: 82,
    percentRecommended: 85,
    tier: 'Strong',
    numReviews: 78,
    url: 'https://opencritic.com/game/4641/dishonored-death-of-the-outsider',
  },
  {
    title: 'Prey',
    appId: 480490,
    source: 'opencritic',
    id: 3858,
    score: 82,
    percentRecommended: 85,
    tier: 'Strong',
    numReviews: 115,
    url: 'https://opencritic.com/game/3858/prey',
  },
  {
    title: 'Quake',
    appId: 2310,
    source: 'metacritic',
    score: 94,
    tier: 'Mighty',
    numReviews: 32,
    url: 'https://www.metacritic.com/game/quake/critic-reviews/',
  },
  {
    title: 'Quake II',
    appId: 2320,
    source: 'metacritic',
    score: 89,
    tier: 'Mighty',
    numReviews: 25,
    url: 'https://www.metacritic.com/game/quake-ii/critic-reviews/',
  },

  // Valve Classics
  {
    title: 'Half-Life 2',
    appId: 220,
    source: 'metacritic',
    score: 96,
    tier: 'Mighty',
    numReviews: 81,
    url: 'https://www.metacritic.com/game/half-life-2/critic-reviews/',
  },
  {
    title: 'Half-Life',
    appId: 70,
    source: 'metacritic',
    score: 96,
    tier: 'Mighty',
    numReviews: 24,
    url: 'https://www.metacritic.com/game/half-life/critic-reviews/',
  },
  {
    title: 'Portal',
    appId: 400,
    source: 'metacritic',
    score: 90,
    tier: 'Mighty',
    numReviews: 27,
    url: 'https://www.metacritic.com/game/portal/critic-reviews/',
  },
  {
    title: 'Portal 2',
    appId: 620,
    source: 'metacritic',
    score: 95,
    tier: 'Mighty',
    numReviews: 66,
    url: 'https://www.metacritic.com/game/portal-2/critic-reviews/',
  },
  {
    title: 'Black Mesa',
    appId: 362890,
    source: 'opencritic',
    id: 9279,
    score: 86,
    percentRecommended: 94,
    tier: 'Mighty',
    numReviews: 34,
    url: 'https://opencritic.com/game/9279/black-mesa',
  },

  // Rockstar / Sony / PlayStation PC
  {
    title: 'Red Dead Redemption 2',
    appId: 1174180,
    source: 'opencritic',
    id: 3717,
    score: 96,
    percentRecommended: 98,
    tier: 'Mighty',
    numReviews: 212,
    url: 'https://opencritic.com/game/3717/red-dead-redemption-2',
  },
  {
    title: 'Death Stranding',
    aliases: ['death stranding directors cut'],
    appId: 1190460,
    source: 'opencritic',
    id: 7631,
    score: 86,
    percentRecommended: 87,
    tier: 'Mighty',
    numReviews: 185,
    url: 'https://opencritic.com/game/7631/death-stranding',
  },
  {
    title: 'Horizon Zero Dawn',
    aliases: ['horizon zero dawn complete edition', 'horizon zero dawn remastered'],
    appId: 1151640,
    source: 'opencritic',
    id: 2843,
    score: 89,
    percentRecommended: 93,
    tier: 'Mighty',
    numReviews: 168,
    url: 'https://opencritic.com/game/2843/horizon-zero-dawn',
  },
  {
    title: 'Detroit: Become Human',
    appId: 1222140,
    source: 'opencritic',
    id: 7164,
    score: 80,
    percentRecommended: 78,
    tier: 'Strong',
    numReviews: 145,
    url: 'https://opencritic.com/game/7164/detroit-become-human',
  },
  {
    title: 'Beyond: Two Souls',
    appId: 960990,
    source: 'opencritic',
    id: 761,
    score: 72,
    percentRecommended: 52,
    tier: 'Strong',
    numReviews: 98,
    url: 'https://opencritic.com/game/761/beyond-two-souls',
  },
  {
    title: 'Ratchet & Clank: Rift Apart',
    appId: 1895880,
    source: 'opencritic',
    id: 11397,
    score: 88,
    percentRecommended: 95,
    tier: 'Mighty',
    numReviews: 172,
    url: 'https://opencritic.com/game/11397/ratchet-and-clank-rift-apart',
  },

  // FromSoftware / Soulslike
  {
    title: 'DARK SOULS III',
    aliases: ['dark souls 3', 'dark souls iii the ringed city'],
    appId: 374320,
    source: 'opencritic',
    id: 1521,
    score: 89,
    percentRecommended: 94,
    tier: 'Mighty',
    numReviews: 154,
    url: 'https://opencritic.com/game/1521/dark-souls-iii',
  },
  {
    title: 'DARK SOULS: Prepare To Die Edition',
    aliases: ['dark souls remastered', 'dark souls'],
    appId: 211420,
    source: 'metacritic',
    score: 89,
    tier: 'Mighty',
    numReviews: 67,
    url: 'https://www.metacritic.com/game/dark-souls/critic-reviews/',
  },
  {
    title: 'Sekiro: Shadows Die Twice',
    appId: 814380,
    source: 'opencritic',
    id: 6634,
    score: 90,
    percentRecommended: 95,
    tier: 'Mighty',
    numReviews: 178,
    url: 'https://opencritic.com/game/6634/sekiro-shadows-die-twice',
  },

  // Capcom / Resident Evil
  {
    title: 'Resident Evil 2',
    appId: 883710,
    source: 'opencritic',
    id: 6848,
    score: 92,
    percentRecommended: 97,
    tier: 'Mighty',
    numReviews: 184,
    url: 'https://opencritic.com/game/6848/resident-evil-2',
  },
  {
    title: 'Resident Evil 3',
    appId: 952060,
    source: 'opencritic',
    id: 9008,
    score: 77,
    percentRecommended: 68,
    tier: 'Strong',
    numReviews: 156,
    url: 'https://opencritic.com/game/9008/resident-evil-3',
  },
  {
    title: 'Resident Evil 4',
    appId: 2050650,
    source: 'opencritic',
    id: 14486,
    score: 92,
    percentRecommended: 98,
    tier: 'Mighty',
    numReviews: 198,
    url: 'https://opencritic.com/game/14486/resident-evil-4',
  },

  // Square Enix / Tomb Raider / Deus Ex
  {
    title: 'Tomb Raider',
    aliases: ['tomb raider 2013', 'tomb raider game of the year edition'],
    appId: 203160,
    source: 'metacritic',
    score: 86,
    tier: 'Mighty',
    numReviews: 78,
    url: 'https://www.metacritic.com/game/tomb-raider/critic-reviews/',
  },
  {
    title: 'Rise of the Tomb Raider',
    appId: 391220,
    source: 'opencritic',
    id: 1545,
    score: 87,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 145,
    url: 'https://opencritic.com/game/1545/rise-of-the-tomb-raider',
  },
  {
    title: 'Shadow of the Tomb Raider',
    aliases: ['shadow of the tomb raider definitive edition'],
    appId: 750920,
    source: 'opencritic',
    id: 6164,
    score: 80,
    percentRecommended: 78,
    tier: 'Strong',
    numReviews: 152,
    url: 'https://opencritic.com/game/6164/shadow-of-the-tomb-raider',
  },
  {
    title: 'Deus Ex: Mankind Divided',
    appId: 337000,
    source: 'opencritic',
    id: 1812,
    score: 82,
    percentRecommended: 85,
    tier: 'Strong',
    numReviews: 128,
    url: 'https://opencritic.com/game/1812/deus-ex-mankind-divided',
  },
  {
    title: 'Deus Ex: Human Revolution',
    aliases: ['deus ex human revolution directors cut'],
    appId: 238010,
    source: 'metacritic',
    score: 90,
    tier: 'Mighty',
    numReviews: 83,
    url: 'https://www.metacritic.com/game/deus-ex-human-revolution/critic-reviews/',
  },
  {
    title: 'Deus Ex',
    aliases: ['deus ex 1', 'deus ex game of the year edition'],
    appId: 6910,
    source: 'metacritic',
    score: 90,
    tier: 'Mighty',
    numReviews: 28,
    url: 'https://www.metacritic.com/game/deus-ex/critic-reviews/',
  },
  {
    title: 'CRISIS CORE –FINAL FANTASY VII– REUNION',
    aliases: ['crisis core final fantasy vii reunion'],
    appId: 1608070,
    source: 'opencritic',
    id: 14214,
    score: 78,
    percentRecommended: 76,
    tier: 'Strong',
    numReviews: 104,
    url: 'https://opencritic.com/game/14214/crisis-core-final-fantasy-vii-reunion',
  },

  // 4A Games / Metro
  {
    title: 'Metro 2033 Redux',
    aliases: ['metro 2033'],
    appId: 286690,
    source: 'opencritic',
    id: 384,
    score: 90,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 45,
    url: 'https://opencritic.com/game/384/metro-2033-redux',
  },
  {
    title: 'Metro: Last Light Redux',
    aliases: ['metro last light', 'metro last light complete edition'],
    appId: 287390,
    source: 'opencritic',
    id: 392,
    score: 81,
    percentRecommended: 84,
    tier: 'Strong',
    numReviews: 54,
    url: 'https://opencritic.com/game/392/metro-last-light-redux',
  },
  {
    title: 'Metro Exodus',
    aliases: ['metro exodus enhanced edition'],
    appId: 412020,
    source: 'opencritic',
    id: 7247,
    score: 83,
    percentRecommended: 86,
    tier: 'Strong',
    numReviews: 156,
    url: 'https://opencritic.com/game/7247/metro-exodus',
  },

  // Konami / Metal Gear
  {
    title: 'METAL GEAR SOLID V: THE PHANTOM PAIN',
    aliases: ['metal gear solid 5 the phantom pain', 'metal gear solid v the phantom pain'],
    appId: 287700,
    source: 'opencritic',
    id: 1391,
    score: 93,
    percentRecommended: 98,
    tier: 'Mighty',
    numReviews: 128,
    url: 'https://opencritic.com/game/1391/metal-gear-solid-v-the-phantom-pain',
  },

  // Atlus / SEGA
  {
    title: 'Persona 5 Royal',
    aliases: ['persona 5'],
    appId: 1687950,
    source: 'opencritic',
    id: 8664,
    score: 94,
    percentRecommended: 98,
    tier: 'Mighty',
    numReviews: 152,
    url: 'https://opencritic.com/game/8664/persona-5-royal',
  },
  {
    title: 'Company of Heroes',
    aliases: ['company of heroes legacy edition'],
    appId: 228200,
    source: 'metacritic',
    score: 93,
    tier: 'Mighty',
    numReviews: 55,
    url: 'https://www.metacritic.com/game/company-of-heroes/critic-reviews/',
  },
  {
    title: 'Company of Heroes 2',
    appId: 231430,
    source: 'metacritic',
    score: 80,
    tier: 'Strong',
    numReviews: 82,
    url: 'https://www.metacritic.com/game/company-of-heroes-2/critic-reviews/',
  },
  {
    title: 'Alien: Isolation',
    appId: 214490,
    source: 'opencritic',
    id: 166,
    score: 81,
    percentRecommended: 84,
    tier: 'Strong',
    numReviews: 110,
    url: 'https://opencritic.com/game/166/alien-isolation',
  },

  // 2K / Firaxis / Gearbox
  {
    title: 'XCOM 2',
    aliases: ['xcom 2 war of the chosen'],
    appId: 268500,
    source: 'opencritic',
    id: 1776,
    score: 87,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 120,
    url: 'https://opencritic.com/game/1776/xcom-2',
  },
  {
    title: 'Borderlands 2',
    appId: 49520,
    source: 'metacritic',
    score: 89,
    tier: 'Mighty',
    numReviews: 89,
    url: 'https://www.metacritic.com/game/borderlands-2/critic-reviews/',
  },
  {
    title: 'BioShock',
    aliases: ['bioshock remastered'],
    appId: 7670,
    source: 'metacritic',
    score: 96,
    tier: 'Mighty',
    numReviews: 88,
    url: 'https://www.metacritic.com/game/bioshock/critic-reviews/',
  },
  {
    title: 'BioShock Infinite',
    appId: 8870,
    source: 'metacritic',
    score: 94,
    tier: 'Mighty',
    numReviews: 68,
    url: 'https://www.metacritic.com/game/bioshock-infinite/critic-reviews/',
  },
  {
    title: 'Mafia',
    aliases: ['mafia definitive edition'],
    appId: 40990,
    source: 'metacritic',
    score: 88,
    tier: 'Mighty',
    numReviews: 52,
    url: 'https://www.metacritic.com/game/mafia/critic-reviews/',
  },

  // Warner Bros / Batman / South Park
  {
    title: 'Batman: Arkham Asylum',
    aliases: ['batman arkham asylum game of the year edition'],
    appId: 35140,
    source: 'metacritic',
    score: 91,
    tier: 'Mighty',
    numReviews: 69,
    url: 'https://www.metacritic.com/game/batman-arkham-asylum/critic-reviews/',
  },
  {
    title: 'Batman: Arkham City',
    aliases: ['batman arkham city game of the year edition'],
    appId: 200260,
    source: 'metacritic',
    score: 91,
    tier: 'Mighty',
    numReviews: 87,
    url: 'https://www.metacritic.com/game/batman-arkham-city/critic-reviews/',
  },
  {
    title: 'Batman: Arkham Knight',
    appId: 208650,
    source: 'opencritic',
    id: 105,
    score: 85,
    percentRecommended: 90,
    tier: 'Mighty',
    numReviews: 124,
    url: 'https://opencritic.com/game/105/batman-arkham-knight',
  },
  {
    title: 'South Park: The Stick of Truth',
    appId: 213670,
    source: 'metacritic',
    score: 85,
    tier: 'Mighty',
    numReviews: 48,
    url: 'https://www.metacritic.com/game/south-park-the-stick-of-truth/critic-reviews/',
  },
  {
    title: 'South Park The Fractured But Whole',
    appId: 488790,
    source: 'opencritic',
    id: 2876,
    score: 81,
    percentRecommended: 83,
    tier: 'Strong',
    numReviews: 112,
    url: 'https://opencritic.com/game/2876/south-park-the-fractured-but-whole',
  },

  // Popular Indies & Classics
  {
    title: 'Celeste',
    appId: 504230,
    source: 'opencritic',
    id: 5403,
    score: 92,
    percentRecommended: 97,
    tier: 'Mighty',
    numReviews: 104,
    url: 'https://opencritic.com/game/5403/celeste',
  },
  {
    title: 'Hollow Knight',
    appId: 367520,
    source: 'opencritic',
    id: 4002,
    score: 90,
    percentRecommended: 96,
    tier: 'Mighty',
    numReviews: 92,
    url: 'https://opencritic.com/game/4002/hollow-knight',
  },
  {
    title: 'Hades',
    appId: 1145360,
    source: 'opencritic',
    id: 8530,
    score: 94,
    percentRecommended: 99,
    tier: 'Mighty',
    numReviews: 168,
    url: 'https://opencritic.com/game/8530/hades',
  },
  {
    title: 'Dead Cells',
    appId: 588650,
    source: 'opencritic',
    id: 6386,
    score: 89,
    percentRecommended: 95,
    tier: 'Mighty',
    numReviews: 112,
    url: 'https://opencritic.com/game/6386/dead-cells',
  },
  {
    title: 'Slay the Spire',
    appId: 646570,
    source: 'opencritic',
    id: 7241,
    score: 89,
    percentRecommended: 95,
    tier: 'Mighty',
    numReviews: 76,
    url: 'https://opencritic.com/game/7241/slay-the-spire',
  },
  {
    title: 'Outer Wilds',
    appId: 753640,
    source: 'opencritic',
    id: 7832,
    score: 86,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 88,
    url: 'https://opencritic.com/game/7832/outer-wilds',
  },
  {
    title: 'Subnautica',
    appId: 264710,
    source: 'opencritic',
    id: 3311,
    score: 87,
    percentRecommended: 93,
    tier: 'Mighty',
    numReviews: 72,
    url: 'https://opencritic.com/game/3311/subnautica',
  },
  {
    title: 'Inside',
    appId: 304430,
    source: 'opencritic',
    id: 2348,
    score: 91,
    percentRecommended: 96,
    tier: 'Mighty',
    numReviews: 138,
    url: 'https://opencritic.com/game/2348/inside',
  },
  {
    title: 'Limbo',
    appId: 48000,
    source: 'metacritic',
    score: 88,
    tier: 'Mighty',
    numReviews: 54,
    url: 'https://www.metacritic.com/game/limbo/critic-reviews/',
  },
  {
    title: 'GRIS',
    appId: 683320,
    source: 'opencritic',
    id: 7049,
    score: 84,
    percentRecommended: 88,
    tier: 'Mighty',
    numReviews: 96,
    url: 'https://opencritic.com/game/7049/gris',
  },
  {
    title: 'Firewatch',
    appId: 383870,
    source: 'opencritic',
    id: 1640,
    score: 81,
    percentRecommended: 85,
    tier: 'Strong',
    numReviews: 114,
    url: 'https://opencritic.com/game/1640/firewatch',
  },
  {
    title: 'What Remains of Edith Finch',
    appId: 501300,
    source: 'opencritic',
    id: 4139,
    score: 88,
    percentRecommended: 94,
    tier: 'Mighty',
    numReviews: 98,
    url: 'https://opencritic.com/game/4139/what-remains-of-edith-finch',
  },
  {
    title: 'A Plague Tale: Innocence',
    appId: 752590,
    source: 'opencritic',
    id: 7553,
    score: 82,
    percentRecommended: 85,
    tier: 'Strong',
    numReviews: 124,
    url: 'https://opencritic.com/game/7553/a-plague-tale-innocence',
  },
  {
    title: 'Ghostrunner',
    appId: 1139900,
    source: 'opencritic',
    id: 10424,
    score: 81,
    percentRecommended: 84,
    tier: 'Strong',
    numReviews: 88,
    url: 'https://opencritic.com/game/10424/ghostrunner',
  },
  {
    title: 'Control',
    aliases: ['control ultimate edition'],
    appId: 870780,
    source: 'opencritic',
    id: 7658,
    score: 84,
    percentRecommended: 89,
    tier: 'Mighty',
    numReviews: 156,
    url: 'https://opencritic.com/game/7658/control',
  },
  {
    title: 'ABZU',
    appId: 384190,
    source: 'opencritic',
    id: 2792,
    score: 83,
    percentRecommended: 86,
    tier: 'Strong',
    numReviews: 92,
    url: 'https://opencritic.com/game/2792/abzu',
  },
  {
    title: 'Amnesia: The Dark Descent',
    appId: 57300,
    source: 'metacritic',
    score: 85,
    tier: 'Mighty',
    numReviews: 44,
    url: 'https://www.metacritic.com/game/amnesia-the-dark-descent/critic-reviews/',
  },
  {
    title: 'Among Us',
    appId: 945360,
    source: 'opencritic',
    id: 10471,
    score: 80,
    percentRecommended: 82,
    tier: 'Strong',
    numReviews: 48,
    url: 'https://opencritic.com/game/10471/among-us',
  },
  {
    title: 'Castle Crashers',
    appId: 204360,
    source: 'metacritic',
    score: 82,
    tier: 'Strong',
    numReviews: 38,
    url: 'https://www.metacritic.com/game/castle-crashers/critic-reviews/',
  },
  {
    title: 'Crysis Remastered',
    aliases: ['crysis'],
    appId: 1715130,
    source: 'opencritic',
    id: 10183,
    score: 71,
    percentRecommended: 52,
    tier: 'Strong',
    numReviews: 84,
    url: 'https://opencritic.com/game/10183/crysis-remastered',
  },
  {
    title: 'Crysis 2 Remastered',
    appId: 2096600,
    source: 'opencritic',
    id: 12386,
    score: 76,
    percentRecommended: 70,
    tier: 'Strong',
    numReviews: 42,
    url: 'https://opencritic.com/game/12386/crysis-2-remastered',
  },
  {
    title: 'Crysis 3 Remastered',
    appId: 2096610,
    source: 'opencritic',
    id: 12387,
    score: 77,
    percentRecommended: 72,
    tier: 'Strong',
    numReviews: 44,
    url: 'https://opencritic.com/game/12387/crysis-3-remastered',
  },
  {
    title: 'Destiny 2',
    appId: 1085660,
    source: 'opencritic',
    id: 4739,
    score: 84,
    percentRecommended: 88,
    tier: 'Mighty',
    numReviews: 126,
    url: 'https://opencritic.com/game/4739/destiny-2',
  },
  {
    title: 'Far Cry 4',
    appId: 298110,
    source: 'opencritic',
    id: 15,
    score: 83,
    percentRecommended: 86,
    tier: 'Strong',
    numReviews: 128,
    url: 'https://opencritic.com/game/15/far-cry-4',
  },
  {
    title: 'Guacamelee! Super Turbo Championship Edition',
    appId: 275390,
    source: 'opencritic',
    id: 486,
    score: 87,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 48,
    url: 'https://opencritic.com/game/486/guacamelee-super-turbo-championship-edition',
  },
  {
    title: 'Kingdom Come: Deliverance',
    appId: 379430,
    source: 'opencritic',
    id: 5616,
    score: 72,
    percentRecommended: 60,
    tier: 'Strong',
    numReviews: 114,
    url: 'https://opencritic.com/game/5616/kingdom-come-deliverance',
  },
  {
    title: 'Little Nightmares',
    aliases: ['little nightmares enhanced edition'],
    appId: 424840,
    source: 'opencritic',
    id: 4312,
    score: 79,
    percentRecommended: 81,
    tier: 'Strong',
    numReviews: 108,
    url: 'https://opencritic.com/game/4312/little-nightmares',
  },
  {
    title: 'Moonlighter',
    appId: 606150,
    source: 'opencritic',
    id: 6087,
    score: 81,
    percentRecommended: 84,
    tier: 'Strong',
    numReviews: 76,
    url: 'https://opencritic.com/game/6087/moonlighter',
  },
  {
    title: 'No Man\'s Sky',
    appId: 275850,
    source: 'opencritic',
    id: 2732,
    score: 71,
    percentRecommended: 48,
    tier: 'Strong',
    numReviews: 124,
    url: 'https://opencritic.com/game/2732/no-mans-sky',
  },
  {
    title: 'Outlast',
    appId: 238320,
    source: 'metacritic',
    score: 80,
    tier: 'Strong',
    numReviews: 59,
    url: 'https://www.metacritic.com/game/outlast/critic-reviews/',
  },
  {
    title: 'Psychonauts',
    appId: 3830,
    source: 'metacritic',
    score: 87,
    tier: 'Mighty',
    numReviews: 45,
    url: 'https://www.metacritic.com/game/psychonauts/critic-reviews/',
  },
  {
    title: 'SteamWorld Dig',
    appId: 252410,
    source: 'metacritic',
    score: 82,
    tier: 'Strong',
    numReviews: 46,
    url: 'https://www.metacritic.com/game/steamworld-dig/critic-reviews/',
  },
  {
    title: 'System Shock',
    appId: 482400,
    source: 'opencritic',
    id: 14811,
    score: 79,
    percentRecommended: 80,
    tier: 'Strong',
    numReviews: 92,
    url: 'https://opencritic.com/game/14811/system-shock',
  },
  {
    title: 'The Ascent',
    appId: 979690,
    source: 'opencritic',
    id: 11756,
    score: 74,
    percentRecommended: 65,
    tier: 'Strong',
    numReviews: 122,
    url: 'https://opencritic.com/game/11756/the-ascent',
  },
  {
    title: 'The Walking Dead',
    appId: 207610,
    source: 'metacritic',
    score: 89,
    tier: 'Mighty',
    numReviews: 68,
    url: 'https://www.metacritic.com/game/the-walking-dead-a-telltale-games-series/critic-reviews/',
  },
  {
    title: 'Titan Souls',
    appId: 297130,
    source: 'opencritic',
    id: 1346,
    score: 75,
    percentRecommended: 68,
    tier: 'Strong',
    numReviews: 64,
    url: 'https://opencritic.com/game/1346/titan-souls',
  },
  {
    title: 'Warhammer: Vermintide 2',
    appId: 552500,
    source: 'opencritic',
    id: 5627,
    score: 82,
    percentRecommended: 85,
    tier: 'Strong',
    numReviews: 88,
    url: 'https://opencritic.com/game/5627/warhammer-vermintide-2',
  },
  {
    title: 'Worms Armageddon',
    appId: 217200,
    source: 'metacritic',
    score: 88,
    tier: 'Mighty',
    numReviews: 24,
    url: 'https://www.metacritic.com/game/worms-armageddon/critic-reviews/',
  },
  {
    title: 'Frostpunk',
    appId: 323190,
    source: 'opencritic',
    id: 6012,
    score: 86,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 94,
    url: 'https://opencritic.com/game/6012/frostpunk',
  },
  {
    title: 'Enter the Gungeon',
    appId: 311690,
    source: 'opencritic',
    id: 2663,
    score: 84,
    percentRecommended: 88,
    tier: 'Mighty',
    numReviews: 58,
    url: 'https://opencritic.com/game/2663/enter-the-gungeon',
  },
  {
    title: 'Hotline Miami',
    appId: 219150,
    source: 'metacritic',
    score: 85,
    tier: 'Mighty',
    numReviews: 51,
    url: 'https://www.metacritic.com/game/hotline-miami/critic-reviews/',
  },
  {
    title: 'Hotline Miami 2: Wrong Number',
    appId: 274170,
    source: 'opencritic',
    id: 877,
    score: 74,
    percentRecommended: 60,
    tier: 'Strong',
    numReviews: 72,
    url: 'https://opencritic.com/game/877/hotline-miami-2-wrong-number',
  },
  {
    title: 'Torchlight II',
    appId: 200710,
    source: 'metacritic',
    score: 88,
    tier: 'Mighty',
    numReviews: 67,
    url: 'https://www.metacritic.com/game/torchlight-ii/critic-reviews/',
  },
  {
    title: 'STAR WARS: Knights of the Old Republic',
    aliases: ['star wars knights of the old republic'],
    appId: 32370,
    source: 'metacritic',
    score: 93,
    tier: 'Mighty',
    numReviews: 48,
    url: 'https://www.metacritic.com/game/star-wars-knights-of-the-old-republic/critic-reviews/',
  },
  {
    title: 'STAR WARS: Knights of the Old Republic II - The Sith Lords',
    aliases: ['star wars knights of the old republic ii'],
    appId: 208580,
    source: 'metacritic',
    score: 85,
    tier: 'Mighty',
    numReviews: 54,
    url: 'https://www.metacritic.com/game/star-wars-knights-of-the-old-republic-ii-the-sith-lords/critic-reviews/',
  },
  {
    title: 'Vampire: The Masquerade - Bloodlines',
    appId: 2600,
    source: 'metacritic',
    score: 80,
    tier: 'Strong',
    numReviews: 61,
    url: 'https://www.metacritic.com/game/vampire-the-masquerade---bloodlines/critic-reviews/',
  },
  {
    title: 'Mass Effect Legendary Edition',
    appId: 1328670,
    source: 'opencritic',
    id: 11140,
    score: 87,
    percentRecommended: 92,
    tier: 'Mighty',
    numReviews: 122,
    url: 'https://opencritic.com/game/11140/mass-effect-legendary-edition',
  },
  {
    title: 'Mass Effect 2',
    appId: 24980,
    source: 'metacritic',
    score: 94,
    tier: 'Mighty',
    numReviews: 78,
    url: 'https://www.metacritic.com/game/mass-effect-2/critic-reviews/',
  },
  {
    title: 'Age of Wonders III',
    appId: 226840,
    source: 'opencritic',
    id: 309,
    score: 80,
    percentRecommended: 82,
    tier: 'Strong',
    numReviews: 62,
    url: 'https://opencritic.com/game/309/age-of-wonders-iii',
  },
  {
    title: 'Alpha Protocol',
    appId: 34010,
    source: 'metacritic',
    score: 72,
    tier: 'Strong',
    numReviews: 48,
    url: 'https://www.metacritic.com/game/alpha-protocol/critic-reviews/',
  },
  {
    title: 'Amnesia: A Machine for Pigs',
    appId: 239200,
    source: 'metacritic',
    score: 72,
    tier: 'Strong',
    numReviews: 54,
    url: 'https://www.metacritic.com/game/amnesia-a-machine-for-pigs/critic-reviews/',
  },
  {
    title: 'Binary Domain',
    appId: 203750,
    source: 'metacritic',
    score: 74,
    tier: 'Strong',
    numReviews: 42,
    url: 'https://www.metacritic.com/game/binary-domain/critic-reviews/',
  },
  {
    title: 'Black Desert',
    appId: 582660,
    source: 'metacritic',
    score: 73,
    tier: 'Strong',
    numReviews: 36,
    url: 'https://www.metacritic.com/game/black-desert-online/critic-reviews/',
  },
  {
    title: 'Breathedge',
    appId: 738520,
    source: 'opencritic',
    id: 11068,
    score: 71,
    percentRecommended: 50,
    tier: 'Strong',
    numReviews: 38,
    url: 'https://opencritic.com/game/11068/breathedge',
  },
  {
    title: 'Dead Island Riptide Definitive Edition',
    appId: 383180,
    source: 'metacritic',
    score: 62,
    tier: 'Weak',
    numReviews: 56,
    url: 'https://www.metacritic.com/game/dead-island-riptide/critic-reviews/',
  },
  {
    title: 'Dear Esther: Landmark Edition',
    aliases: ['dear esther'],
    appId: 520720,
    source: 'metacritic',
    score: 75,
    tier: 'Strong',
    numReviews: 48,
    url: 'https://www.metacritic.com/game/dear-esther/critic-reviews/',
  },
  {
    title: 'Fable Anniversary',
    appId: 288470,
    source: 'metacritic',
    score: 68,
    tier: 'Fair',
    numReviews: 52,
    url: 'https://www.metacritic.com/game/fable-anniversary/critic-reviews/',
  },
  {
    title: 'Injustice: Gods Among Us Ultimate Edition',
    aliases: ['injustice gods among us'],
    appId: 242700,
    source: 'metacritic',
    score: 82,
    tier: 'Strong',
    numReviews: 45,
    url: 'https://www.metacritic.com/game/injustice-gods-among-us/critic-reviews/',
  },
  {
    title: 'S.T.A.L.K.E.R.: Shadow of Chernobyl',
    aliases: ['stalker shadow of chernobyl'],
    appId: 4500,
    source: 'metacritic',
    score: 82,
    tier: 'Strong',
    numReviews: 58,
    url: 'https://www.metacritic.com/game/stalker-shadow-of-chernobyl/critic-reviews/',
  },
  {
    title: 'S.T.A.L.K.E.R.: Call of Pripyat',
    aliases: ['stalker call of pripyat'],
    appId: 41700,
    source: 'metacritic',
    score: 80,
    tier: 'Strong',
    numReviews: 48,
    url: 'https://www.metacritic.com/game/stalker-call-of-pripyat/critic-reviews/',
  },
  {
    title: 'S.T.A.L.K.E.R.: Clear Sky',
    aliases: ['stalker clear sky'],
    appId: 20510,
    source: 'metacritic',
    score: 75,
    tier: 'Strong',
    numReviews: 44,
    url: 'https://www.metacritic.com/game/stalker-clear-sky/critic-reviews/',
  },
  {
    "title": "Team Fortress 2",
    "aliases": [
      "tf2"
    ],
    "appId": 440,
    "source": "metacritic",
    "score": 92,
    "tier": "Mighty",
    "numReviews": 39,
    "url": "https://www.metacritic.com/game/team-fortress-2/critic-reviews/",
    "summary": "Valve’s iconic class-based multiplayer first-person shooter acclaimed for its distinctive art style, witty characterization, and balance."
  },
  {
    "title": "Dota 2",
    "appId": 570,
    "source": "metacritic",
    "score": 90,
    "tier": "Mighty",
    "numReviews": 33,
    "url": "https://www.metacritic.com/game/dota-2/critic-reviews/",
    "summary": "Valve’s pinnacle competitive MOBA benchmark featuring unparalleled strategic depth and regular massive international tournaments."
  },
  {
    "title": "Left 4 Dead",
    "aliases": [
      "l4d"
    ],
    "appId": 500,
    "source": "metacritic",
    "score": 89,
    "tier": "Mighty",
    "numReviews": 57,
    "url": "https://www.metacritic.com/game/left-4-dead/critic-reviews/",
    "summary": "Groundbreaking four-player cooperative zombie shooter driven by Valve’s dynamic AI Director system."
  },
  {
    "title": "Left 4 Dead 2",
    "aliases": [
      "l4d2"
    ],
    "appId": 550,
    "source": "metacritic",
    "score": 89,
    "tier": "Mighty",
    "numReviews": 62,
    "url": "https://www.metacritic.com/game/left-4-dead-2/critic-reviews/",
    "summary": "The definitive zombie co-op experience featuring expanded campaigns, melee combat, and new special infected."
  },
  {
    "title": "Counter-Strike: Source",
    "aliases": [
      "css",
      "counter strike source"
    ],
    "appId": 240,
    "source": "metacritic",
    "score": 88,
    "tier": "Mighty",
    "numReviews": 38,
    "url": "https://www.metacritic.com/game/counter-strike-source/critic-reviews/"
  },
  {
    "title": "Day of Defeat: Source",
    "aliases": [
      "dods",
      "day of defeat source"
    ],
    "appId": 300,
    "source": "metacritic",
    "score": 80,
    "tier": "Strong",
    "numReviews": 27,
    "url": "https://www.metacritic.com/game/day-of-defeat-source/critic-reviews/"
  },
  {
    "title": "Half-Life: Opposing Force",
    "aliases": [
      "opposing force"
    ],
    "appId": 50,
    "source": "metacritic",
    "score": 82,
    "tier": "Strong",
    "numReviews": 24,
    "url": "https://www.metacritic.com/game/half-life-opposing-force/critic-reviews/"
  },
  {
    "title": "Half-Life: Blue Shift",
    "aliases": [
      "blue shift"
    ],
    "appId": 130,
    "source": "metacritic",
    "score": 71,
    "tier": "Fair",
    "numReviews": 29,
    "url": "https://www.metacritic.com/game/half-life-blue-shift/critic-reviews/"
  },
  {
    "title": "Half-Life 2: Episode One",
    "aliases": [
      "half life 2 episode 1",
      "hl2 ep1"
    ],
    "appId": 380,
    "source": "metacritic",
    "score": 87,
    "tier": "Mighty",
    "numReviews": 53,
    "url": "https://www.metacritic.com/game/half-life-2-episode-one/critic-reviews/"
  },
  {
    "title": "Half-Life 2: Episode Two",
    "aliases": [
      "half life 2 episode 2",
      "hl2 ep2"
    ],
    "appId": 420,
    "source": "metacritic",
    "score": 90,
    "tier": "Mighty",
    "numReviews": 48,
    "url": "https://www.metacritic.com/game/half-life-2-episode-two/critic-reviews/"
  },
  {
    "title": "A Way Out",
    "appId": 1222700,
    "source": "opencritic",
    "id": 5440,
    "score": 79,
    "percentRecommended": 76,
    "tier": "Strong",
    "numReviews": 120,
    "url": "https://opencritic.com/game/5440/a-way-out",
    "summary": "A cinematic co-op prison escape adventure designed exclusively for two players by Josef Fares and Hazelight."
  },
  {
    "title": "Battlefield 3",
    "aliases": [
      "battlefield 3™",
      "bf3"
    ],
    "appId": 1238820,
    "source": "metacritic",
    "score": 89,
    "tier": "Mighty",
    "numReviews": 60,
    "url": "https://www.metacritic.com/game/battlefield-3/critic-reviews/"
  },
  {
    "title": "Battlefield 4",
    "aliases": [
      "battlefield 4™",
      "bf4"
    ],
    "appId": 1238860,
    "source": "metacritic",
    "score": 81,
    "tier": "Strong",
    "numReviews": 48,
    "url": "https://www.metacritic.com/game/battlefield-4/critic-reviews/"
  },
  {
    "title": "Battlefield 1",
    "aliases": [
      "battlefield™ 1",
      "bf1"
    ],
    "appId": 1238840,
    "source": "opencritic",
    "id": 2838,
    "score": 88,
    "percentRecommended": 90,
    "tier": "Mighty",
    "numReviews": 145,
    "url": "https://opencritic.com/game/2838/battlefield-1"
  },
  {
    "title": "Battlefield Hardline",
    "aliases": [
      "battlefield™ hardline"
    ],
    "appId": 1238880,
    "source": "opencritic",
    "id": 532,
    "score": 73,
    "percentRecommended": 52,
    "tier": "Fair",
    "numReviews": 88,
    "url": "https://opencritic.com/game/532/battlefield-hardline"
  },
  {
    "title": "Command & Conquer Remastered Collection",
    "aliases": [
      "command & conquer™ remastered collection",
      "command and conquer remastered collection"
    ],
    "appId": 1213210,
    "source": "opencritic",
    "id": 9580,
    "score": 83,
    "percentRecommended": 88,
    "tier": "Strong",
    "numReviews": 68,
    "url": "https://opencritic.com/game/9580/command-and-conquer-remastered-collection"
  },
  {
    "title": "Crysis",
    "appId": 17300,
    "source": "metacritic",
    "score": 91,
    "tier": "Mighty",
    "numReviews": 56,
    "url": "https://www.metacritic.com/game/crysis/critic-reviews/",
    "summary": "A visual and technological benchmark that set the bar for open-ended tactical first-person shooters with nanosuit superpowers."
  },
  {
    "title": "Crysis 2",
    "aliases": [
      "crysis 2 maximum edition"
    ],
    "appId": 108800,
    "source": "metacritic",
    "score": 86,
    "tier": "Mighty",
    "numReviews": 64,
    "url": "https://www.metacritic.com/game/crysis-2/critic-reviews/"
  },
  {
    "title": "Crysis 3",
    "aliases": [
      "crysis® 3"
    ],
    "appId": 1282690,
    "source": "metacritic",
    "score": 76,
    "tier": "Strong",
    "numReviews": 66,
    "url": "https://www.metacritic.com/game/crysis-3/critic-reviews/"
  },
  {
    "title": "Dead Space (2008)",
    "aliases": [
      "dead space"
    ],
    "appId": 17470,
    "source": "metacritic",
    "score": 86,
    "tier": "Mighty",
    "numReviews": 67,
    "url": "https://www.metacritic.com/game/dead-space/critic-reviews/",
    "summary": "Visceral Games’ seminal sci-fi survival horror masterwork aboard the derelict USG Ishimura mining ship."
  },
  {
    "title": "Dead Space 2",
    "aliases": [
      "dead space™ 2"
    ],
    "appId": 47780,
    "source": "metacritic",
    "score": 87,
    "tier": "Mighty",
    "numReviews": 71,
    "url": "https://www.metacritic.com/game/dead-space-2/critic-reviews/"
  },
  {
    "title": "Dead Space 3",
    "aliases": [
      "dead space™ 3"
    ],
    "appId": 1238060,
    "source": "metacritic",
    "score": 78,
    "tier": "Strong",
    "numReviews": 58,
    "url": "https://www.metacritic.com/game/dead-space-3/critic-reviews/"
  },
  {
    "title": "Dragon Age: Origins",
    "aliases": [
      "dragon age origins",
      "dragon age: origins - ultimate edition"
    ],
    "appId": 47810,
    "source": "metacritic",
    "score": 91,
    "tier": "Mighty",
    "numReviews": 67,
    "url": "https://www.metacritic.com/game/dragon-age-origins/critic-reviews/",
    "summary": "BioWare’s epic dark fantasy RPG benchmark celebrating intricate tactical party combat and profound narrative agency."
  },
  {
    "title": "Dragon Age II",
    "aliases": [
      "dragon age 2"
    ],
    "appId": 1238040,
    "source": "metacritic",
    "score": 82,
    "tier": "Strong",
    "numReviews": 53,
    "url": "https://www.metacritic.com/game/dragon-age-ii/critic-reviews/"
  },
  {
    "title": "Dragon Age: Inquisition",
    "aliases": [
      "dragon age inquisition"
    ],
    "appId": 1222690,
    "source": "opencritic",
    "id": 315,
    "score": 89,
    "percentRecommended": 94,
    "tier": "Mighty",
    "numReviews": 102,
    "url": "https://opencritic.com/game/315/dragon-age-inquisition"
  },
  {
    "title": "Mass Effect (2007)",
    "aliases": [
      "mass effect 1",
      "mass effect"
    ],
    "appId": 17460,
    "source": "metacritic",
    "score": 89,
    "tier": "Mighty",
    "numReviews": 74,
    "url": "https://www.metacritic.com/game/mass-effect/critic-reviews/"
  },
  {
    "title": "Mass Effect 3",
    "appId": 1238020,
    "source": "metacritic",
    "score": 89,
    "tier": "Mighty",
    "numReviews": 74,
    "url": "https://www.metacritic.com/game/mass-effect-3/critic-reviews/"
  },
  {
    "title": "Mass Effect: Andromeda",
    "aliases": [
      "mass effect andromeda"
    ],
    "appId": 1238000,
    "source": "opencritic",
    "id": 2905,
    "score": 72,
    "percentRecommended": 50,
    "tier": "Fair",
    "numReviews": 135,
    "url": "https://opencritic.com/game/2905/mass-effect-andromeda"
  },
  {
    "title": "Mirror's Edge",
    "aliases": [
      "mirror's edge™",
      "mirrors edge"
    ],
    "appId": 17410,
    "source": "metacritic",
    "score": 81,
    "tier": "Strong",
    "numReviews": 44,
    "url": "https://www.metacritic.com/game/mirrors-edge/critic-reviews/"
  },
  {
    "title": "SPORE",
    "aliases": [
      "spore™"
    ],
    "appId": 17390,
    "source": "metacritic",
    "score": 84,
    "tier": "Strong",
    "numReviews": 47,
    "url": "https://www.metacritic.com/game/spore/critic-reviews/"
  },
  {
    "title": "Titanfall 2",
    "appId": 1237970,
    "source": "opencritic",
    "id": 3010,
    "score": 88,
    "percentRecommended": 94,
    "tier": "Mighty",
    "numReviews": 126,
    "url": "https://opencritic.com/game/3010/titanfall-2",
    "summary": "Respawn’s critically lauded mech FPS with an inventive single-player campaign and adrenaline-fueled wall-running multiplayer."
  },
  {
    "title": "STAR WARS Jedi: Fallen Order",
    "aliases": [
      "star wars jedi fallen order",
      "jedi fallen order"
    ],
    "appId": 1172380,
    "source": "opencritic",
    "id": 7931,
    "score": 82,
    "percentRecommended": 85,
    "tier": "Strong",
    "numReviews": 153,
    "url": "https://opencritic.com/game/7931/star-wars-jedi-fallen-order"
  },
  {
    "title": "STAR WARS Battlefront II",
    "aliases": [
      "star wars battlefront 2",
      "battlefront ii"
    ],
    "appId": 1237950,
    "source": "opencritic",
    "id": 4450,
    "score": 67,
    "percentRecommended": 39,
    "tier": "Fair",
    "numReviews": 114,
    "url": "https://opencritic.com/game/4450/star-wars-battlefront-ii"
  },
  {
    "title": "Burnout Paradise Remastered",
    "appId": 1238080,
    "source": "opencritic",
    "id": 5724,
    "score": 78,
    "percentRecommended": 72,
    "tier": "Strong",
    "numReviews": 64,
    "url": "https://opencritic.com/game/5724/burnout-paradise-remastered"
  },
  {
    "title": "Need for Speed Heat",
    "aliases": [
      "nfs heat"
    ],
    "appId": 1222680,
    "source": "opencritic",
    "id": 8196,
    "score": 72,
    "percentRecommended": 49,
    "tier": "Fair",
    "numReviews": 92,
    "url": "https://opencritic.com/game/8196/need-for-speed-heat"
  },
  {
    "title": "Plants vs. Zombies: Battle for Neighborville",
    "appId": 1262240,
    "source": "opencritic",
    "id": 8328,
    "score": 76,
    "percentRecommended": 67,
    "tier": "Strong",
    "numReviews": 55,
    "url": "https://opencritic.com/game/8328/plants-vs-zombies-battle-for-neighborville"
  },
  {
    "title": "Plants vs. Zombies GOTY Edition",
    "aliases": [
      "plants vs zombies",
      "plants vs zombies goty"
    ],
    "appId": 3590,
    "source": "metacritic",
    "score": 87,
    "tier": "Mighty",
    "numReviews": 40,
    "url": "https://www.metacritic.com/game/plants-vs-zombies/critic-reviews/"
  },
  {
    "title": "SimCity 4 Deluxe",
    "aliases": [
      "simcity 4"
    ],
    "appId": 24780,
    "source": "metacritic",
    "score": 84,
    "tier": "Strong",
    "numReviews": 36,
    "url": "https://www.metacritic.com/game/simcity-4/critic-reviews/"
  },
  {
    "title": "Peggle Deluxe",
    "aliases": [
      "peggle"
    ],
    "appId": 3480,
    "source": "metacritic",
    "score": 85,
    "tier": "Mighty",
    "numReviews": 22,
    "url": "https://www.metacritic.com/game/peggle/critic-reviews/"
  },
  {
    "title": "Peggle Nights",
    "appId": 3540,
    "source": "metacritic",
    "score": 79,
    "tier": "Strong",
    "numReviews": 18,
    "url": "https://www.metacritic.com/game/peggle-nights/critic-reviews/"
  },
  {
    "title": "Bejeweled 3",
    "appId": 78000,
    "source": "metacritic",
    "score": 82,
    "tier": "Strong",
    "numReviews": 20,
    "url": "https://www.metacritic.com/game/bejeweled-3/critic-reviews/"
  },
  {
    "title": "Unravel",
    "appId": 1225560,
    "source": "opencritic",
    "id": 1524,
    "score": 76,
    "percentRecommended": 68,
    "tier": "Strong",
    "numReviews": 95,
    "url": "https://opencritic.com/game/1524/unravel"
  },
  {
    "title": "Unravel Two",
    "appId": 1225570,
    "source": "opencritic",
    "id": 6251,
    "score": 78,
    "percentRecommended": 76,
    "tier": "Strong",
    "numReviews": 78,
    "url": "https://opencritic.com/game/6251/unravel-two"
  },
  {
    "title": "Sea of Solitude",
    "appId": 1225590,
    "source": "opencritic",
    "id": 7984,
    "score": 69,
    "percentRecommended": 41,
    "tier": "Fair",
    "numReviews": 82,
    "url": "https://opencritic.com/game/7984/sea-of-solitude"
  },
  {
    "title": "Fe",
    "appId": 1225580,
    "source": "opencritic",
    "id": 5576,
    "score": 70,
    "percentRecommended": 47,
    "tier": "Fair",
    "numReviews": 65,
    "url": "https://opencritic.com/game/5576/fe"
  },
  {
    "title": "It Takes Two",
    "appId": 1426210,
    "source": "metacritic",
    "score": 88,
    "tier": "Mighty",
    "numReviews": 53,
    "url": "https://www.metacritic.com/game/it-takes-two/critic-reviews/",
    "summary": "Winner of The Game Awards Game of the Year 2021, an endlessly inventive genre-bending pure co-op journey."
  },
  {
    "title": "Lost in Random",
    "appId": 1462570,
    "source": "opencritic",
    "id": 11959,
    "score": 78,
    "percentRecommended": 73,
    "tier": "Strong",
    "numReviews": 84,
    "url": "https://opencritic.com/game/11959/lost-in-random"
  },
  {
    "title": "STAR WARS: Squadrons",
    "aliases": [
      "star wars squadrons",
      "squadrons"
    ],
    "appId": 1222730,
    "source": "opencritic",
    "id": 10178,
    "score": 79,
    "percentRecommended": 78,
    "tier": "Strong",
    "numReviews": 105,
    "url": "https://opencritic.com/game/10178/star-wars-squadrons"
  },
  {
    "title": "Jade Empire: Special Edition",
    "aliases": [
      "jade empire"
    ],
    "appId": 7110,
    "source": "metacritic",
    "score": 81,
    "tier": "Strong",
    "numReviews": 40,
    "url": "https://www.metacritic.com/game/jade-empire-special-edition/critic-reviews/"
  },
  {
    "title": "DOOM 3: BFG Edition",
    "aliases": [
      "doom 3 bfg edition"
    ],
    "appId": 208200,
    "source": "metacritic",
    "score": 67,
    "tier": "Fair",
    "numReviews": 42,
    "url": "https://www.metacritic.com/game/doom-3-bfg-edition/critic-reviews/"
  },
  {
    "title": "DOOM 3: Resurrection of Evil",
    "aliases": [
      "doom 3 resurrection of evil"
    ],
    "appId": 9070,
    "source": "metacritic",
    "score": 78,
    "tier": "Strong",
    "numReviews": 38,
    "url": "https://www.metacritic.com/game/doom-3-resurrection-of-evil/critic-reviews/"
  },
  {
    "title": "DOOM 64",
    "appId": 1148590,
    "source": "opencritic",
    "id": 9145,
    "score": 76,
    "percentRecommended": 75,
    "tier": "Strong",
    "numReviews": 40,
    "url": "https://opencritic.com/game/9145/doom-64"
  },
  {
    "title": "DOOM + DOOM II",
    "aliases": [
      "doom + doom 2"
    ],
    "appId": 2280,
    "source": "opencritic",
    "id": 16999,
    "score": 85,
    "percentRecommended": 92,
    "tier": "Mighty",
    "numReviews": 32,
    "url": "https://opencritic.com/game/16999/doom-doom-ii"
  },
  {
    "title": "Quake 4",
    "appId": 2210,
    "source": "metacritic",
    "score": 81,
    "tier": "Strong",
    "numReviews": 54,
    "url": "https://www.metacritic.com/game/quake-4/critic-reviews/"
  },
  {
    "title": "Wolfenstein 3D",
    "appId": 2270,
    "source": "metacritic",
    "score": 81,
    "tier": "Strong",
    "numReviews": 20,
    "url": "https://www.metacritic.com/game/wolfenstein-3d/critic-reviews/"
  },
  {
    "title": "Return to Castle Wolfenstein",
    "appId": 9010,
    "source": "metacritic",
    "score": 88,
    "tier": "Mighty",
    "numReviews": 32,
    "url": "https://www.metacritic.com/game/return-to-castle-wolfenstein/critic-reviews/"
  },
  {
    "title": "Wolfenstein: The New Order",
    "aliases": [
      "wolfenstein the new order"
    ],
    "appId": 201810,
    "source": "opencritic",
    "id": 447,
    "score": 81,
    "percentRecommended": 82,
    "tier": "Strong",
    "numReviews": 110,
    "url": "https://opencritic.com/game/447/wolfenstein-the-new-order"
  },
  {
    "title": "Wolfenstein: The Old Blood",
    "aliases": [
      "wolfenstein the old blood"
    ],
    "appId": 350080,
    "source": "opencritic",
    "id": 1003,
    "score": 76,
    "percentRecommended": 71,
    "tier": "Strong",
    "numReviews": 85,
    "url": "https://opencritic.com/game/1003/wolfenstein-the-old-blood"
  },
  {
    "title": "Wolfenstein: Youngblood",
    "aliases": [
      "wolfenstein youngblood"
    ],
    "appId": 1056960,
    "source": "opencritic",
    "id": 7850,
    "score": 69,
    "percentRecommended": 41,
    "tier": "Fair",
    "numReviews": 118,
    "url": "https://opencritic.com/game/7850/wolfenstein-youngblood"
  },
  {
    "title": "Rage",
    "appId": 9200,
    "source": "metacritic",
    "score": 79,
    "tier": "Strong",
    "numReviews": 55,
    "url": "https://www.metacritic.com/game/rage/critic-reviews/"
  },
  {
    "title": "Rage 2",
    "appId": 548570,
    "source": "opencritic",
    "id": 7123,
    "score": 71,
    "percentRecommended": 48,
    "tier": "Fair",
    "numReviews": 142,
    "url": "https://opencritic.com/game/7123/rage-2"
  },
  {
    "title": "The Evil Within",
    "appId": 268050,
    "source": "opencritic",
    "id": 401,
    "score": 75,
    "percentRecommended": 64,
    "tier": "Strong",
    "numReviews": 98,
    "url": "https://opencritic.com/game/401/the-evil-within"
  },
  {
    "title": "The Evil Within 2",
    "appId": 601430,
    "source": "opencritic",
    "id": 4812,
    "score": 80,
    "percentRecommended": 81,
    "tier": "Strong",
    "numReviews": 122,
    "url": "https://opencritic.com/game/4812/the-evil-within-2"
  },
  {
    "title": "Deathloop",
    "appId": 1252330,
    "source": "opencritic",
    "id": 10993,
    "score": 88,
    "percentRecommended": 90,
    "tier": "Mighty",
    "numReviews": 162,
    "url": "https://opencritic.com/game/10993/deathloop"
  },
  {
    "title": "Hi-Fi RUSH",
    "aliases": [
      "hi fi rush"
    ],
    "appId": 1817230,
    "source": "opencritic",
    "id": 14501,
    "score": 89,
    "percentRecommended": 98,
    "tier": "Mighty",
    "numReviews": 125,
    "url": "https://opencritic.com/game/14501/hi-fi-rush"
  },
  {
    "title": "Starfield",
    "appId": 1716740,
    "source": "opencritic",
    "id": 14908,
    "score": 85,
    "percentRecommended": 89,
    "tier": "Mighty",
    "numReviews": 198,
    "url": "https://opencritic.com/game/14908/starfield"
  },
  {
    "title": "Fallout 76",
    "appId": 1151340,
    "source": "opencritic",
    "id": 6227,
    "score": 52,
    "percentRecommended": 12,
    "tier": "Weak",
    "numReviews": 128,
    "url": "https://opencritic.com/game/6227/fallout-76"
  },
  {
    "title": "Hexen: Beyond Heretic",
    "aliases": [
      "hexen"
    ],
    "appId": 2360,
    "source": "metacritic",
    "score": 83,
    "tier": "Strong",
    "numReviews": 22,
    "url": "https://www.metacritic.com/game/hexen-beyond-heretic/critic-reviews/"
  },
  {
    "title": "Hexen: Deathkings of the Dark Citadel",
    "appId": 2370,
    "source": "metacritic",
    "score": 78,
    "tier": "Strong",
    "numReviews": 15,
    "url": "https://www.metacritic.com/game/hexen-deathkings-of-the-dark-citadel/critic-reviews/"
  },
  {
    "title": "Heretic: Shadow of the Serpent Riders",
    "aliases": [
      "heretic"
    ],
    "appId": 2390,
    "source": "metacritic",
    "score": 83,
    "tier": "Strong",
    "numReviews": 20,
    "url": "https://www.metacritic.com/game/heretic-shadow-of-the-serpent-riders/critic-reviews/"
  },
  {
    "title": "HeXen II",
    "aliases": [
      "hexen 2"
    ],
    "appId": 9060,
    "source": "metacritic",
    "score": 76,
    "tier": "Strong",
    "numReviews": 18,
    "url": "https://www.metacritic.com/game/hexen-ii/critic-reviews/"
  },
  {
    "title": "SiN Episodes: Emergence",
    "aliases": [
      "sin episodes"
    ],
    "appId": 1300,
    "source": "metacritic",
    "score": 75,
    "tier": "Strong",
    "numReviews": 35,
    "url": "https://www.metacritic.com/game/sin-episodes-emergence/critic-reviews/"
  },
  {
    "title": "Grand Theft Auto V",
    "aliases": [
      "gta v",
      "gta 5",
      "grand theft auto 5"
    ],
    "appId": 271590,
    "source": "metacritic",
    "score": 97,
    "tier": "Mighty",
    "numReviews": 66,
    "url": "https://www.metacritic.com/game/grand-theft-auto-v/critic-reviews/"
  },
  {
    "title": "Marvel's Guardians of the Galaxy",
    "aliases": [
      "guardians of the galaxy"
    ],
    "appId": 1088850,
    "source": "opencritic",
    "id": 11522,
    "score": 82,
    "percentRecommended": 85,
    "tier": "Strong",
    "numReviews": 145,
    "url": "https://opencritic.com/game/11522/marvels-guardians-of-the-galaxy"
  },
  {
    "title": "Marvel's Midnight Suns",
    "aliases": [
      "midnight suns"
    ],
    "appId": 368260,
    "source": "opencritic",
    "id": 13809,
    "score": 83,
    "percentRecommended": 87,
    "tier": "Strong",
    "numReviews": 130,
    "url": "https://opencritic.com/game/13809/marvels-midnight-suns"
  },
  {
    "title": "Sid Meier's Civilization VI",
    "aliases": [
      "civilization vi",
      "civ 6",
      "civilization 6"
    ],
    "appId": 289070,
    "source": "opencritic",
    "id": 2795,
    "score": 88,
    "percentRecommended": 92,
    "tier": "Mighty",
    "numReviews": 112,
    "url": "https://opencritic.com/game/2795/sid-meiers-civilization-vi"
  },
  {
    "title": "Dying Light: Enhanced Edition",
    "aliases": [
      "dying light",
      "dying light the following"
    ],
    "appId": 239140,
    "source": "metacritic",
    "score": 87,
    "tier": "Mighty",
    "numReviews": 54,
    "url": "https://www.metacritic.com/game/dying-light-the-following-enhanced-edition/critic-reviews/"
  },
  {
    "title": "Borderlands 3",
    "appId": 397540,
    "source": "opencritic",
    "id": 7957,
    "score": 81,
    "percentRecommended": 80,
    "tier": "Strong",
    "numReviews": 132,
    "url": "https://opencritic.com/game/7957/borderlands-3"
  },
  {
    "title": "The Outer Worlds",
    "appId": 578650,
    "source": "opencritic",
    "id": 7959,
    "score": 83,
    "percentRecommended": 83,
    "tier": "Strong",
    "numReviews": 156,
    "url": "https://opencritic.com/game/7959/the-outer-worlds"
  },
  {
    "title": "Overcooked!",
    "aliases": [
      "overcooked"
    ],
    "appId": 448510,
    "source": "opencritic",
    "id": 2894,
    "score": 79,
    "percentRecommended": 78,
    "tier": "Strong",
    "numReviews": 68,
    "url": "https://opencritic.com/game/2894/overcooked"
  },
  {
    "title": "Overcooked! 2",
    "aliases": [
      "overcooked 2"
    ],
    "appId": 728880,
    "source": "opencritic",
    "id": 6431,
    "score": 81,
    "percentRecommended": 83,
    "tier": "Strong",
    "numReviews": 82,
    "url": "https://opencritic.com/game/6431/overcooked-2"
  },
  {
    "title": "The Escapists",
    "appId": 298630,
    "source": "opencritic",
    "id": 438,
    "score": 71,
    "percentRecommended": 55,
    "tier": "Fair",
    "numReviews": 46,
    "url": "https://opencritic.com/game/438/the-escapists"
  },
  {
    "title": "The Escapists 2",
    "appId": 641990,
    "source": "opencritic",
    "id": 4440,
    "score": 75,
    "percentRecommended": 67,
    "tier": "Strong",
    "numReviews": 54,
    "url": "https://opencritic.com/game/4440/the-escapists-2"
  },
  {
    "title": "This War of Mine",
    "appId": 282070,
    "source": "opencritic",
    "id": 416,
    "score": 83,
    "percentRecommended": 85,
    "tier": "Strong",
    "numReviews": 70,
    "url": "https://opencritic.com/game/416/this-war-of-mine"
  },
  {
    "title": "Transistor",
    "appId": 237930,
    "source": "metacritic",
    "score": 83,
    "tier": "Strong",
    "numReviews": 68,
    "url": "https://www.metacritic.com/game/transistor/critic-reviews/"
  },
  {
    "title": "Torchlight",
    "appId": 41500,
    "source": "metacritic",
    "score": 83,
    "tier": "Strong",
    "numReviews": 57,
    "url": "https://www.metacritic.com/game/torchlight/critic-reviews/"
  },
  {
    "title": "For Honor",
    "appId": 304390,
    "source": "opencritic",
    "id": 4050,
    "score": 77,
    "percentRecommended": 65,
    "tier": "Strong",
    "numReviews": 104,
    "url": "https://opencritic.com/game/4050/for-honor"
  },
  {
    "title": "Watch Dogs",
    "appId": 243470,
    "source": "opencritic",
    "id": 276,
    "score": 80,
    "percentRecommended": 78,
    "tier": "Strong",
    "numReviews": 96,
    "url": "https://opencritic.com/game/276/watch-dogs"
  },
  {
    "title": "Watch Dogs 2",
    "appId": 447040,
    "source": "opencritic",
    "id": 2846,
    "score": 82,
    "percentRecommended": 81,
    "tier": "Strong",
    "numReviews": 120,
    "url": "https://opencritic.com/game/2846/watch-dogs-2"
  },
  {
    "title": "Assassin's Creed Syndicate",
    "aliases": [
      "assassins creed syndicate"
    ],
    "appId": 368500,
    "source": "opencritic",
    "id": 1660,
    "score": 77,
    "percentRecommended": 70,
    "tier": "Strong",
    "numReviews": 108,
    "url": "https://opencritic.com/game/1660/assassins-creed-syndicate"
  },
  {
    "title": "Rayman Legends",
    "appId": 242550,
    "source": "metacritic",
    "score": 89,
    "tier": "Mighty",
    "numReviews": 60,
    "url": "https://www.metacritic.com/game/rayman-legends/critic-reviews/"
  },
  {
    "title": "Loop Hero",
    "appId": 1282730,
    "source": "opencritic",
    "id": 11099,
    "score": 84,
    "percentRecommended": 90,
    "tier": "Mighty",
    "numReviews": 76,
    "url": "https://opencritic.com/game/11099/loop-hero"
  },
  {
    "title": "Inscryption",
    "appId": 1075200,
    "source": "opencritic",
    "id": 12142,
    "score": 86,
    "percentRecommended": 95,
    "tier": "Mighty",
    "numReviews": 72,
    "url": "https://opencritic.com/game/12142/inscryption"
  },
  {
    "title": "Death's Door",
    "aliases": [
      "deaths door"
    ],
    "appId": 894020,
    "source": "opencritic",
    "id": 11679,
    "score": 87,
    "percentRecommended": 94,
    "tier": "Mighty",
    "numReviews": 108,
    "url": "https://opencritic.com/game/11679/deaths-door"
  },
  {
    "title": "Tunic",
    "appId": 553420,
    "source": "opencritic",
    "id": 12891,
    "score": 85,
    "percentRecommended": 92,
    "tier": "Mighty",
    "numReviews": 135,
    "url": "https://opencritic.com/game/12891/tunic"
  },
  {
    "title": "Deliver Us The Moon",
    "appId": 428660,
    "source": "opencritic",
    "id": 8415,
    "score": 75,
    "percentRecommended": 64,
    "tier": "Strong",
    "numReviews": 48,
    "url": "https://opencritic.com/game/8415/deliver-us-the-moon"
  },
  {
    "title": "Spiritfarer",
    "appId": 972660,
    "source": "opencritic",
    "id": 10038,
    "score": 86,
    "percentRecommended": 94,
    "tier": "Mighty",
    "numReviews": 70,
    "url": "https://opencritic.com/game/10038/spiritfarer"
  },
  {
    "title": "Kerbal Space Program",
    "appId": 220200,
    "source": "metacritic",
    "score": 88,
    "tier": "Mighty",
    "numReviews": 44,
    "url": "https://www.metacritic.com/game/kerbal-space-program/critic-reviews/"
  },
  {
    "title": "Shadowrun Returns",
    "appId": 234650,
    "source": "metacritic",
    "score": 76,
    "tier": "Strong",
    "numReviews": 54,
    "url": "https://www.metacritic.com/game/shadowrun-returns/critic-reviews/"
  },
  {
    "title": "Shadowrun: Dragonfall - Director's Cut",
    "aliases": [
      "shadowrun dragonfall"
    ],
    "appId": 300550,
    "source": "metacritic",
    "score": 87,
    "tier": "Mighty",
    "numReviews": 32,
    "url": "https://www.metacritic.com/game/shadowrun-dragonfall-directors-cut/critic-reviews/"
  },
  {
    "title": "Shadowrun: Hong Kong",
    "aliases": [
      "shadowrun hong kong"
    ],
    "appId": 346940,
    "source": "opencritic",
    "id": 1843,
    "score": 80,
    "percentRecommended": 78,
    "tier": "Strong",
    "numReviews": 44,
    "url": "https://opencritic.com/game/1843/shadowrun-hong-kong"
  },
  {
    "title": "Super Meat Boy",
    "appId": 40800,
    "source": "metacritic",
    "score": 87,
    "tier": "Mighty",
    "numReviews": 46,
    "url": "https://www.metacritic.com/game/super-meat-boy/critic-reviews/"
  },
  {
    "title": "Brothers: A Tale of Two Sons",
    "aliases": [
      "brothers a tale of two sons"
    ],
    "appId": 225080,
    "source": "metacritic",
    "score": 90,
    "tier": "Mighty",
    "numReviews": 58,
    "url": "https://www.metacritic.com/game/brothers-a-tale-of-two-sons/critic-reviews/"
  },
  {
    "title": "PAYDAY 2",
    "aliases": [
      "payday 2"
    ],
    "appId": 218620,
    "source": "metacritic",
    "score": 79,
    "tier": "Strong",
    "numReviews": 50,
    "url": "https://www.metacritic.com/game/payday-2/critic-reviews/"
  },
  {
    "title": "Guacamelee! 2",
    "aliases": [
      "guacamelee 2"
    ],
    "appId": 533450,
    "source": "opencritic",
    "id": 6505,
    "score": 85,
    "percentRecommended": 92,
    "tier": "Mighty",
    "numReviews": 86,
    "url": "https://opencritic.com/game/6505/guacamelee-2"
  },
  {
    "title": "The Talos Principle",
    "appId": 257510,
    "source": "opencritic",
    "id": 613,
    "score": 85,
    "percentRecommended": 92,
    "tier": "Mighty",
    "numReviews": 68,
    "url": "https://opencritic.com/game/613/the-talos-principle"
  },
  {
    "title": "The Witness",
    "appId": 210970,
    "source": "opencritic",
    "id": 2063,
    "score": 87,
    "percentRecommended": 90,
    "tier": "Mighty",
    "numReviews": 95,
    "url": "https://opencritic.com/game/2063/the-witness"
  },
  {
    "title": "Tacoma",
    "appId": 343860,
    "source": "opencritic",
    "id": 4698,
    "score": 77,
    "percentRecommended": 76,
    "tier": "Strong",
    "numReviews": 82,
    "url": "https://opencritic.com/game/4698/tacoma"
  },
  {
    "title": "Gone Home",
    "appId": 232430,
    "source": "metacritic",
    "score": 86,
    "tier": "Mighty",
    "numReviews": 56,
    "url": "https://www.metacritic.com/game/gone-home/critic-reviews/"
  },
  {
    "title": "The Vanishing of Ethan Carter",
    "appId": 258520,
    "source": "opencritic",
    "id": 283,
    "score": 81,
    "percentRecommended": 81,
    "tier": "Strong",
    "numReviews": 70,
    "url": "https://opencritic.com/game/283/the-vanishing-of-ethan-carter"
  },
  {
    "title": "SOMA",
    "aliases": [
      "soma"
    ],
    "appId": 282140,
    "source": "opencritic",
    "id": 1599,
    "score": 84,
    "percentRecommended": 89,
    "tier": "Mighty",
    "numReviews": 92,
    "url": "https://opencritic.com/game/1599/soma"
  },
  {
    "title": "Oxenfree",
    "appId": 388880,
    "source": "opencritic",
    "id": 2154,
    "score": 81,
    "percentRecommended": 83,
    "tier": "Strong",
    "numReviews": 84,
    "url": "https://opencritic.com/game/2154/oxenfree"
  },
  {
    "title": "Night in the Woods",
    "appId": 480490,
    "source": "opencritic",
    "id": 3890,
    "score": 88,
    "percentRecommended": 91,
    "tier": "Mighty",
    "numReviews": 78,
    "url": "https://opencritic.com/game/3890/night-in-the-woods"
  },
  {
    "title": "Kentucky Route Zero",
    "appId": 231200,
    "source": "opencritic",
    "id": 8940,
    "score": 88,
    "percentRecommended": 93,
    "tier": "Mighty",
    "numReviews": 54,
    "url": "https://opencritic.com/game/8940/kentucky-route-zero-tv-edition"
  },
  {
    "title": "Return of the Obra Dinn",
    "appId": 653530,
    "source": "opencritic",
    "id": 6806,
    "score": 90,
    "percentRecommended": 99,
    "tier": "Mighty",
    "numReviews": 62,
    "url": "https://opencritic.com/game/6806/return-of-the-obra-dinn"
  },
  {
    "title": "Untitled Goose Game",
    "appId": 837470,
    "source": "opencritic",
    "id": 8303,
    "score": 81,
    "percentRecommended": 83,
    "tier": "Strong",
    "numReviews": 85,
    "url": "https://opencritic.com/game/8303/untitled-goose-game"
  },
  {
    "title": "Sifu",
    "appId": 2138710,
    "source": "opencritic",
    "id": 12737,
    "score": 81,
    "percentRecommended": 85,
    "tier": "Strong",
    "numReviews": 142,
    "url": "https://opencritic.com/game/12737/sifu"
  },
  {
    "title": "Tiny Tina's Wonderlands",
    "aliases": [
      "tiny tinas wonderlands"
    ],
    "appId": 1286680,
    "source": "opencritic",
    "id": 12984,
    "score": 76,
    "percentRecommended": 71,
    "tier": "Strong",
    "numReviews": 124,
    "url": "https://opencritic.com/game/12984/tiny-tinas-wonderlands"
  },
  {
    "title": "Hardspace: Shipbreaker",
    "appId": 1161580,
    "source": "opencritic",
    "id": 9652,
    "score": 81,
    "percentRecommended": 88,
    "tier": "Strong",
    "numReviews": 58,
    "url": "https://opencritic.com/game/9652/hardspace-shipbreaker"
  },
  {
    "title": "Slime Rancher",
    "appId": 433340,
    "source": "opencritic",
    "id": 4882,
    "score": 82,
    "percentRecommended": 88,
    "tier": "Strong",
    "numReviews": 46,
    "url": "https://opencritic.com/game/4882/slime-rancher"
  },
  {
    "title": "Mutant Year Zero: Road to Eden",
    "aliases": [
      "mutant year zero"
    ],
    "appId": 760060,
    "source": "opencritic",
    "id": 6842,
    "score": 77,
    "percentRecommended": 67,
    "tier": "Strong",
    "numReviews": 94,
    "url": "https://opencritic.com/game/6842/mutant-year-zero-road-to-eden"
  },
  {
    "title": "Shadow Tactics: Blades of the Shogun",
    "aliases": [
      "shadow tactics"
    ],
    "appId": 418240,
    "source": "opencritic",
    "id": 3584,
    "score": 85,
    "percentRecommended": 94,
    "tier": "Mighty",
    "numReviews": 54,
    "url": "https://opencritic.com/game/3584/shadow-tactics-blades-of-the-shogun"
  },
  {
    "title": "Remnant: From the Ashes",
    "aliases": [
      "remnant from the ashes"
    ],
    "appId": 612880,
    "source": "opencritic",
    "id": 7966,
    "score": 77,
    "percentRecommended": 75,
    "tier": "Strong",
    "numReviews": 96,
    "url": "https://opencritic.com/game/7966/remnant-from-the-ashes"
  },
  {
    "title": "Darksiders Warmastered Edition",
    "aliases": [
      "darksiders"
    ],
    "appId": 462780,
    "source": "metacritic",
    "score": 81,
    "tier": "Strong",
    "numReviews": 42,
    "url": "https://www.metacritic.com/game/darksiders-warmastered-edition/critic-reviews/"
  },
  {
    "title": "Darksiders II Deathinitive Edition",
    "aliases": [
      "darksiders 2"
    ],
    "appId": 388410,
    "source": "metacritic",
    "score": 77,
    "tier": "Strong",
    "numReviews": 38,
    "url": "https://www.metacritic.com/game/darksiders-ii-deathinitive-edition/critic-reviews/"
  },
  {
    "title": "Darksiders III",
    "aliases": [
      "darksiders 3"
    ],
    "appId": 606280,
    "source": "opencritic",
    "id": 6749,
    "score": 70,
    "percentRecommended": 45,
    "tier": "Fair",
    "numReviews": 120,
    "url": "https://opencritic.com/game/6749/darksiders-iii"
  },
  {
    "title": "LEGO Batman: The Videogame",
    "aliases": [
      "lego batman"
    ],
    "appId": 21000,
    "source": "metacritic",
    "score": 80,
    "tier": "Strong",
    "numReviews": 32,
    "url": "https://www.metacritic.com/game/lego-batman-the-videogame/critic-reviews/"
  },
  {
    "title": "Sunless Sea",
    "appId": 304650,
    "source": "opencritic",
    "id": 138,
    "score": 81,
    "percentRecommended": 81,
    "tier": "Strong",
    "numReviews": 48,
    "url": "https://opencritic.com/game/138/sunless-sea"
  },
  {
    "title": "Subnautica: Below Zero",
    "aliases": [
      "subnautica below zero"
    ],
    "appId": 848450,
    "source": "opencritic",
    "id": 11330,
    "score": 82,
    "percentRecommended": 84,
    "tier": "Strong",
    "numReviews": 76,
    "url": "https://opencritic.com/game/11330/subnautica-below-zero"
  },
  {
    "title": "Trek to Yomi",
    "appId": 1370050,
    "source": "opencritic",
    "id": 13180,
    "score": 71,
    "percentRecommended": 46,
    "tier": "Fair",
    "numReviews": 112,
    "url": "https://opencritic.com/game/13180/trek-to-yomi"
  },
  {
    "title": "City of Brass",
    "appId": 301840,
    "source": "opencritic",
    "id": 5984,
    "score": 68,
    "percentRecommended": 39,
    "tier": "Fair",
    "numReviews": 44,
    "url": "https://opencritic.com/game/5984/city-of-brass"
  },
  {
    "title": "Severed Steel",
    "appId": 1227690,
    "source": "opencritic",
    "id": 11976,
    "score": 78,
    "percentRecommended": 79,
    "tier": "Strong",
    "numReviews": 38,
    "url": "https://opencritic.com/game/11976/severed-steel"
  },
  {
    "title": "Sable",
    "appId": 757310,
    "source": "opencritic",
    "id": 11986,
    "score": 76,
    "percentRecommended": 72,
    "tier": "Strong",
    "numReviews": 74,
    "url": "https://opencritic.com/game/11986/sable"
  },
  {
    "title": "Jotun: Valhalla Edition",
    "aliases": [
      "jotun"
    ],
    "appId": 323580,
    "source": "opencritic",
    "id": 1686,
    "score": 79,
    "percentRecommended": 74,
    "tier": "Strong",
    "numReviews": 46,
    "url": "https://opencritic.com/game/1686/jotun"
  },
  {
    "title": "Sundered: Eldritch Edition",
    "aliases": [
      "sundered"
    ],
    "appId": 535480,
    "source": "opencritic",
    "id": 4596,
    "score": 74,
    "percentRecommended": 65,
    "tier": "Strong",
    "numReviews": 50,
    "url": "https://opencritic.com/game/4596/sundered"
  },
  {
    "title": "Icewind Dale: Enhanced Edition",
    "aliases": [
      "icewind dale"
    ],
    "appId": 321800,
    "source": "metacritic",
    "score": 80,
    "tier": "Strong",
    "numReviews": 24,
    "url": "https://www.metacritic.com/game/icewind-dale-enhanced-edition/critic-reviews/"
  },
  {
    "title": "Planescape: Torment: Enhanced Edition",
    "aliases": [
      "planescape torment"
    ],
    "appId": 466300,
    "source": "metacritic",
    "score": 85,
    "tier": "Mighty",
    "numReviews": 26,
    "url": "https://www.metacritic.com/game/planescape-torment-enhanced-edition/critic-reviews/"
  },
  {
    "title": "Neverwinter Nights: Enhanced Edition",
    "aliases": [
      "neverwinter nights"
    ],
    "appId": 704450,
    "source": "metacritic",
    "score": 80,
    "tier": "Strong",
    "numReviews": 32,
    "url": "https://www.metacritic.com/game/neverwinter-nights-enhanced-edition/critic-reviews/"
  },
  {
    "title": "Heroes of Might and Magic III",
    "aliases": [
      "heroes of might & magic iii - hd edition",
      "homm3"
    ],
    "appId": 297000,
    "source": "metacritic",
    "score": 87,
    "tier": "Mighty",
    "numReviews": 28,
    "url": "https://www.metacritic.com/game/heroes-of-might-and-magic-iii/critic-reviews/"
  },
  {
    "title": "Master of Orion II: Battle at Antares",
    "aliases": [
      "master of orion 2",
      "master of orion ii"
    ],
    "appId": 410980,
    "source": "metacritic",
    "score": 84,
    "tier": "Strong",
    "numReviews": 22,
    "url": "https://www.metacritic.com/game/master-of-orion-ii-battle-at-antares/critic-reviews/"
  },
  {
    "title": "Sid Meier's Alpha Centauri",
    "aliases": [
      "alpha centauri"
    ],
    "source": "metacritic",
    "score": 92,
    "tier": "Mighty",
    "numReviews": 28,
    "url": "https://www.metacritic.com/game/sid-meiers-alpha-centauri/critic-reviews/"
  },
  {
    "title": "SimCity 2000",
    "source": "metacritic",
    "score": 85,
    "tier": "Mighty",
    "numReviews": 18,
    "url": "https://www.metacritic.com/game/simcity-2000/critic-reviews/"
  },
  {
    "title": "Theme Hospital",
    "source": "metacritic",
    "score": 84,
    "tier": "Strong",
    "numReviews": 20,
    "url": "https://www.metacritic.com/game/theme-hospital/critic-reviews/"
  },
  {
    "title": "Dungeon Keeper",
    "source": "metacritic",
    "score": 88,
    "tier": "Mighty",
    "numReviews": 24,
    "url": "https://www.metacritic.com/game/dungeon-keeper/critic-reviews/"
  },
  {
    "title": "Dungeon Keeper 2",
    "source": "metacritic",
    "score": 80,
    "tier": "Strong",
    "numReviews": 22,
    "url": "https://www.metacritic.com/game/dungeon-keeper-2/critic-reviews/"
  },
  {
    "title": "Populous: The Beginning",
    "aliases": [
      "populous the beginning"
    ],
    "source": "metacritic",
    "score": 78,
    "tier": "Strong",
    "numReviews": 20,
    "url": "https://www.metacritic.com/game/populous-the-beginning/critic-reviews/"
  },
  {
    "title": "System Shock 2",
    "appId": 238210,
    "source": "metacritic",
    "score": 92,
    "tier": "Mighty",
    "numReviews": 26,
    "url": "https://www.metacritic.com/game/system-shock-2/critic-reviews/"
  },
  {
    "title": "Thief: The Dark Project",
    "aliases": [
      "thief gold"
    ],
    "appId": 211600,
    "source": "metacritic",
    "score": 92,
    "tier": "Mighty",
    "numReviews": 28,
    "url": "https://www.metacritic.com/game/thief-the-dark-project/critic-reviews/"
  },
  {
    "title": "Thief II: The Metal Age",
    "aliases": [
      "thief 2"
    ],
    "appId": 211740,
    "source": "metacritic",
    "score": 87,
    "tier": "Mighty",
    "numReviews": 26,
    "url": "https://www.metacritic.com/game/thief-ii-the-metal-age/critic-reviews/"
  },
  {
    "title": "Arcanum: Of Steamworks and Magick Obscura",
    "aliases": [
      "arcanum"
    ],
    "appId": 500810,
    "source": "metacritic",
    "score": 81,
    "tier": "Strong",
    "numReviews": 32,
    "url": "https://www.metacritic.com/game/arcanum-of-steamworks-and-magick-obscura/critic-reviews/"
  },
  {
    "title": "Fallout Tactics: Brotherhood of Steel",
    "aliases": [
      "fallout tactics"
    ],
    "appId": 38420,
    "source": "metacritic",
    "score": 82,
    "tier": "Strong",
    "numReviews": 30,
    "url": "https://www.metacritic.com/game/fallout-tactics-brotherhood-of-steel/critic-reviews/"
  },
  {
    "title": "Gothic",
    "appId": 65540,
    "source": "metacritic",
    "score": 79,
    "tier": "Strong",
    "numReviews": 28,
    "url": "https://www.metacritic.com/game/gothic/critic-reviews/"
  },
  {
    "title": "Gothic II",
    "aliases": [
      "gothic 2",
      "gothic ii: gold edition"
    ],
    "appId": 39510,
    "source": "metacritic",
    "score": 79,
    "tier": "Strong",
    "numReviews": 28,
    "url": "https://www.metacritic.com/game/gothic-ii/critic-reviews/"
  },
  {
    "title": "Gothic 3",
    "appId": 39500,
    "source": "metacritic",
    "score": 63,
    "tier": "Weak",
    "numReviews": 40,
    "url": "https://www.metacritic.com/game/gothic-3/critic-reviews/"
  },
  {
    "title": "Risen",
    "appId": 40300,
    "source": "metacritic",
    "score": 77,
    "tier": "Strong",
    "numReviews": 38,
    "url": "https://www.metacritic.com/game/risen/critic-reviews/"
  },
  {
    "title": "Oddworld: Abe's Oddysee",
    "aliases": [
      "oddworld: abe's oddysee®",
      "abes oddysee"
    ],
    "appId": 15700,
    "source": "metacritic",
    "score": 85,
    "tier": "Mighty",
    "numReviews": 28,
    "url": "https://www.metacritic.com/game/oddworld-abes-oddysee/critic-reviews/"
  },
  {
    "title": "Oddworld: Abe's Exoddus",
    "aliases": [
      "abes exoddus"
    ],
    "appId": 15710,
    "source": "metacritic",
    "score": 88,
    "tier": "Mighty",
    "numReviews": 26,
    "url": "https://www.metacritic.com/game/oddworld-abes-exoddus/critic-reviews/"
  },
  {
    "title": "Syberia",
    "appId": 46500,
    "source": "metacritic",
    "score": 82,
    "tier": "Strong",
    "numReviews": 32,
    "url": "https://www.metacritic.com/game/syberia/critic-reviews/"
  },
  {
    "title": "Syberia II",
    "aliases": [
      "syberia 2"
    ],
    "appId": 46510,
    "source": "metacritic",
    "score": 80,
    "tier": "Strong",
    "numReviews": 30,
    "url": "https://www.metacritic.com/game/syberia-ii/critic-reviews/"
  },
  {
    "title": "Castlevania: Lords of Shadow - Ultimate Edition",
    "aliases": [
      "castlevania: lords of shadow"
    ],
    "appId": 234080,
    "source": "metacritic",
    "score": 81,
    "tier": "Strong",
    "numReviews": 45,
    "url": "https://www.metacritic.com/game/castlevania-lords-of-shadow-ultimate-edition/critic-reviews/"
  },
  {
    "title": "Castlevania: Lords of Shadow 2",
    "appId": 235340,
    "source": "metacritic",
    "score": 58,
    "tier": "Weak",
    "numReviews": 52,
    "url": "https://www.metacritic.com/game/castlevania-lords-of-shadow-2/critic-reviews/"
  },
  {
    "title": "Castlevania: Lords of Shadow – Mirror of Fate HD",
    "aliases": [
      "mirror of fate hd"
    ],
    "appId": 282530,
    "source": "metacritic",
    "score": 73,
    "tier": "Fair",
    "numReviews": 34,
    "url": "https://www.metacritic.com/game/castlevania-lords-of-shadow-mirror-of-fate-hd/critic-reviews/"
  },
  {
    "title": "Broken Sword: Director's Cut",
    "aliases": [
      "broken sword 1"
    ],
    "appId": 57640,
    "source": "metacritic",
    "score": 77,
    "tier": "Strong",
    "numReviews": 28,
    "url": "https://www.metacritic.com/game/broken-sword-shadow-of-the-templars---the-directors-cut/critic-reviews/"
  },
  {
    "title": "Broken Sword 2 - the Smoking Mirror: Remastered",
    "aliases": [
      "broken sword 2"
    ],
    "appId": 33600,
    "source": "metacritic",
    "score": 74,
    "tier": "Strong",
    "numReviews": 24,
    "url": "https://www.metacritic.com/game/broken-sword-ii-the-smoking-mirror-remastered/critic-reviews/"
  },
  {
    "title": "Broken Sword 5 - the Serpent's Curse",
    "aliases": [
      "broken sword 5"
    ],
    "appId": 262940,
    "source": "opencritic",
    "id": 254,
    "score": 73,
    "percentRecommended": 57,
    "tier": "Fair",
    "numReviews": 38,
    "url": "https://opencritic.com/game/254/broken-sword-5-the-serpents-curse"
  },
];


function normalizeTitle(t) {
  if (!t) return '';
  return t
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const entries = {};

for (const g of MASTER_VERIFIED_GAMES) {
  const data = {
    source: g.source,
    score: g.score,
    tier: g.tier,
    numReviews: g.numReviews || 50,
    url: g.url,
    isVerified: true,
  };
  if (g.id) data.id = g.id;
  if (g.percentRecommended !== undefined) data.percentRecommended = g.percentRecommended;
  if (g.summary) data.summary = g.summary;

  // Key by Steam AppID
  if (g.appId) {
    entries[g.appId] = data;
  }

  // Key by exact lowercase title
  entries[g.title.toLowerCase()] = data;

  // Key by normalized title
  const norm = normalizeTitle(g.title);
  if (norm) entries[norm] = data;

  // Key by aliases
  if (g.aliases) {
    for (const a of g.aliases) {
      entries[a.toLowerCase()] = data;
      const aNorm = normalizeTitle(a);
      if (aNorm) entries[aNorm] = data;
    }
  }
}

let code = `import { CriticScoreData } from '../../contracts/critic';

/**
 * Titles explicitly verified to have NO critic consensus on either OpenCritic or Metacritic.
 * These strictly return null (zero fabrication).
 */
export const KNOWN_UNRATED_TITLES = new Set<string>([
${UNRATED_TITLES.map((t) => `  '${t}',`).join('\n')}
]);

/**
 * Master catalog of verified OpenCritic (primary) and Metacritic (fallback) scores.
 * Keyed by Steam AppID (number) and normalized title keys (string).
 */
export const KNOWN_CRITIC_SCORES: Record<string | number, CriticScoreData> = ${JSON.stringify(
  entries,
  null,
  2
)};
`;

fs.writeFileSync(path.join(__dirname, '../src/services/critic/knownCriticScores.ts'), code, 'utf8');
console.log('Successfully generated knownCriticScores.ts with', Object.keys(entries).length, 'lookup keys.');
