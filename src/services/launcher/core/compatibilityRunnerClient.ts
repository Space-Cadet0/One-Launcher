import type { HostPlatformCapabilities } from '../../../contracts/hostPlatform';
import type {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CompatibilityRunnerProgressEvent,
  InstallCompatibilityLayerRequest,
  InstallCompatibilityLayerResult,
  UpdateCompatibilityLayerPayload,
  UpdateCompatibilityLayerResult,
} from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import { COMPATIBILITY_RUNNER_DESCRIPTORS } from '../launchPolicyPreview';
import { getLauncherErrorMessage } from './launcherEventHelpers';

export interface CompatibilityRunnerClientContext {
  getHostCapabilities: () => HostPlatformCapabilities;
  detectCompatibilityLayers: () => Promise<CompatibilityLayerInfo[]>;
  checkCompatibilityLayerUpdates: () => Promise<Record<string, CompatibilityLayerUpdateInfo>>;
  notifyStateChanged: () => void;
}

export class CompatibilityRunnerClient {
  private compatibilityLayers: CompatibilityLayerInfo[] = [];
  private installedStorefrontClients: Partial<Record<StorefrontId, boolean>> = {};
  private runnerUpdates: Record<string, CompatibilityLayerUpdateInfo> = {};
  private unsubscribeRunnerProgress?: () => void;
  private boundRunnerProgressApi?: unknown;
  private activeRunnerOperations: Map<
    Exclude<CompatibilityLayerType, 'native'>,
    CompatibilityRunnerProgressEvent
  > = new Map();
  private runnerProgressListeners: Set<(event: CompatibilityRunnerProgressEvent) => void> =
    new Set();
  private postRunnerMutationSyncHooks: Set<() => Promise<void>> = new Set();

  public getCompatibilityLayers(): CompatibilityLayerInfo[] {
    return this.compatibilityLayers;
  }

  public setCompatibilityLayers(layers: CompatibilityLayerInfo[]): void {
    this.compatibilityLayers = layers;
  }

  public getInstalledStorefrontClients(): Partial<Record<StorefrontId, boolean>> {
    return { ...this.installedStorefrontClients };
  }

  public getRawInstalledStorefrontClients(): Partial<Record<StorefrontId, boolean>> {
    return this.installedStorefrontClients;
  }

  public setInstalledStorefrontClients(clients: Partial<Record<StorefrontId, boolean>>): void {
    this.installedStorefrontClients = clients;
  }

  public getRunnerUpdates(): Record<string, CompatibilityLayerUpdateInfo> {
    return this.runnerUpdates;
  }

  public setRunnerUpdates(updates: Record<string, CompatibilityLayerUpdateInfo>): void {
    this.runnerUpdates = updates;
  }

  public applyDetectedStorefrontClients(detectedClients: unknown): void {
    if (!detectedClients || typeof detectedClients !== 'object') return;
    const nextClients: Partial<Record<StorefrontId, boolean>> = {};
    const clientsMap = detectedClients as Record<string, unknown>;
    for (const key of ['steam', 'gog', 'epic', 'xbox'] as const) {
      if (typeof clientsMap[key] === 'boolean') {
        nextClients[key] = clientsMap[key] as boolean;
      }
    }
    this.installedStorefrontClients = nextClients;
  }

  public async detectCompatibilityLayers(
    ctx: CompatibilityRunnerClientContext
  ): Promise<CompatibilityLayerInfo[]> {
    if (!ctx.getHostCapabilities().supportsWindowsTranslation) {
      if (this.compatibilityLayers.length > 0) {
        this.compatibilityLayers = [];
        ctx.notifyStateChanged();
      }
      return [];
    }
    if (typeof window !== 'undefined' && window.electronAPI?.detectCompatibilityLayers) {
      try {
        const layers = await window.electronAPI.detectCompatibilityLayers();
        if (Array.isArray(layers)) {
          const prevSerialized = JSON.stringify(this.compatibilityLayers);
          const nextSerialized = JSON.stringify(layers);
          this.compatibilityLayers = layers;
          if (prevSerialized !== nextSerialized) {
            ctx.notifyStateChanged();
          }
          return layers;
        }
      } catch (err) {
        console.warn('[LauncherService] detectCompatibilityLayers failed:', err);
      }
    }
    return this.compatibilityLayers;
  }

