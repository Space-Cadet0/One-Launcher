/**
 * IGDB Cover Art Service
 * Provides instantaneous resolution and dynamic fallback to high-resolution
 * portrait covers hosted on images.igdb.com.
 */

const STORAGE_KEY_IGDB_COVERS = 'antigravity_igdb_covers';

// Steam App IDs verified to not host standard unhashed library_600x900 assets on Steam CDN
export const KNOWN_DEAD_STEAM_COVER_APP_IDS = new Set<number>([
  1904620, // Champions of Krynn
  1904621, // Death Knights of Krynn
  1904622, // The Dark Queen of Krynn
  1018010, // Castlevania Anniversary Collection
  3783210, // 60 Minutes to Extinction: Escape Room
  3751260, // The Blood of Dawnwalker
  2149010, // Little Nightmares Enhanced Edition
  2700,    // RollerCoaster Tycoon 3: Platinum (delisted, active is 1368820)
  3286930, // Heretic + Hexen (uses hashed library_capsule.jpg)
  3764200, // Resident Evil Requiem (uses hashed library_capsule.jpg)
  3280350, // Death Stranding 2: On The Beach (uses hashed library_capsule.jpg)
  235900,  // RPG Maker XP (no unhashed library_600x900)
  1904520, // Curse of the Azure Bonds
  1904600, // Dark Sun: Shattered Lands
  1904601, // Dark Sun: Wake of the Ravager
  2350512, // Dragons of Flame
  1904551, // Dungeon Hack
  1882261, // Eye of the Beholder II: The Legend of Darkmoon
  1882262, // Eye of the Beholder III: Assault on Myth Drannor
  1904523, // Gateway to the Savage Frontier
  2350511, // Heroes of the Lance
  1904525, // Hillsfar
  946660,  // Loria
  1904550, // Menzoberranzan
  431650,  // Phoning Home
  1882370, // Pool of Radiance
  1904522, // Pools of Darkness
  227220,  // Sang-Froid: Tales of Werewolves
  1904521, // Secret of the Silver Blades
  2350510, // Shadow Sorcerer
  32380,   // STAR WARS™ Jedi Knight: Dark Forces II
  1904524, // Treasures of the Savage Frontier
  2350513, // War of the Lance
  537520,  // SYMMETRY
  242700,  // Injustice: Gods Among Us Ultimate Edition
  293180,  // Overcast - Walden and the Werewolf
  1309,    // SiN Multiplayer
  285570,  // STAR WARS™ Rebellion
  1365860, // Lacuna (no unhashed library_600x900)
]);

export function isKnownDeadSteamCover(appId?: number | null): boolean {
  if (!appId) return false;
  return KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId);
}

