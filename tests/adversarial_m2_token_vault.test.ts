import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const tokenVault = nodeRequire('../electron/storefronts/tokenVault.cjs');

function makeTempDir(prefix = 'adversarial-vault-'): string {
  const tmp = path.join(os.tmpdir(), `${prefix}${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return tmp;
}

describe('Milestone M2 Adversarial Challenge — Token Vault Stress & Boundary Verification', () => {

  // ==========================================================================
  // Dimension 1: Catastrophic Backup Creation & Auto-Recovery (.bak)
  // ==========================================================================
  describe('Dimension 1: Catastrophic Backup Creation & Auto-Recovery', () => {
    it('recovers from .bak when primary tokens.json is truncated to 0 bytes and restores file on disk', async () => {
      const dir = makeTempDir('adv-bak-trunc-');
      const tokensPath = path.join(dir, 'tokens.json');
      const bakPath = `${tokensPath}.bak`;
      const opts = { userDataDir: dir, machineIdOverride: 'adv-mach-01' };

      // Write 1 & Write 2 to generate .bak
      await tokenVault.saveTokensAsync('epic', { access_token: 'epic_tok_v1' }, opts);
      await tokenVault.saveTokensAsync('gog', { access_token: 'gog_tok_v2' }, opts);
      expect(fs.existsSync(bakPath)).toBe(true);
      expect(fs.statSync(bakPath).size).toBeGreaterThan(0);

      // Catastrophe: Primary file truncated to 0 bytes (power loss / crash during write)
      fs.writeFileSync(tokensPath, '');
      expect(fs.statSync(tokensPath).size).toBe(0);

      tokenVault.invalidateVaultMemoryCache(opts);

      // Async loader must recover from .bak and rewrite valid tokens.json
      const recoveredAsync = await tokenVault.loadSavedTokensAsync(opts);
      expect(recoveredAsync.epic?.access_token).toBe('epic_tok_v1');
      expect(fs.statSync(tokensPath).size).toBeGreaterThan(0);

      // Repeat truncation to 0 bytes, verify sync loader also recovers
      fs.writeFileSync(tokensPath, '');
      tokenVault.invalidateVaultMemoryCache(opts);

      const recoveredSync = tokenVault.loadSavedTokens(opts);
      expect(recoveredSync.epic?.access_token).toBe('epic_tok_v1');
      expect(fs.statSync(tokensPath).size).toBeGreaterThan(0);
    });

    it('recovers from .bak when primary tokens.json contains non-JSON garbage or corrupted encrypted envelope', async () => {
      const dir = makeTempDir('adv-bak-garbage-');
      const tokensPath = path.join(dir, 'tokens.json');
      const opts = { userDataDir: dir, machineIdOverride: 'adv-mach-02' };

      // Establish baseline with .bak
      await tokenVault.saveTokensAsync('xbox', { access_token: 'xbox_valid_tok' }, opts);
      await tokenVault.saveTokensAsync('steam', { steamId: '76561198000000001' }, opts);

      // Scenario A: Non-JSON raw garbage in primary
      fs.writeFileSync(tokensPath, '<<CORRUPTED_RAW_GARBAGE_BYTES_0xDEADBEEF>>');
      tokenVault.invalidateVaultMemoryCache(opts);

      const recoveredFromGarbage = await tokenVault.loadSavedTokensAsync(opts);
      expect(recoveredFromGarbage.xbox?.access_token).toBe('xbox_valid_tok');
      expect(fs.statSync(tokensPath).size).toBeGreaterThan(0);

      // Scenario B: Valid JSON, but malformed encrypted envelope with corrupted tag/salt
      fs.writeFileSync(
        tokensPath,
        JSON.stringify({
          _encrypted_v2: true,
          _encrypted_v3: true,
          alg: 'aes-256-gcm',
          salt: 'bad_salt',
          iv: 'bad_iv',
          tag: 'bad_tag',
          data: 'bad_data',
        })
      );
      tokenVault.invalidateVaultMemoryCache(opts);

      const recoveredFromBadEnvelope = tokenVault.loadSavedTokens(opts);
      expect(recoveredFromBadEnvelope.xbox?.access_token).toBe('xbox_valid_tok');
    });

    it('returns empty doc {} safely without throwing when both tokens.json and .bak are 0 bytes or corrupted', async () => {
      const dir = makeTempDir('adv-bak-dual-fail-');
      const tokensPath = path.join(dir, 'tokens.json');
      const bakPath = `${tokensPath}.bak`;
      const opts = { userDataDir: dir, machineIdOverride: 'adv-mach-03' };

      // Sub-case 1: Both 0 bytes
      fs.writeFileSync(tokensPath, '');
      fs.writeFileSync(bakPath, '');
      tokenVault.invalidateVaultMemoryCache(opts);

      const r1Sync = tokenVault.loadSavedTokens(opts);
      expect(r1Sync).toEqual({});
      tokenVault.invalidateVaultMemoryCache(opts);

      const r1Async = await tokenVault.loadSavedTokensAsync(opts);
      expect(r1Async).toEqual({});

      // Sub-case 2: Both corrupted garbage
      fs.writeFileSync(tokensPath, '{ invalid json primary');
      fs.writeFileSync(bakPath, '{ invalid json backup');
      tokenVault.invalidateVaultMemoryCache(opts);

      const r2Sync = tokenVault.loadSavedTokens(opts);
      expect(r2Sync).toEqual({});
      tokenVault.invalidateVaultMemoryCache(opts);

      const r2Async = await tokenVault.loadSavedTokensAsync(opts);
      expect(r2Async).toEqual({});

      // Sub-case 3: Both completely absent
      fs.unlinkSync(tokensPath);
      fs.unlinkSync(bakPath);
      tokenVault.invalidateVaultMemoryCache(opts);

      const r3Sync = tokenVault.loadSavedTokens(opts);
      expect(r3Sync).toEqual({});
      tokenVault.invalidateVaultMemoryCache(opts);

      const r3Async = await tokenVault.loadSavedTokensAsync(opts);
      expect(r3Async).toEqual({});
    });

    it('does not overwrite a valid .bak with a 0-byte or corrupted primary file on subsequent writes', async () => {
      const dir = makeTempDir('adv-bak-preserve-');
      const tokensPath = path.join(dir, 'tokens.json');
      const bakPath = `${tokensPath}.bak`;

      // Write valid version 1 & 2
      await tokenVault.writeVaultAtomic(tokensPath, 'version_1_valid_content');
      await tokenVault.writeVaultAtomic(tokensPath, 'version_2_valid_content');
      expect(fs.readFileSync(bakPath, 'utf8')).toBe('version_1_valid_content');

      // Primary becomes 0-byte
      fs.writeFileSync(tokensPath, '');

      // Writing version 3 must NOT copy the 0-byte file into .bak
      await tokenVault.writeVaultAtomic(tokensPath, 'version_3_valid_content');
      expect(fs.readFileSync(bakPath, 'utf8')).toBe('version_1_valid_content');
      expect(fs.readFileSync(tokensPath, 'utf8')).toBe('version_3_valid_content');
    });

    it('handles temporary file collisions gracefully via secure sync write fallback', async () => {
      const dir = makeTempDir('adv-tmp-collision-');
      const tokensPath = path.join(dir, 'tokens.json');

      // Pre-create clutter of .tmp files
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(dir, `tokens.json.${process.pid}.${Date.now()}.${i}.tmp`), 'stale');
      }

      // Simulate EEXIST on wx open attempt
      const origOpen = fs.promises.open;
      let simulatedCollision = false;
      fs.promises.open = (async function (this: unknown, ...args: any[]) {
        if (!simulatedCollision && typeof args[1] === 'string' && args[1].includes('x')) {
          simulatedCollision = true;
          const err: any = new Error('EEXIST: file already exists');
          err.code = 'EEXIST';
          throw err;
        }
        return origOpen.apply(this, args as any);
      }) as any;

      try {
        await tokenVault.writeVaultAtomic(tokensPath, 'collision_recovered_content');
        expect(fs.readFileSync(tokensPath, 'utf8')).toBe('collision_recovered_content');
      } finally {
        fs.promises.open = origOpen;
      }
    });
  });

  // ==========================================================================
  // Dimension 2: 5000ms Mutex Lock Timeout & Concurrency Stress
  // ==========================================================================
  describe('Dimension 2: Mutex Lock Timeout & Concurrency Stress', () => {
    it('unblocks queued tasks when an earlier task hangs and exceeds lock timeout', async () => {
      const dir = makeTempDir('adv-mutex-timeout-');
      const tokensPath = path.join(dir, 'tokens.json');

      const timeoutMs = 80;
      const hangTask = tokenVault.runWithVaultMutex(
        tokensPath,
        () => new Promise((resolve) => setTimeout(resolve, 500)),
        timeoutMs
      );

      const nextTask = tokenVault.runWithVaultMutex(
        tokensPath,
        async () => 'unblocked_task_result',
        5000
      );

      await expect(hangTask).rejects.toThrow(`Vault mutex lock timed out after ${timeoutMs}ms`);
      const res = await nextTask;
      expect(res).toBe('unblocked_task_result');
    });

    it('unblocks queued tasks immediately when a task throws synchronously or rejects asynchronously', async () => {
      const dir = makeTempDir('adv-mutex-errors-');
      const tokensPath = path.join(dir, 'tokens.json');

      // Task 1 throws synchronously
      const syncThrowTask = tokenVault.runWithVaultMutex(tokensPath, () => {
        throw new Error('Sync throw failure');
      });

      // Task 2 queued behind sync throw
      const afterSyncThrow = tokenVault.runWithVaultMutex(tokensPath, async () => 'after_sync_success');

      await expect(syncThrowTask).rejects.toThrow('Sync throw failure');
      expect(await afterSyncThrow).toBe('after_sync_success');

      // Task 3 rejects asynchronously
      const asyncRejectTask = tokenVault.runWithVaultMutex(tokensPath, async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('Async reject failure');
      });

      // Task 4 queued behind async reject
      const afterAsyncReject = tokenVault.runWithVaultMutex(tokensPath, async () => 'after_async_success');

      await expect(asyncRejectTask).rejects.toThrow('Async reject failure');
      expect(await afterAsyncReject).toBe('after_async_success');
    });

    it('maintains strict FIFO order and zero task starvation across 50 parallel mutex calls', async () => {
      const dir = makeTempDir('adv-mutex-concurrency-');
      const tokensPath = path.join(dir, 'tokens.json');

      const executionOrder: number[] = [];
      const parallelTasks = Array.from({ length: 50 }, (_, i) => {
        return tokenVault.runWithVaultMutex(tokensPath, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 3 + 1));
          executionOrder.push(i);
          return i;
        });
      });

      const results = await Promise.all(parallelTasks);
      expect(results).toHaveLength(50);
      expect(executionOrder).toEqual(Array.from({ length: 50 }, (_, i) => i));
    });

    it('persists all 50 parallel saveTokensAsync mutations across 50 storefronts without dropped updates', async () => {
      const dir = makeTempDir('adv-save-concurrency-');
      const opts = { userDataDir: dir, machineIdOverride: 'adv-mach-save-concurrency' };

      const parallelSaves = Array.from({ length: 50 }, (_, i) => {
        return tokenVault.saveTokensAsync(`storefront_${i}`, { index: i, token: `token_val_${i}` }, opts);
      });

      await Promise.all(parallelSaves);

      // Invalidate memory cache to verify persistent disk state
      tokenVault.invalidateVaultMemoryCache(opts);
      const loaded = await tokenVault.loadSavedTokensAsync(opts);

      expect(Object.keys(loaded)).toHaveLength(50);
      for (let i = 0; i < 50; i++) {
        expect(loaded[`storefront_${i}`]?.token).toBe(`token_val_${i}`);
        expect(loaded[`storefront_${i}`]?.index).toBe(i);
      }
    });

    it('enforces default 5000ms mutex timeout on stalled tasks', async () => {
      const dir = makeTempDir('adv-mutex-default-5000-');
      const tokensPath = path.join(dir, 'tokens.json');

      vi.useFakeTimers();
      try {
        const stalledTask = tokenVault.runWithVaultMutex(tokensPath, () => new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(5005);
        await expect(stalledTask).rejects.toThrow('Vault mutex lock timed out after 5000ms');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ==========================================================================
  // Dimension 3: Contract Interfaces, Boundary Conditions & CHALLENGE DEFECTS
  // ==========================================================================
  describe('Dimension 3: Contract Interfaces, Boundary Conditions & Challenge Findings', () => {
    it('validates storeToken parameters: enforces non-empty string store and handles missing accountId/tokenData', async () => {
      const dir = makeTempDir('adv-store-params-');
      const opts = { userDataDir: dir };

      // Invalid stores throw TypeError
      await expect(tokenVault.storeToken('', 'acc1', {}, opts)).rejects.toThrow(TypeError);
      await expect(tokenVault.storeToken(null as any, 'acc1', {}, opts)).rejects.toThrow(TypeError);
      await expect(tokenVault.storeToken(undefined as any, 'acc1', {}, opts)).rejects.toThrow(TypeError);
      await expect(tokenVault.storeToken(123 as any, 'acc1', {}, opts)).rejects.toThrow(TypeError);

      // Valid store with null accountId & null tokenData succeeds
      await tokenVault.storeToken('epic', null as any, null as any, opts);
      const retrieved = await tokenVault.retrieveToken('epic', null as any, opts);
      expect(retrieved).toBeTruthy();
      expect(typeof retrieved?.updatedAt).toBe('string');
    });

    it('validates retrieveToken & deleteToken parameters with edge cases', async () => {
      const dir = makeTempDir('adv-ret-del-params-');
      const opts = { userDataDir: dir };

      // Invalid store returns null / false
      expect(await tokenVault.retrieveToken('', undefined, opts)).toBeNull();
      expect(await tokenVault.retrieveToken(null as any, undefined, opts)).toBeNull();
      expect(await tokenVault.deleteToken('', undefined, opts)).toBe(false);
      expect(await tokenVault.deleteToken(null as any, undefined, opts)).toBe(false);

      // Non-existent store returns null / false
      expect(await tokenVault.retrieveToken('nonexistent', undefined, opts)).toBeNull();
      expect(await tokenVault.deleteToken('nonexistent', undefined, opts)).toBe(false);

      // Seed store with accountId
      await tokenVault.storeToken('gog', 'user_alpha', { access_token: 'gog_tok_alpha' }, opts);

      // Mismatched accountId
      expect(await tokenVault.retrieveToken('gog', 'user_beta', opts)).toBeNull();
      expect(await tokenVault.deleteToken('gog', 'user_beta', opts)).toBe(false);

      // Matching accountId
      const found = await tokenVault.retrieveToken('gog', 'user_alpha', opts);
      expect(found?.access_token).toBe('gog_tok_alpha');
      expect(found?.accountId).toBe('user_alpha');

      // Successful delete
      expect(await tokenVault.deleteToken('gog', 'user_alpha', opts)).toBe(true);
      expect(await tokenVault.retrieveToken('gog', 'user_alpha', opts)).toBeNull();
      // Second delete returns false
      expect(await tokenVault.deleteToken('gog', 'user_alpha', opts)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // RESOLUTION VERIFICATION 1: acquireVaultLock Handle Release Pattern
    // ------------------------------------------------------------------------
    it('[RESOLUTION VERIFICATION 1] acquireVaultLock returns valid release handle, supports async/sync release, and unblocks mutex', async () => {
      const dir = makeTempDir('adv-lock-handle-fixed-');
      const tokensPath = path.join(dir, 'tokens.json');

      const handle = tokenVault.acquireVaultLock(tokensPath, 3000);

      // 1. Synchronously verify handle structure
      expect(handle).toBeDefined();
      expect(typeof handle.release).toBe('function');
      expect(handle.acquired).toBeInstanceOf(Promise);
      expect(handle.lockPromise).toBeInstanceOf(Promise);

      // 2. Await lock acquisition
      await handle.acquired;
      expect(handle.isAcquired).toBe(true);
      expect(handle.isReleased).toBe(false);

      // 3. Queue a second task on the same path
      let task2Started = false;
      const task2Promise = tokenVault.acquireVaultLock(tokensPath, async () => {
        task2Started = true;
        return 'task2_completed';
      });

      // Verify task2 is blocked while handle holds lock
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(task2Started).toBe(false);

      // 4. Release handle and verify immediate settlement
      const releaseStart = Date.now();
      handle.release();
      expect(handle.isReleased).toBe(true);
      await handle.lockPromise;
      const releaseDuration = Date.now() - releaseStart;

      // Must release immediately, far below the 3000ms timeout
      expect(releaseDuration).toBeLessThan(500);

      // 5. Queued task must execute immediately to completion
      const task2Result = await task2Promise;
      expect(task2Started).toBe(true);
      expect(task2Result).toBe('task2_completed');

      // 6. Verify synchronous release pattern (release called before microtask dispatch)
      const syncHandle = tokenVault.acquireVaultLock(tokensPath, 2000);
      syncHandle.release();
      expect(syncHandle.isReleased).toBe(true);
      await expect(syncHandle.lockPromise).resolves.toBeUndefined();

      // 7. Verify Symbol.asyncDispose
      const disposeHandle = tokenVault.acquireVaultLock(tokensPath, 2000);
      await disposeHandle[Symbol.asyncDispose]();
      expect(disposeHandle.isReleased).toBe(true);
    });

    // ------------------------------------------------------------------------
    // RESOLUTION VERIFICATION 2: Account Attribution Strict Isolation
    // ------------------------------------------------------------------------
    it('[RESOLUTION VERIFICATION 2] retrieveToken and deleteToken strictly isolate unattributed tokens and enforce account attribution', async () => {
      const dir = makeTempDir('adv-unattributed-isolation-');
      const opts = { userDataDir: dir };

      // 1. Store an unattributed token (e.g. legacy migration or storeToken without accountId)
      await tokenVault.storeToken('epic', undefined, { access_token: 'no_id' }, opts);

      // 2. Querying with specific accountId 'userA' must return null
      const userARetrieve = await tokenVault.retrieveToken('epic', 'userA', opts);
      expect(userARetrieve).toBeNull();

      // 3. Deleting with specific accountId 'userA' must return false and NOT delete the token
      const userADelete = await tokenVault.deleteToken('epic', 'userA', opts);
      expect(userADelete).toBe(false);

      // 4. Querying without accountId returns the unattributed token
      const unattributedRetrieve = await tokenVault.retrieveToken('epic', undefined, opts);
      expect(unattributedRetrieve?.access_token).toBe('no_id');

      // 5. Deleting without accountId deletes the token and returns true
      const unattributedDelete = await tokenVault.deleteToken('epic', undefined, opts);
      expect(unattributedDelete).toBe(true);

      // Verify token is gone
      expect(await tokenVault.retrieveToken('epic', undefined, opts)).toBeNull();

      // 6. Store an attributed token for 'userA'
      await tokenVault.storeToken('epic', 'userA', { access_token: 'for_a' }, opts);

      // 7. Querying with 'userB' returns null
      expect(await tokenVault.retrieveToken('epic', 'userB', opts)).toBeNull();

      // 8. Deleting with 'userB' returns false and preserves token
      expect(await tokenVault.deleteToken('epic', 'userB', opts)).toBe(false);

      // 9. Querying with 'userA' returns the token
      const retrievedA = await tokenVault.retrieveToken('epic', 'userA', opts);
      expect(retrievedA?.access_token).toBe('for_a');
      expect(retrievedA?.accountId).toBe('userA');

      // 10. Deleting with 'userA' returns true and deletes token
      expect(await tokenVault.deleteToken('epic', 'userA', opts)).toBe(true);
      expect(await tokenVault.retrieveToken('epic', 'userA', opts)).toBeNull();

      // 11. Ergonomic options shifting without accountId (store, options)
      await tokenVault.storeToken('gog', undefined, { access_token: 'gog_tok' }, opts);
      const shiftedRetrieve = await tokenVault.retrieveToken('gog', opts as any);
      expect(shiftedRetrieve?.access_token).toBe('gog_tok');
      const shiftedDelete = await tokenVault.deleteToken('gog', opts as any);
      expect(shiftedDelete).toBe(true);
      expect(await tokenVault.retrieveToken('gog', opts as any)).toBeNull();
    });

    it('verifies writeVaultAtomic behavior with nested directories and overwrites', async () => {
      const baseDir = makeTempDir('adv-write-atomic-');
      const nestedPath = path.join(baseDir, 'nested', 'sub', 'test.txt');

      // Creates nested directory structure automatically
      await tokenVault.writeVaultAtomic(nestedPath, 'nested_content_1');
      expect(fs.readFileSync(nestedPath, 'utf8')).toBe('nested_content_1');

      // Overwrite creates .bak
      await tokenVault.writeVaultAtomic(nestedPath, 'nested_content_2');
      expect(fs.readFileSync(nestedPath, 'utf8')).toBe('nested_content_2');
      expect(fs.readFileSync(`${nestedPath}.bak`, 'utf8')).toBe('nested_content_1');
    });
  });

  // ==========================================================================
  // Dimension 4: Selective Cache Invalidation with { userDataDir }
  // ==========================================================================
  describe('Dimension 4: Selective Cache Invalidation & Key Scrubbing', () => {
    it('selectively invalidates vault A without evicting or corrupting vault B in memory', async () => {
      const dirA = makeTempDir('adv-vault-a-');
      const dirB = makeTempDir('adv-vault-b-');
      const optsA = { userDataDir: dirA, machineIdOverride: 'adv-mach-selective' };
      const optsB = { userDataDir: dirB, machineIdOverride: 'adv-mach-selective' };

      // Populate both vaults (write twice to Vault A to establish .bak)
      await tokenVault.saveTokensAsync('epic', { access_token: 'vault_a_epic' }, optsA);
      await tokenVault.saveTokensAsync('epic2', { access_token: 'vault_a_epic2' }, optsA);
      await tokenVault.saveTokensAsync('gog', { access_token: 'vault_b_gog' }, optsB);

      // Warm memory caches
      const memA1 = tokenVault.loadSavedTokens(optsA);
      const memB1 = tokenVault.loadSavedTokens(optsB);
      expect(memA1.epic?.access_token).toBe('vault_a_epic');
      expect(memA1.epic2?.access_token).toBe('vault_a_epic2');
      expect(memB1.gog?.access_token).toBe('vault_b_gog');

      // Invalidate Vault A only
      tokenVault.invalidateVaultMemoryCache(optsA);

      // Modify Vault A on disk externally behind cache's back
      // Since Vault A was invalidated, next read of A MUST reload from disk
      fs.writeFileSync(path.join(dirA, 'tokens.json'), ''); // truncate A
      const memA2 = tokenVault.loadSavedTokens(optsA);
      // Recovers from .bak (which holds vault_a_epic from first write)
      expect(memA2.epic?.access_token).toBe('vault_a_epic');

      // Vault B MUST still be served from in-memory cache without reloading
      const memB2 = tokenVault.loadSavedTokens(optsB);
      expect(memB2.gog?.access_token).toBe('vault_b_gog');

      // Mutating Vault A does not affect Vault B
      await tokenVault.saveTokensAsync('epic', { access_token: 'vault_a_mutated' }, optsA);
      const memB3 = tokenVault.loadSavedTokens(optsB);
      expect(memB3.gog?.access_token).toBe('vault_b_gog');

      // Global invalidation clears all
      tokenVault.invalidateVaultMemoryCache();
      const memB4 = await tokenVault.loadSavedTokensAsync(optsB);
      expect(memB4.gog?.access_token).toBe('vault_b_gog');
    });
  });
});