  public async detectInstalledStorefrontClients(
    ctx: CompatibilityRunnerClientContext
  ): Promise<Partial<Record<StorefrontId, boolean>>> {
    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.detectInstalledStorefrontClients === 'function'
    ) {
      try {
        const detected = await window.electronAPI.detectInstalledStorefrontClients();
        if (detected && typeof detected === 'object') {
          const next: Partial<Record<StorefrontId, boolean>> = {};
          for (const key of ['steam', 'gog', 'epic', 'xbox'] as const) {
            if (typeof detected[key] === 'boolean') {
              next[key] = detected[key];
            }
          }
          const prevSerialized = JSON.stringify(this.installedStorefrontClients);
          const nextSerialized = JSON.stringify(next);
          this.installedStorefrontClients = next;
          if (prevSerialized !== nextSerialized) {
            ctx.notifyStateChanged();
          }
          return { ...this.installedStorefrontClients };
        }
      } catch (err) {
        console.warn('[LauncherService] detectInstalledStorefrontClients failed:', err);
      }
    }
    return { ...this.installedStorefrontClients };
  }

  public teardownRunnerProgressSubscription(): void {
    if (this.unsubscribeRunnerProgress) {
      try {
        this.unsubscribeRunnerProgress();
      } catch {}
      this.unsubscribeRunnerProgress = undefined;
    }
    this.boundRunnerProgressApi = undefined;
  }

  public ensureRunnerProgressSubscription(ctx: CompatibilityRunnerClientContext): void {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (this.boundRunnerProgressApi === api) {
      if (!api || this.unsubscribeRunnerProgress) {
        return;
      }
    }
    this.teardownRunnerProgressSubscription();
    if (!api) return;
    this.boundRunnerProgressApi = api;
    if (typeof api.onCompatibilityRunnerProgress === 'function') {
      this.unsubscribeRunnerProgress = api.onCompatibilityRunnerProgress(
        (event: CompatibilityRunnerProgressEvent) => {
          this.handleRunnerProgressEvent(event, ctx);
        }
      );
    }
  }

  private handleRunnerProgressEvent(
    event: CompatibilityRunnerProgressEvent,
    ctx: CompatibilityRunnerClientContext
  ): void {
    if (!event || !event.runnerType) return;
    const runnerType = event.runnerType;
    const isTerminal =
      event.phase === 'completed' || event.phase === 'failed' || event.phase === 'cancelled';

    let nextEvent: CompatibilityRunnerProgressEvent = event;
    if (!isTerminal) {
      const prev = this.activeRunnerOperations.get(runnerType);
      if (
        prev &&
        prev.operation === event.operation &&
        prev.phase === 'downloading' &&
        event.phase === 'downloading'
      ) {
        const progressPercent =
          typeof event.progressPercent === 'number'
            ? typeof prev.progressPercent === 'number'
              ? Math.max(prev.progressPercent, Math.min(100, event.progressPercent))
              : Math.min(100, Math.max(0, event.progressPercent))
            : prev.progressPercent;
        const bytesDownloaded =
          typeof event.bytesDownloaded === 'number' && typeof prev.bytesDownloaded === 'number'
            ? Math.max(prev.bytesDownloaded, event.bytesDownloaded)
            : event.bytesDownloaded ?? prev.bytesDownloaded;
        const totalBytes = event.totalBytes ?? prev.totalBytes;
        nextEvent = {
          ...event,
          progressPercent,
          ...(bytesDownloaded !== undefined ? { bytesDownloaded } : {}),
          ...(totalBytes !== undefined ? { totalBytes } : {}),
        };
      }
      this.activeRunnerOperations.set(runnerType, nextEvent);
    } else {
      this.activeRunnerOperations.delete(runnerType);
    }

    for (const listener of this.runnerProgressListeners) {
      try {
        listener(nextEvent);
      } catch {}
    }
    ctx.notifyStateChanged();
  }

  public getActiveRunnerOperations(
    ctx: CompatibilityRunnerClientContext
  ): Partial<Record<Exclude<CompatibilityLayerType, 'native'>, CompatibilityRunnerProgressEvent>> {
    this.ensureRunnerProgressSubscription(ctx);
    const snapshot: Partial<
      Record<Exclude<CompatibilityLayerType, 'native'>, CompatibilityRunnerProgressEvent>
    > = {};
    for (const [runnerType, ev] of this.activeRunnerOperations.entries()) {
      snapshot[runnerType] = ev;
    }
    return snapshot;
  }

  public getActiveRunnerOperation(
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    ctx: CompatibilityRunnerClientContext
  ): CompatibilityRunnerProgressEvent | undefined {
    this.ensureRunnerProgressSubscription(ctx);
    return this.activeRunnerOperations.get(runnerType);
  }

  public onRunnerProgress(
    listener: (event: CompatibilityRunnerProgressEvent) => void,
    ctx: CompatibilityRunnerClientContext
  ): () => void {
    this.ensureRunnerProgressSubscription(ctx);
    this.runnerProgressListeners.add(listener);
    return () => {
      this.runnerProgressListeners.delete(listener);
    };
  }

  public registerPostRunnerMutationSyncHook(hook: () => Promise<void>): () => void {
    this.postRunnerMutationSyncHooks.add(hook);
    return () => {
      this.postRunnerMutationSyncHooks.delete(hook);
    };
  }

  private async runPostRunnerMutationSyncHooks(): Promise<void> {
    if (this.postRunnerMutationSyncHooks.size === 0) return;
    await Promise.allSettled(
      Array.from(this.postRunnerMutationSyncHooks).map((hook) =>
        Promise.resolve().then(() => hook())
      )
    );
  }

  private emitTerminalProgressIfActive(
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    operation: 'install' | 'update',
    outcome: {
      success: boolean;
      cancelled?: boolean;
      message?: string;
      error?: string;
    },
    ctx: CompatibilityRunnerClientContext
  ): void {
    if (!this.activeRunnerOperations.has(runnerType)) {
      return;
    }
    const phase = outcome.cancelled
      ? 'cancelled'
      : outcome.success
        ? 'completed'
        : 'failed';
    this.handleRunnerProgressEvent(
      {
        runnerType,
        operation,
        phase,
        progressPercent: phase === 'completed' ? 100 : null,
        message:
          outcome.message ||
          outcome.error ||
          (phase === 'completed'
            ? 'Operation completed.'
            : phase === 'cancelled'
              ? 'Operation cancelled.'
              : 'Operation failed.'),
        ...(phase === 'failed' && outcome.error ? { error: outcome.error } : {}),
        updatedAt: new Date().toISOString(),
      },
      ctx
    );
  }

  public async cancelCompatibilityLayerOperation(
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    ctx: CompatibilityRunnerClientContext
  ): Promise<{ success: boolean; cancelled: boolean }> {
    this.ensureRunnerProgressSubscription(ctx);
    const existing = this.activeRunnerOperations.get(runnerType);
    let res = { success: true, cancelled: Boolean(existing) };
    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.cancelCompatibilityLayerOperation === 'function'
    ) {
      try {
        res = await window.electronAPI.cancelCompatibilityLayerOperation(runnerType);
      } catch (err) {
        console.warn('[LauncherService] cancelCompatibilityLayerOperation failed:', err);
      }
    }
    if (this.activeRunnerOperations.has(runnerType)) {
      this.handleRunnerProgressEvent(
        {
          runnerType,
          operation: existing?.operation || 'install',
          phase: 'cancelled',
          progressPercent: null,
          message: 'Operation cancelled.',
          updatedAt: new Date().toISOString(),
        },
        ctx
      );
    }
    return res;
  }

  public async installCompatibilityLayer(
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    mode: 'auto' | 'direct' | 'download',
    options: { dmgPath?: string; archivePath?: string; authenticateOnly?: boolean } | undefined,
    ctx: CompatibilityRunnerClientContext
  ): Promise<InstallCompatibilityLayerResult> {
    this.ensureRunnerProgressSubscription(ctx);
    const descriptor = COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === runnerType);
    if (
      mode === 'download' ||
      typeof window === 'undefined' ||
      !window.electronAPI?.installCompatibilityLayer
    ) {
      if (descriptor?.downloadUrl && typeof window !== 'undefined') {
        if (window.electronAPI?.openExternal) {
          await window.electronAPI.openExternal(descriptor.downloadUrl);
        } else if (typeof window.open === 'function') {
          window.open(descriptor.downloadUrl, '_blank', 'noopener,noreferrer');
        }
      }
      return {
        success: true,
        openedExternalInstaller: true,
        runnerType,
        message: 'Opened official installer download page.',
      };
    }

    const requestPayload: InstallCompatibilityLayerRequest = {
      runnerType,
      mode,
      ...(options?.dmgPath ? { dmgPath: options.dmgPath } : {}),
      ...(options?.archivePath ? { archivePath: options.archivePath } : {}),
      ...(options?.authenticateOnly !== undefined
        ? { authenticateOnly: options.authenticateOnly }
        : {}),
    };

    if (!this.activeRunnerOperations.has(runnerType)) {
      this.handleRunnerProgressEvent(
        {
          runnerType,
          operation: 'install',
          phase: options?.archivePath || options?.dmgPath ? 'extracting' : 'probing',
          progressPercent: null,
          message:
            options?.archivePath || options?.dmgPath
              ? `Installing ${descriptor?.shortLabel || runnerType} from local archive...`
              : `Preparing ${descriptor?.shortLabel || runnerType} download...`,
          updatedAt: new Date().toISOString(),
        },
        ctx
      );
    }

    let result: InstallCompatibilityLayerResult;
    try {
      const res = await window.electronAPI.installCompatibilityLayer(requestPayload);
      this.compatibilityLayers = res.layers || (await ctx.detectCompatibilityLayers());
      await ctx.checkCompatibilityLayerUpdates();
      this.emitTerminalProgressIfActive(
        runnerType,
        'install',
        {
          success: res.success,
          cancelled: res.cancelled,
          message: res.message,
          error: res.error,
        },
        ctx
      );
      await this.runPostRunnerMutationSyncHooks();
      result = res;
    } catch (err: unknown) {
      const errMsg = getLauncherErrorMessage(err, 'Failed to install compatibility layer.');
      this.emitTerminalProgressIfActive(
        runnerType,
        'install',
        {
          success: false,
          message: errMsg,
          error: errMsg,
        },
        ctx
      );
      await this.runPostRunnerMutationSyncHooks();
      result = {
        success: false,
        runnerType,
        error: errMsg,
      };
    } finally {
      this.activeRunnerOperations.delete(runnerType);
      ctx.notifyStateChanged();
    }
    return result;
  }

  public async checkCompatibilityLayerUpdates(
    ctx: CompatibilityRunnerClientContext
  ): Promise<Record<string, CompatibilityLayerUpdateInfo>> {
    if (!ctx.getHostCapabilities().supportsWindowsTranslation) {
      if (Object.keys(this.runnerUpdates).length > 0) {
        this.runnerUpdates = {};
        ctx.notifyStateChanged();
      }
      return {};
    }
    if (
      typeof window !== 'undefined' &&
      window.electronAPI?.checkCompatibilityLayerUpdates
    ) {
      try {
        const res = await window.electronAPI.checkCompatibilityLayerUpdates();
        if (res && typeof res === 'object') {
          const prevSerialized = JSON.stringify(this.runnerUpdates);
          const nextSerialized = JSON.stringify(res);
          this.runnerUpdates = res;
          if (prevSerialized !== nextSerialized) {
            ctx.notifyStateChanged();
          }
        }
      } catch (err) {
        console.warn('[LauncherService] checkCompatibilityLayerUpdates failed:', err);
      }
    }
    return this.runnerUpdates;
  }

  public async updateCompatibilityLayer(
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    options:
      | {
          dmgPath?: string;
          archivePath?: string;
          switchToStableCrossOver?: boolean;
          authenticateOnly?: boolean;
        }
      | undefined,
    ctx: CompatibilityRunnerClientContext
  ): Promise<UpdateCompatibilityLayerResult> {
    this.ensureRunnerProgressSubscription(ctx);
    const descriptor = COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === runnerType);
    if (
      typeof window === 'undefined' ||
      !window.electronAPI?.updateCompatibilityLayer
    ) {
      if (descriptor?.downloadUrl && typeof window !== 'undefined') {
        if (window.electronAPI?.openExternal) {
          await window.electronAPI.openExternal(descriptor.downloadUrl);
        } else if (typeof window.open === 'function') {
          window.open(descriptor.downloadUrl, '_blank', 'noopener,noreferrer');
        }
      }
      return {
        success: true,
        runnerType,
        updated: false,
        openedExternalUrl: descriptor?.downloadUrl,
        message: 'Opened official runner update portal.',
      };
    }

    const payload: UpdateCompatibilityLayerPayload = {
      runnerType,
      ...(options?.dmgPath ? { dmgPath: options.dmgPath } : {}),
      ...(options?.archivePath ? { archivePath: options.archivePath } : {}),
      ...(options?.switchToStableCrossOver ? { switchToStableCrossOver: true } : {}),
      ...(options?.authenticateOnly !== undefined
        ? { authenticateOnly: options.authenticateOnly }
        : {}),
    };

    if (!this.activeRunnerOperations.has(runnerType)) {
      this.handleRunnerProgressEvent(
        {
          runnerType,
          operation: 'update',
          phase: options?.archivePath || options?.dmgPath ? 'extracting' : 'probing',
          progressPercent: null,
          message: options?.switchToStableCrossOver
            ? 'Downloading newer CrossOver Stable release...'
            : options?.archivePath || options?.dmgPath
              ? `Updating ${descriptor?.shortLabel || runnerType} from local archive...`
              : `Preparing ${descriptor?.shortLabel || runnerType} update...`,
          updatedAt: new Date().toISOString(),
        },
        ctx
      );
    }

    let result: UpdateCompatibilityLayerResult;
    try {
      const res = await window.electronAPI.updateCompatibilityLayer(payload);
      if (Array.isArray(res.detectedLayers)) {
        this.compatibilityLayers = res.detectedLayers;
      } else {
        await ctx.detectCompatibilityLayers();
      }
      if (res.updateInfo) {
        const resultRunnerKey = res.updateInfo.runnerType || res.runnerType || runnerType;
        this.runnerUpdates = {
          ...this.runnerUpdates,
          [resultRunnerKey]: res.updateInfo,
        };
      } else {
        await ctx.checkCompatibilityLayerUpdates();
      }
      this.emitTerminalProgressIfActive(
        runnerType,
        'update',
        {
          success: res.success,
          cancelled: res.cancelled,
          message: res.message,
          error: res.error,
        },
        ctx
      );
      await this.runPostRunnerMutationSyncHooks();
      result = res;
    } catch (err: unknown) {
      const errMsg = getLauncherErrorMessage(err, 'Failed to update compatibility layer.');
      this.emitTerminalProgressIfActive(
        runnerType,
        'update',
        {
          success: false,
          message: errMsg,
          error: errMsg,
        },
        ctx
      );
      await this.runPostRunnerMutationSyncHooks();
      result = {
        success: false,
        runnerType,
        updated: false,
        message: errMsg,
        error: errMsg,
      };
    } finally {
      this.activeRunnerOperations.delete(runnerType);
      if (options?.switchToStableCrossOver) {
        this.activeRunnerOperations.delete('crossover');
      }
      ctx.notifyStateChanged();
    }
    return result;
  }
}