// Curated dictionary of verified official IGDB portrait covers (2:3 / 3:4 aspect ratio)
export const KNOWN_IGDB_COVERS: Record<string, string> = {
  // Champions of Krynn & Krynn series
  'champions of krynn': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co5xot.webp',
  'death knights of krynn': 'https://images.igdb.com/igdb/image/upload/t_cover_big/jwamgwjf5mei3uyxazwc.jpg',
  'the dark queen of krynn': 'https://images.igdb.com/igdb/image/upload/t_cover_big/hvbou7fij6enuysl0zyp.jpg',

  // Castlevania Anniversary Collection
  'castlevania anniversary collection': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co24a1.jpg',

  // 60 Minutes to Extinction
  '60 minutes to extinction escape room': 'https://images.igdb.com/igdb/image/upload/t_cover_big/coak2y.jpg',
  '60 minutes to extinction: escape room': 'https://images.igdb.com/igdb/image/upload/t_cover_big/coak2y.jpg',

  // Another World
  'another world 20th anniversary edition': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1x7k.jpg',
  'another world: 20th anniversary edition': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1x7k.jpg',
  'another world': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1x7k.jpg',

  // Ascendant
  'ascendant': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2kdv.jpg',

  // Betrayer
  'betrayer': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2h9l.jpg',

  // Bio Menace
  'bio menace': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1og1.jpg',
  'biomenace': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1og1.jpg',

  // Blood Omen: Legacy of Kain
  'blood omen legacy of kain': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2jds.jpg',
  'blood omen: legacy of kain': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2jds.jpg',

  // The Blood of Dawnwalker / Dawnwalker
  'the blood of dawnwalker': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3751260/82769ab631e6e68b4a38bbba9fb5b74eb0d7db8d/library_capsule.jpg',
  'dawnwalker': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3751260/82769ab631e6e68b4a38bbba9fb5b74eb0d7db8d/library_capsule.jpg',

  // Little Nightmares Enhanced Edition
  'little nightmares enhanced edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/424840/library_600x900_2x.jpg',

  // Akalabeth: World of Doom
  'akalabeth world of doom': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',
  'akalabeth: world of doom': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',
  'akalabeth': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co26ea.jpg',

  // Broken Sword: Director's Cut
  'broken sword directors cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword: directors cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword: director\'s cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword the shadow of the templars the directors cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword: the shadow of the templars – the director\'s cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',
  'broken sword shadow of the templars': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2mmq.jpg',

  // Citadel Remonstered / Cytadela
  'citadel remonstered': 'https://images.igdb.com/igdb/image/upload/t_cover_big/coc0q5.webp',
  'citadel: remonstered': 'https://images.igdb.com/igdb/image/upload/t_cover_big/coc0q5.webp',
  'cytadela': 'https://images.igdb.com/igdb/image/upload/t_cover_big/coc0q5.webp',

  // DOOM + DOOM II
  'doom + doom ii': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2280/library_600x900_2x.jpg',
  'doom + doom 2': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2280/library_600x900_2x.jpg',

  // Retro & GOG Classics
  'daggerfall unity - gog cut': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1vup.jpg',
  'daggerfall unity': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1vup.jpg',
  'syndicate plus': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2fz3.jpg',
  'syndicate wars': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2kt9.jpg',
  'tyrian 2000': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2zg1.jpg',
  'flight of the amazon queen': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2i9b.jpg',
  'lure of the temptress': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',
  'doomdark\'s revenge': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co6q0g.jpg',
  'doomdarks revenge': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co6q0g.jpg',
  'd&d stronghold: kingdom simulator': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co3cr6.jpg',
  'fate': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/246840/library_600x900_2x.jpg',
  'fate: undiscovered realms': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/276890/library_600x900_2x.jpg',
  'fate undiscovered realms': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/276890/library_600x900_2x.jpg',
  'fallout london': 'https://images.gog-statics.com/b9a00e7d9a9d8cb5d17ec67aa41dc8d392358e0340d679f855fa113c444c11ee.jpg',
  'fallout: london': 'https://images.gog-statics.com/b9a00e7d9a9d8cb5d17ec67aa41dc8d392358e0340d679f855fa113c444c11ee.jpg',
  'eschalon: book i': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co214q.webp',
  'eschalon book i': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co214q.webp',
  'eschalon: book 1': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co214q.webp',
  'eschalon book 1': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co214q.webp',
  'agony': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/487720/library_600x900_2x.jpg',
  'agony unrated': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/879420/library_600x900_2x.jpg',
  'grip': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/396900/library_600x900_2x.jpg',
  'grip: combat racing': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/396900/library_600x900_2x.jpg',
  'grip combat racing': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/396900/library_600x900_2x.jpg',
  'gamedec': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/917720/library_600x900_2x.jpg',
  'gamedec: definitive edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/917720/library_600x900_2x.jpg',
  'gamedec definitive edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/917720/library_600x900_2x.jpg',
  'shadowrun hong kong': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/346940/library_600x900_2x.jpg',
  'shadowrun: hong kong - extended edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/346940/library_600x900_2x.jpg',
  'shadowrun hong kong - extended edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/346940/library_600x900_2x.jpg',
  'shadowrun hong kong extended edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/346940/library_600x900_2x.jpg',
  'deus ex 2: invisible war': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6920/library_600x900_2x.jpg',
  'deus ex: invisible war': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6920/library_600x900_2x.jpg',
  'deus ex 2 invisible war': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6920/library_600x900_2x.jpg',
  'deus ex invisible war': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6920/library_600x900_2x.jpg',
  'deus ex: human revolution - director\'s cut': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/238010/library_600x900_2x.jpg',
  'deus ex: human revolution - director’s cut': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/238010/library_600x900_2x.jpg',
  'deus ex human revolution director\'s cut': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/238010/library_600x900_2x.jpg',
  'deus ex human revolution directors cut': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/238010/library_600x900_2x.jpg',
  'deus ex: human revolution': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/238010/library_600x900_2x.jpg',
  'deus ex human revolution': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/238010/library_600x900_2x.jpg',
  'lacuna – a sci-fi noir adventure': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co38sl.jpg',
  'lacuna: a sci-fi noir adventure': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co38sl.jpg',
  'lacuna a sci fi noir adventure': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co38sl.jpg',
  'lacuna': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co38sl.jpg',
  'shadow warrior classic complete': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1pqn.jpg',
  'shadow warrior classic': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1pqn.jpg',

  // Wildgate
  'wildgate': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co9kqs.jpg',

  // Heretic + Hexen
  'heretic + hexen': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3286930/dbdad6a66e6a076d138b9ce8bd81dbdf159bccb2/library_capsule.jpg',
  'heretic hexen': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3286930/dbdad6a66e6a076d138b9ce8bd81dbdf159bccb2/library_capsule.jpg',

  // RollerCoaster Tycoon 3: Complete Edition
  'rollercoaster tycoon 3 complete edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',
  'rollercoaster tycoon 3: complete edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',
  'rollercoaster tycoon 3': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1368820/library_600x900_2x.jpg',

  // Higurashi When They Cry Hou - Ch.1 Onikakushi
  'higurashi when they cry hou ch 1 onikakushi': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',
  'higurashi when they cry hou - ch.1 onikakushi': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',
  'higurashi when they cry hou ch.1 onikakushi': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/310360/library_600x900_2x.jpg',

  // Lure of the Temptress (1992)
  'lure of the temptress (1992)': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',
  'lure of the temptress 1992': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1npy.jpg',

  // Resident Evil Requiem
  'resident evil requiem': 'https://images.igdb.com/igdb/image/upload/t_cover_big/cobmj0.jpg',

  // Death Stranding 2: On The Beach
  'death stranding 2 on the beach': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3280350/9b523fd411eeaefe80f238489745325a1cd2317f/library_capsule.jpg',
  'death stranding 2': 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3280350/9b523fd411eeaefe80f238489745325a1cd2317f/library_capsule.jpg',

  // RPG Maker XP
  'rpg maker xp': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2r75.jpg',

  // SNEG & D&D Gold Box Classics
  'war of the lance': 'https://images.igdb.com/igdb/image/upload/t_cover_big/c5ebwbjcndr79evxabjq.jpg',
  'treasures of the savage frontier': 'https://images.igdb.com/igdb/image/upload/t_cover_big/yueo852gaefw6e76c9cc.jpg',
  'gateway to the savage frontier': 'https://images.igdb.com/igdb/image/upload/t_cover_big/ezuoi1vqt7icnjtnfjaa.jpg',
  'pool of radiance': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2pdu.jpg',
  'curse of the azure bonds': 'https://images.igdb.com/igdb/image/upload/t_cover_big/t9bbkwevt4ykbj51zxeu.jpg',
  'secret of the silver blades': 'https://images.igdb.com/igdb/image/upload/t_cover_big/wgdcvuxvzkoes5l2jigv.jpg',
  'pools of darkness': 'https://images.igdb.com/igdb/image/upload/t_cover_big/k03wye0gysy3utbvrexr.jpg',
  'hillsfar': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1xub.jpg',
  'dragons of flame': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1qm2.jpg',
  'heroes of the lance': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co3o6v.jpg',
  'shadow sorcerer': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co78tc.jpg',
  'dungeon hack': 'https://images.igdb.com/igdb/image/upload/t_cover_big/ej1k1t0inmsebismdrrp.jpg',
  'eye of the beholder ii the legend of darkmoon': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co28s8.jpg',
  'eye of the beholder ii: the legend of darkmoon': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co28s8.jpg',
  'eye of the beholder iii assault on myth drannor': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co28s9.jpg',
  'eye of the beholder iii: assault on myth drannor': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co28s9.jpg',
  'menzoberranzan': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2hkg.jpg',
  'dark sun shattered lands': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2hki.jpg',
  'dark sun: shattered lands': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2hki.jpg',
  'dark sun wake of the ravager': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co3izp.jpg',
  'dark sun: wake of the ravager': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co3izp.jpg',
  'fantasy general': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2jkd.jpg',

  // Dead Steam Classics
  'loria': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co6aqi.jpg',
  'phoning home': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co21fx.jpg',
  'sang froid tales of werewolves': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2211.jpg',
  'sang-froid: tales of werewolves': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2211.jpg',
  'star wars jedi knight dark forces ii': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co25xt.jpg',
  'star wars jedi knight: dark forces ii': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co25xt.jpg',
  'star wars jedi knight dark forces ii mysteries of the sith': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co25zg.jpg',
  'star wars jedi knight: dark forces ii - mysteries of the sith': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co25zg.jpg',
  'star wars rebellion': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2jp7.jpg',
  'symmetry': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co237w.jpg',
  'injustice gods among us ultimate edition': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1mym.jpg',
  'injustice: gods among us ultimate edition': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1mym.jpg',
  'overcast walden and the werewolf': 'https://images.igdb.com/igdb/image/upload/t_cover_big/a6totrsausiushi3gumd.jpg',
  'overcast - walden and the werewolf': 'https://images.igdb.com/igdb/image/upload/t_cover_big/a6totrsausiushi3gumd.jpg',
  'sin multiplayer': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2ch6.jpg',

  // Thief series & Predator
  'thief 2 the metal age': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/211740/library_600x900_2x.jpg',
  'thief 2: the metal age': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/211740/library_600x900_2x.jpg',
  'thief ii the metal age': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/211740/library_600x900_2x.jpg',
  'thief ii: the metal age': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/211740/library_600x900_2x.jpg',
  'thief 3 deadly shadows': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6980/library_600x900_2x.jpg',
  'thief 3: deadly shadows': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6980/library_600x900_2x.jpg',
  'thief: deadly shadows': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6980/library_600x900_2x.jpg',
  'predator hunting grounds': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1556200/library_600x900_2x.jpg',
  'predator: hunting grounds': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1556200/library_600x900_2x.jpg',
  'predator hunting grounds standard edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1556200/library_600x900_2x.jpg',
  'predator: hunting grounds standard edition': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1556200/library_600x900_2x.jpg',

  // Ultima & GOG Classics
  'ultima underworld the stygian abyss': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2cq5.jpg',
  'ultima underworld: the stygian abyss': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2cq5.jpg',
  'ultima underworld i': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2cq5.jpg',
  'ultima underworld ii labyrinth of worlds': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2cq2.jpg',
  'ultima underworld ii: labyrinth of worlds': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2cq2.jpg',
  'ultima underworld ii': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2cq2.jpg',
  'ultima iv quest of the avatar': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2cqa.jpg',
  'ultima iv: quest of the avatar': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2cqa.jpg',
  'ultima worlds of adventure 2 martian dreams': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co4atv.jpg',
  'ultima worlds of adventure 2: martian dreams': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co4atv.jpg',
  'worlds of ultima the savage empire': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co4atz.jpg',
  'worlds of ultima: the savage empire': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co4atz.jpg',
  'teenagent': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2dkg.jpg',
  'the lords of midnight': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2e2l.jpg',
  'the whispered world special edition': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2thc.jpg',
  'the whispered world: special edition': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2thc.jpg',
  'sin slayers the first sin': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2m8i.jpg',
  'sin slayers: the first sin': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2m8i.jpg',
  'dink smallwood hd': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1pko.jpg',
  'dink smallwood': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1pko.jpg',
  'fall of porcupine': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co3mlj.jpg',
  'fall of porcupine prologue': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co3mlj.jpg',
  'fall of porcupine: prologue': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co3mlj.jpg',
  'jill of the jungle the complete trilogy': 'https://images.igdb.com/igdb/image/upload/t_cover_big/sttz0lxyhx7bwmgu02cx.jpg',
  'jill of the jungle: the complete trilogy': 'https://images.igdb.com/igdb/image/upload/t_cover_big/sttz0lxyhx7bwmgu02cx.jpg',
  'jill of the jungle': 'https://images.igdb.com/igdb/image/upload/t_cover_big/sttz0lxyhx7bwmgu02cx.jpg',
  'grim fandango remastered': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co27pj.jpg',
  'chivalry 2 public testing': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1824220/library_600x900_2x.jpg',
  'chivalry 2 - public testing': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1824220/library_600x900_2x.jpg',
};

