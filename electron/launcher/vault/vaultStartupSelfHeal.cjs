// @ts-check
'use strict';

const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  CURRENT_SELF_HEAL_VERSION,
  compressVaultJson,
  parseVaultJson,
  isDbReadOnly,
} = require('./vaultSchemaAndLifecycle.cjs');
const {
  hasXboxPlatform,
  extractXboxBigIdsFromGame,
  buildVaultPlatformSanitizeContext,
  sanitizeVaultPlatformEntriesOsFlags,
  isFederatedAssetRowCompatible,
} = require('./vaultMetadataLattice.cjs');

/**
 * Single-pass, `self_heal_version`-gated startup self-heal inside ONE `BEGIN IMMEDIATE ... COMMIT`
 * transaction:
 * - O(1) on clean boots once `vault_meta['self_heal_version'] >= CURRENT_SELF_HEAL_VERSION`.
 * - O(1) without stamping when both `vault_games` and `game_media_assets` are completely empty
 *   (so freshly initialized vaults stay zero-cost while raw-insert-then-reopen fixtures still heal).
 * - Coalesces all 4 healing passes (authoritative downgrade, duplicate `xbox-<BigId>` pruning,
 *   incompatible federated media reset, platform OS/13-field/worksOn/expired-sub repair) AND
 *   `url_resolution_cache` cleanup into a single `vault_games` table scan + single transaction!
 *
 * @param {any} service
 * @param {any} db
 * @param {{ force?: boolean }} [options]
 * @returns {{ skipped: boolean, version: number, downgraded: number, deletedGames: number, repairedOs: number, resetFederated: number }}
 */
