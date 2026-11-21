// @ts-check
'use strict';

const path = require('node:path');

/**
 * Main-window & lifecycle hooks, session/download event emitters, and crash-resilient
 * `0o600` owner-only pending completed-session queue (`one_launcher_pending_sessions.json`).
 */

/**
 * @typedef {Object} LifecycleHooksAndEventsDeps
 * @property {typeof import('node:fs')} fs
 * @property {(customDir?: string) => string} getUserDataDir
 * @property {(filePath: string, content: string | Buffer, options?: Record<string, any>) => void} atomicWriteSecureFileSync
 * @property {(filePath: string, fallbackValue?: any, options?: { recoverMissingFromBackup?: boolean }) => any} readJsonFileWithBackupSync
 * @property {Set<Function>} sessionListeners
 * @property {Set<Function>} downloadListeners
 */

/**
 * @param {LifecycleHooksAndEventsDeps} deps
 */
function createLifecycleHooksAndEvents(deps) {
  const {
    fs,
    getUserDataDir,
    atomicWriteSecureFileSync,
    readJsonFileWithBackupSync,
    sessionListeners,
    downloadListeners,
  } = deps;

  /** @type {() => any} */
  let mainWindowGetter = () => null;
  /** @type {Function | null} */
  let sessionLifecycleHook = null;
  /** @type {Function | null} */
  let epicAuthRecoveryHook = null;
  /** @type {Function | null} */
  let xboxStoreLicenseRecoveryHook = null;
  /** @type {{ trimMemory: Function | null, shutdown: Function | null }} */
  let offlineVaultLifecycleHooks = { trimMemory: null, shutdown: null };

  /**
   * Configure launcher engine with Electron mainWindow getter.
   * @param {() => any} fn
   */
  function setMainWindowGetter(fn) {
    if (typeof fn === 'function') {
      mainWindowGetter = fn;
    }
  }

  function getMainWindow() {
    try {
      return mainWindowGetter ? mainWindowGetter() : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {Function | null} fn
   */
  function setSessionLifecycleHook(fn) {
    sessionLifecycleHook = typeof fn === 'function' ? fn : null;
  }

  function getSessionLifecycleHook() {
    return sessionLifecycleHook;
  }

  /**
   * @param {Function | null} fn
   */
  function setEpicAuthRecoveryHook(fn) {
    epicAuthRecoveryHook = typeof fn === 'function' ? fn : null;
  }

  function getEpicAuthRecoveryHook() {
    return epicAuthRecoveryHook;
  }

  /**
   * @param {Function | null} fn
   */
  function setXboxStoreLicenseRecoveryHook(fn) {
    xboxStoreLicenseRecoveryHook = typeof fn === 'function' ? fn : null;
  }

  function getXboxStoreLicenseRecoveryHook() {
    return xboxStoreLicenseRecoveryHook;
  }

  /**
   * @param {any} [hooks]
   */
  function setOfflineVaultLifecycleHooks(hooks = {}) {
    offlineVaultLifecycleHooks = {
      trimMemory: typeof hooks?.trimMemory === 'function' ? hooks.trimMemory : null,
      shutdown: typeof hooks?.shutdown === 'function' ? hooks.shutdown : null,
    };
  }

  function getOfflineVaultLifecycleHooks() {
    return offlineVaultLifecycleHooks;
  }

  /**
   * @param {Function} listener
   */
  function onSessionUpdated(listener) {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
  }

  /**
   * @param {Function} listener
   */
  function onDownloadUpdated(listener) {
    downloadListeners.add(listener);
    return () => downloadListeners.delete(listener);
  }

  /**
   * @param {any} [options]
   * @returns {string}
   */
  function getPendingSessionsFilePath(options = {}) {
    const customDir =
      options && typeof options === 'object'
        ? options.userDataDir || options.baseDir
        : typeof options === 'string'
          ? options
          : undefined;
    return path.join(getUserDataDir(customDir), 'one_launcher_pending_sessions.json');
  }

  /**
   * Read pending sessions with `.bak` crash recovery if primary is corrupt or missing.
   * @param {string} filePath
   * @returns {{ queue: any[], fileOrBackupExists: boolean }}
   */
  function readPendingSessionsSync(filePath) {
    let primaryExists = false;
    let backupExists = false;
    try {
      primaryExists = fs.existsSync(filePath);
    } catch {}
    try {
      backupExists = fs.existsSync(`${filePath}.bak`);
    } catch {}
    if (!primaryExists && !backupExists) {
      return { queue: [], fileOrBackupExists: false };
    }
    try {
      const parsed = readJsonFileWithBackupSync(filePath, [], {
        recoverMissingFromBackup: true,
      });
      return {
        queue: Array.isArray(parsed) ? parsed : [],
        fileOrBackupExists: true,
      };
    } catch {
      return { queue: [], fileOrBackupExists: primaryExists || backupExists };
    }
  }

  /**
   * Persist completed game session records with `0o600` owner-only atomic writes and `.bak` recovery.
   *
   * @param {any} eventPayload
   * @param {any} [options]
   * @returns {any[]}
   */
  function queuePendingCompletedSession(eventPayload, options = {}) {
    if (!eventPayload || typeof eventPayload !== 'object') return [];
    const filePath = getPendingSessionsFilePath(options);
    let { queue } = readPendingSessionsSync(filePath);

    const sessionObj = eventPayload.session || eventPayload;
    const gameId = String(sessionObj.gameId || eventPayload.gameId || '').trim();
    const sessionId = String(sessionObj.sessionId || eventPayload.sessionId || '').trim();
    if (!gameId) return queue;

    const entryRecord = {
      sessionId: sessionId || `session-${Date.now()}`,
      gameId,
      title: String(sessionObj.title || eventPayload.title || gameId),
      platformId: sessionObj.platformId || eventPayload.platformId || 'custom',
      platformGameId: String(sessionObj.platformGameId || eventPayload.platformGameId || gameId),
      sessionMinutesPlayed: Number(eventPayload.sessionMinutesPlayed ?? 0),
      durationSeconds: Number(eventPayload.durationSeconds ?? 0),
      lastPlayed: eventPayload.lastPlayed || new Date().toISOString(),
      ...(typeof eventPayload.storefrontTotalPlaytimeMinutes === 'number' &&
      eventPayload.storefrontTotalPlaytimeMinutes > 0
        ? { storefrontTotalPlaytimeMinutes: eventPayload.storefrontTotalPlaytimeMinutes }
        : {}),
      ...(eventPayload.error ? { error: String(eventPayload.error) } : {}),
    };

    const existingIdx = queue.findIndex(
      (item) =>
        item &&
        typeof item === 'object' &&
        ((sessionId && item.sessionId === sessionId) ||
          (!sessionId && item.gameId === gameId && item.lastPlayed === entryRecord.lastPlayed))
    );

    if (existingIdx >= 0) {
      queue[existingIdx] = {
        ...queue[existingIdx],
        ...entryRecord,
        sessionMinutesPlayed:
          entryRecord.sessionMinutesPlayed > 0
            ? entryRecord.sessionMinutesPlayed
            : queue[existingIdx].sessionMinutesPlayed,
      };
    } else {
      queue.push(entryRecord);
      if (queue.length > 100) {
        queue = queue.slice(-100);
      }
    }

    try {
      atomicWriteSecureFileSync(filePath, JSON.stringify(queue, null, 2));
    } catch {}

    return queue;
  }

  /**
   * Atomically drain and clear persisted pending completed sessions (`0o600` atomic write).
   *
   * @param {any} [options]
   * @returns {any[]}
   */
  function drainPendingCompletedSessions(options = {}) {
    const filePath = getPendingSessionsFilePath(options);
    const { queue, fileOrBackupExists } = readPendingSessionsSync(filePath);
    if (fileOrBackupExists) {
      try {
        atomicWriteSecureFileSync(filePath, JSON.stringify([], null, 2));
      } catch {}
    }
    return queue;
  }

  /**
   * @param {any} payload
   * @param {any} [options]
   */
  function emitSessionUpdated(payload, options = {}) {
    for (const listener of sessionListeners) {
      try {
        listener(payload);
      } catch {}
    }

    if (typeof options?.onSessionUpdated === 'function') {
      try {
        options.onSessionUpdated(payload);
      } catch {}
    }

    if (typeof sessionLifecycleHook === 'function' && payload) {
      try {
        const sess = payload.session || payload;
        const lifecycleStatus =
          payload.event === 'stopped'
            ? 'stopped'
            : payload.event === 'started'
              ? 'running'
              : payload.event === 'stopping'
                ? 'stopping'
                : sess.status;
        sessionLifecycleHook(sess.gameId, {
          ...sess,
          ...payload,
          status: lifecycleStatus,
        });
      } catch {}
    }

    let sentToRenderer = false;
    try {
      const win = getMainWindow();
      if (
        win &&
        typeof win.isDestroyed === 'function' &&
        !win.isDestroyed() &&
        win.webContents &&
        (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed())
      ) {
        const isRendererLoading = Boolean(
          win.webContents.isLoadingMainFrame?.() || win.webContents.isLoading?.()
        );
        if (!isRendererLoading) {
          win.webContents.send('launcher:session-updated', payload);
          sentToRenderer = true;
        }
      }
    } catch {}

    if (
      (!sentToRenderer || options?.forceQueuePendingSession === true) &&
      payload &&
      (payload.event === 'stopped' ||
        payload.event === 'playtime_synced' ||
        payload.status === 'stopped' ||
        payload.session?.status === 'stopped')
    ) {
      try {
        queuePendingCompletedSession(payload, options);
      } catch {}
    }
  }

  /**
   * @param {any} payload
   */
  function emitDownloadUpdated(payload) {
    for (const listener of downloadListeners) {
      try {
        listener(payload);
      } catch {}
    }
    try {
      const win = getMainWindow();
      if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed() && win.webContents) {
        win.webContents.send('launcher:download-updated', payload);
      }
    } catch {}
  }

  return {
    setMainWindowGetter,
    getMainWindow,
    setSessionLifecycleHook,
    getSessionLifecycleHook,
    setEpicAuthRecoveryHook,
    getEpicAuthRecoveryHook,
    setXboxStoreLicenseRecoveryHook,
    getXboxStoreLicenseRecoveryHook,
    setOfflineVaultLifecycleHooks,
    getOfflineVaultLifecycleHooks,
    onSessionUpdated,
    onDownloadUpdated,
    getPendingSessionsFilePath,
    queuePendingCompletedSession,
    drainPendingCompletedSessions,
    emitSessionUpdated,
    emitDownloadUpdated,
  };
}

module.exports = {
  createLifecycleHooksAndEvents,
};