export const NORMALIZED_KNOWN_IGDB_COVERS = new Map<string, string>();

for (const [k, v] of Object.entries(KNOWN_IGDB_COVERS)) {
  NORMALIZED_KNOWN_IGDB_COVERS.set(k.toLowerCase().trim(), v);
  NORMALIZED_KNOWN_IGDB_COVERS.set(normalizeKey(k), v);
}

/**
 * Checks whether an image URL represents an unsuitable horizontal banner,
 * wide capsule, or broken asset that should not be displayed in a 2:3 portrait card.
 */
export function isUnsuitableCoverUrl(url?: string | null): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();

  // 1. Known horizontal banner URL dimensions / names
  if (
    lower.includes('231x87') ||
    lower.includes('467x181') ||
    lower.includes('616x353') ||
    lower.includes('header.jpg') ||
    lower.includes('mobile_slider') ||
    lower.includes('sbicon') ||
    lower.includes('avatars/default.png') ||
    lower.includes('egs-badge') ||
    lower.includes('co8j9u') ||
    lower.includes('wide') ||
    lower.includes('landscape')
  ) {
    return true;
  }

  // 2. Dead Steam App IDs returning 404
  for (const deadId of KNOWN_DEAD_STEAM_COVER_APP_IDS) {
    if (lower.includes(`apps/${deadId}/library_600x900`)) return true;
  }

  return false;
}