function runStartupSelfHeal(service, db, options = {}) {
  const emptyResult = {
    skipped: true,
    version: CURRENT_SELF_HEAL_VERSION,
    downgraded: 0,
    deletedGames: 0,
    repairedOs: 0,
    resetFederated: 0,
  };
  if (!db) return emptyResult;

  try {
    const force = Boolean(options && options.force);
    const getStmt = (/** @type {string} */ key, /** @type {string} */ sql) =>
      service.stmtCache ? service.stmtCache.get(key, sql) : db.prepare(sql);

    if (!force) {
      const verRow = getStmt(
        'meta.getByKey',
        'SELECT value FROM vault_meta WHERE key = ?'
      ).get('self_heal_version');
      const currentVer = Number(verRow?.value || 0);
      if (Number.isFinite(currentVer) && currentVer >= CURRENT_SELF_HEAL_VERSION) {
        return emptyResult;
      }

      // Fast O(1) empty-database check: skip scan and avoid stamping until data exists
      const presenceRow = getStmt(
        'selfHeal.checkNonEmpty',
        'SELECT EXISTS(SELECT 1 FROM vault_games) AS has_games, EXISTS(SELECT 1 FROM game_media_assets) AS has_assets'
      ).get();
      if (!Number(presenceRow?.has_games) && !Number(presenceRow?.has_assets)) {
        return emptyResult;
      }
    }

    // SINGLE table scan across `vault_games` coalescing Passes 1, 2, and 4
    const allGames = getStmt(
      'selfHeal.scanVaultGames',
      'SELECT game_id, platforms_json, summary_json, enriched_json, metadata_quality FROM vault_games'
    ).all();

    /** @type {Map<string, { enrichedJson: string | null }>} */
    const authoritativeDowngrades = new Map();
    /** @type {Set<string>} */
    const duplicateXboxDeleteIds = new Set();
    /** @type {Set<string>} */
    const orphanPruneIds = new Set();
    /** @type {Map<string, { platformsJson: string | null, summaryJson: string | null }>} */
    const osRepairs = new Map();

    for (const row of allGames) {
      if (!row || !row.game_id) continue;
      const gid = String(row.game_id);
      const summary = row.summary_json ? parseVaultJson(row.summary_json) : null;
      const parsedPlatforms = row.platforms_json ? parseVaultJson(row.platforms_json) : null;
      const rawPlats = parsedPlatforms || summary?.platforms;
      const enrichedObj = row.enriched_json ? parseVaultJson(row.enriched_json) : null;

      // Pass A: Downgrade poisoned `metadata_quality = 'authoritative'` on Steam/Xbox rows
      if (row.metadata_quality === 'authoritative') {
        const isXboxOrSteamRow =
          gid.startsWith('steam-') ||
          gid.startsWith('xbox-') ||
          gid.startsWith('xbox_') ||
          hasXboxPlatform({ id: gid, ...(summary || {}), platforms: rawPlats });
        if (isXboxOrSteamRow) {
          const hasPosAppId = Boolean(enrichedObj && Number(enrichedObj.appId) > 0);
          const isExplicitXboxNative = Boolean(
            enrichedObj &&
              (enrichedObj.enrichedSource === 'xbox' ||
                enrichedObj.metadataQuality === 'storefront_native')
          );
          if (!hasPosAppId || isExplicitXboxNative) {
            let updatedJson = row.enriched_json;
            if (enrichedObj && typeof enrichedObj === 'object') {
              enrichedObj.metadataQuality = 'storefront_native';
              updatedJson = compressVaultJson(JSON.stringify(enrichedObj));
            }
            authoritativeDowngrades.set(gid, { enrichedJson: updatedJson });
          }
        }
      }

      // Pass B: Collect orphaned duplicate `xbox-<BigId>` rows superseded by cross-merged canonical games
      if (!/^xbox[-_]/i.test(gid)) {
        const bigIds = extractXboxBigIdsFromGame(summary, parsedPlatforms);
        for (const bigId of bigIds) {
          const dupVariants = [
            `xbox-${bigId.toLowerCase()}`,
            `xbox-${bigId.toUpperCase()}`,
            `xbox_${bigId.toLowerCase()}`,
            `xbox_${bigId.toUpperCase()}`,
          ];
          for (const dupId of dupVariants) {
            if (dupId !== gid) {
              duplicateXboxDeleteIds.add(dupId);
            }
          }
        }
      }

      // Pass C: Self-heal platform OS flags, all 13 context fields, worksOn & expired-sub orphans
      if (Array.isArray(rawPlats)) {
        const hasEnrichedForOs = Boolean(
          enrichedObj &&
            !(enrichedObj.enrichedSource === 'xbox' && !(Number(enrichedObj.appId) > 0))
        );
        const sanitized = sanitizeVaultPlatformEntriesOsFlags(
          rawPlats,
          hasEnrichedForOs,
          buildVaultPlatformSanitizeContext(summary, enrichedObj)
        );
        const finalPlats = sanitized.platforms || rawPlats;
        if (rawPlats.length > 0 && Array.isArray(finalPlats) && finalPlats.length === 0) {
          orphanPruneIds.add(gid);
          continue;
        }
        const allPlatsExplicitlyNonMac = Boolean(
          Array.isArray(finalPlats) &&
            finalPlats.length > 0 &&
            finalPlats.every(
              (ep) =>
                ep &&
                !ep.isCrossPlatformLauncherRuntime &&
                ep.platforms &&
                typeof ep.platforms === 'object' &&
                ep.platforms.mac === false
            )
        );
        const worksOnPoisoned = Boolean(
          summary?.worksOn &&
            typeof summary.worksOn === 'object' &&
            ((!summary.worksOn.windows &&
              !summary.worksOn.mac &&
              !summary.worksOn.linux) ||
              (summary.worksOn.mac === true && allPlatsExplicitlyNonMac))
        );
        if (sanitized.repaired || worksOnPoisoned) {
          const updatedPlatsJson = sanitized.platforms
            ? compressVaultJson(JSON.stringify(sanitized.platforms))
            : null;
          let updatedSummaryJson = row.summary_json;
          if (summary && typeof summary === 'object') {
            const nextSummary = { ...summary, platforms: sanitized.platforms };
            if (worksOnPoisoned) {
              nextSummary.worksOn = {
                windows: true,
                mac: false,
                linux: Boolean(summary?.worksOn?.linux),
              };
            }
            if (
              Array.isArray(finalPlats) &&
              finalPlats.length === 1 &&
              finalPlats[0]?.chainedLauncherHandoff &&
              (nextSummary.externalStorefrontHandoff || nextSummary.chainedLauncherHandoff)
            ) {
              nextSummary.chainedLauncherHandoff = finalPlats[0].chainedLauncherHandoff;
              nextSummary.externalStorefrontHandoff = finalPlats[0].externalStorefrontHandoff;
            }
            updatedSummaryJson = compressVaultJson(JSON.stringify(nextSummary));
          }
          osRepairs.set(gid, {
            platformsJson: updatedPlatsJson,
            summaryJson: updatedSummaryJson,
          });
        }
      }
    }

    // Pass D: Scan federated media rows once for incompatible cross-store / mismatched-hash rows
    const federatedRows = getStmt(
      'selfHeal.scanFederatedAssets',
      "SELECT url_key, game_id, asset_role, ordinal, source_url, federated_path FROM game_media_assets WHERE storage_kind = 'federated'"
    ).all();
    /** @type {Array<{ urlKey: string, gameId: string }>} */
    const invalidFederatedAssets = [];
    if (Array.isArray(federatedRows)) {
      for (const fedRow of federatedRows) {
        if (!fedRow || !fedRow.url_key) continue;
        if (
          !isFederatedAssetRowCompatible(fedRow.source_url, fedRow.federated_path, {
            role: fedRow.asset_role,
            ordinal: fedRow.ordinal,
          })
        ) {
          invalidFederatedAssets.push({
            urlKey: String(fedRow.url_key),
            gameId: fedRow.game_id ? String(fedRow.game_id) : '',
          });
        }
      }
    }

    /** @type {Set<string>} */
    const allDeleteGameIds = new Set([...duplicateXboxDeleteIds, ...orphanPruneIds]);
    for (const delId of allDeleteGameIds) {
      authoritativeDowngrades.delete(delId);
      osRepairs.delete(delId);
    }

    if (isDbReadOnly(service, db)) {
      return {
        skipped: false,
        version: CURRENT_SELF_HEAL_VERSION,
        downgraded: 0,
        deletedGames: 0,
        repairedOs: 0,
        resetFederated: 0,
      };
    }

    const nowTs = service.now();
    let deletedGames = 0;

    // Single coalesced BEGIN IMMEDIATE ... COMMIT transaction for ALL self-heal writes + version stamp!
    db.exec('BEGIN IMMEDIATE');
    try {
      if (authoritativeDowngrades.size > 0) {
        const downgradeStmt = getStmt(
          'selfHeal.downgradeAuth',
          "UPDATE vault_games SET metadata_quality = 'storefront_native', enriched_json = ? WHERE game_id = ?"
        );
        for (const [gid, patch] of authoritativeDowngrades.entries()) {
          downgradeStmt.run(patch.enrichedJson, gid);
        }
      }

      if (osRepairs.size > 0) {
        const updateOsStmt = getStmt(
          'selfHeal.updateOsFlags',
          'UPDATE vault_games SET platforms_json = ?, summary_json = ? WHERE game_id = ?'
        );
        for (const [gid, rep] of osRepairs.entries()) {
          updateOsStmt.run(rep.platformsJson, rep.summaryJson, gid);
        }
      }

      if (allDeleteGameIds.size > 0) {
        const delAssetsStmt = getStmt(
          'games.deleteAssetsByGameId',
          'DELETE FROM game_media_assets WHERE game_id = ?'
        );
        const delUrlCacheStmt = getStmt(
          'games.deleteUrlCacheByGameId',
          'DELETE FROM url_resolution_cache WHERE game_id = ?'
        );
        const delGameStmt = getStmt(
          'games.deleteByGameId',
          'DELETE FROM vault_games WHERE game_id = ?'
        );
        for (const gid of allDeleteGameIds) {
          delAssetsStmt.run(gid);
          delUrlCacheStmt.run(gid);
          const res = delGameStmt.run(gid);
          if (res && Number(res.changes || 0) > 0) {
            deletedGames += Number(res.changes);
          }
        }
      }

      if (invalidFederatedAssets.length > 0) {
        const resetFederatedStmt = getStmt(
          'media.resetFederatedByUrlKey',
          "UPDATE game_media_assets SET storage_kind = 'pending', federated_path = NULL WHERE url_key = ?"
        );
        const resetHydratedStmt = getStmt(
          'games.resetMediaHydratedAt',
          'UPDATE vault_games SET media_hydrated_at = 0 WHERE game_id = ?'
        );
        /** @type {Set<string>} */
        const resetHydratedGameIds = new Set();
        for (const item of invalidFederatedAssets) {
          resetFederatedStmt.run(item.urlKey);
          if (item.gameId && !allDeleteGameIds.has(item.gameId)) {
            resetHydratedGameIds.add(item.gameId);
          }
        }
        for (const gid of resetHydratedGameIds) {
          resetHydratedStmt.run(gid);
        }
      }

      getStmt(
        'meta.upsert',
        'INSERT INTO vault_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      ).run('self_heal_version', String(CURRENT_SELF_HEAL_VERSION), nowTs);

      db.exec('COMMIT');
    } catch (txErr) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw txErr;
    }

    return {
      skipped: false,
      version: CURRENT_SELF_HEAL_VERSION,
      downgraded: authoritativeDowngrades.size,
      deletedGames,
      repairedOs: osRepairs.size,
      resetFederated: invalidFederatedAssets.length,
    };
  } catch (healErr) {
    diagLog.debug('offlineVault.startupSelfHeal', healErr);
    return emptyResult;
  }
}

module.exports = {
  runStartupSelfHeal,
};