export function normalizeKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/[:\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function computeTokenSimilarity(t1: string, t2: string): number {
  const cleanT1 = t1.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '');
  const cleanT2 = t2.toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '');
  const list1 = cleanT1.split(/\s+/).filter((w) => w.length > 2);
  const list2 = cleanT2.split(/\s+/).filter((w) => w.length > 2);
  const words1 = new Set(list1);
  const words2 = new Set(list2);
  if (words1.size === 0 || words2.size === 0) return 0;

  // Intelligent Edition Variant Matching
  const [shorterSet, longerList] = words1.size <= words2.size ? [words1, list2] : [words2, list1];
  let allShorterInLonger = true;
  for (const w of shorterSet) {
    if (!longerList.includes(w)) {
      allShorterInLonger = false;
      break;
    }
  }
  if (allShorterInLonger) {
    let onlyEditionTokensRemaining = true;
    for (const w of longerList) {
      if (!shorterSet.has(w) && !EDITION_WORDS.has(w)) {
        onlyEditionTokensRemaining = false;
        break;
      }
    }
    if (onlyEditionTokensRemaining) {
      return 0.92;
    }
  }

  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  return intersection / Math.max(words1.size, words2.size);
}

export class IgdbCoverService {
  private cache = new Map<string, string | null>();
  private pendingFetches = new Map<string, Promise<string | null>>();

  constructor() {
    this.loadPersistentCache();
  }

  private loadPersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY_IGDB_COVERS);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') {
            this.cache.set(normalizeKey(k), v);
          }
        }
      }
    } catch {
      // Ignore storage read error
    }
  }

  private savePersistentCache() {
    if (typeof window === 'undefined') return;
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.cache.entries()) {
        if (v) obj[k] = v;
      }
      localStorage.setItem(STORAGE_KEY_IGDB_COVERS, JSON.stringify(obj));
    } catch {
      // Ignore storage write error
    }
  }

  /**
   * Fast synchronous lookup against curated mappings and local storage cache.
   * Returns instant image URL or null.
   */
  getIgdbCoverInstant(title?: string, steamAppId?: number, gameId?: string): string | null {
    if (!title && !steamAppId && !gameId) return null;

    if (title) {
      const cleanRaw = title.trim();
      const lower = cleanRaw.toLowerCase();
      const norm = normalizeKey(cleanRaw);

      // 1. Curated official covers take precedence over dynamic / local cache
      const match =
        NORMALIZED_KNOWN_IGDB_COVERS.get(lower) ||
        NORMALIZED_KNOWN_IGDB_COVERS.get(norm) ||
        KNOWN_IGDB_COVERS[lower] ||
        KNOWN_IGDB_COVERS[norm];

      if (match) {
        return match;
      }

      // 2. Dynamic cache
      if (this.cache.has(norm)) {
        return this.cache.get(norm) || null;
      }
      if (this.cache.has(lower)) {
        return this.cache.get(lower) || null;
      }
    }

    if (gameId) {
      const cleanId = gameId.trim();
      const lowerId = cleanId.toLowerCase();
      const normId = normalizeKey(cleanId);

      // 1. Curated official covers take precedence over dynamic / local cache
      const match =
        NORMALIZED_KNOWN_IGDB_COVERS.get(lowerId) ||
        NORMALIZED_KNOWN_IGDB_COVERS.get(normId) ||
        KNOWN_IGDB_COVERS[lowerId] ||
        KNOWN_IGDB_COVERS[normId];

      if (match) {
        return match;
      }

      // 2. Dynamic cache
      if (this.cache.has(normId)) {
        return this.cache.get(normId) || null;
      }
      if (this.cache.has(lowerId)) {
        return this.cache.get(lowerId) || null;
      }
    }

    return null;
  }

  /**
   * Asynchronous dynamic lookup against IGDB/Lutris metadata.
   * Caches results persistently and dispatches an update event for reactive UI re-renders.
   */
  async fetchIgdbCover(title: string): Promise<string | null> {
    if (!title || !title.trim()) return null;
    const cleanRaw = title.trim();
    const norm = normalizeKey(cleanRaw);

    // Check instant cache
    const instant = this.getIgdbCoverInstant(cleanRaw);
    if (instant) return instant;

    // Deduplicate in-flight requests
    if (this.pendingFetches.has(norm)) {
      return this.pendingFetches.get(norm)!;
    }

    const fetchPromise = (async (): Promise<string | null> => {
      // 1. Try Electron native IPC if in desktop app
      if (typeof window !== 'undefined' && window.electronAPI?.fetchIgdbCover) {
        try {
          const cover = await window.electronAPI.fetchIgdbCover(cleanRaw);
          if (cover && typeof cover === 'string') {
            this.cache.set(norm, cover);
            this.savePersistentCache();
            this.notifyCoverUpdated(cleanRaw, cover);
            return cover;
          }
        } catch {
          // Fallback to fetch
        }
      }

      // 2. Query search endpoint via Vite proxy or direct HTTPS
      try {
        const query = cleanRaw.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        const searchUrl =
          typeof window !== 'undefined' && window.location.hostname === 'localhost'
            ? `/api/lutris/api/games?search=${encodeURIComponent(query)}`
            : `https://lutris.net/api/games?search=${encodeURIComponent(query)}`;

        const res = await fetch(searchUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
          },
        });

        if (res.ok) {
          const data = await res.json();
          const items: any[] = data.results || [];
          if (items.length > 0) {
            let bestCover: string | null = null;
            let bestScore = -1;

            for (const item of items) {
              if (!item.coverart) continue;
              const candNorm = normalizeKey(item.name || '');
              let score = computeTokenSimilarity(norm, candNorm) * 100;
              if (candNorm === norm) score += 50;

              if (score > bestScore && score >= 50) {
                bestScore = score;
                const m = item.coverart.match(/\/([a-zA-Z0-9_-]+)\.(?:jpg|png|webp)/i);
                if (m && !m[1].startsWith('banner_') && !m[1].startsWith('library_capsule') && !m[1].startsWith('header_')) {
                  bestCover = `https://images.igdb.com/igdb/image/upload/t_cover_big/${m[1]}.jpg`;
                } else if (item.coverart.startsWith('http') && !isUnsuitableCoverUrl(item.coverart)) {
                  bestCover = item.coverart;
                }
              }
            }

            if (bestCover) {
              this.cache.set(norm, bestCover);
              this.savePersistentCache();
              this.notifyCoverUpdated(cleanRaw, bestCover);
              return bestCover;
            }
          }
        }
      } catch (err: any) {
        console.warn('Dynamic IGDB cover fetch error for', cleanRaw, err?.message);
      }

      // Mark negative cache to avoid infinite retries
      this.cache.set(norm, null);
      return null;
    })();

    this.pendingFetches.set(norm, fetchPromise);
    try {
      const res = await fetchPromise;
      return res;
    } finally {
      this.pendingFetches.delete(norm);
    }
  }

  private notifyCoverUpdated(title: string, coverUrl: string) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('antigravity:igdb-cover-updated', {
          detail: { title, coverUrl },
        })
      );
    }
  }
}

export const igdbCoverService = new IgdbCoverService();
