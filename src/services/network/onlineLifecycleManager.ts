import type {
  EndpointHealthSnapshot,
  OfflineHydrationProgressPayload,
  OfflineVaultGameDetail,
} from '../../contracts/network';

type ConnectivityListener = (online: boolean, generation: number) => void;
type HealthListener = (snapshot: EndpointHealthSnapshot) => void;
type GameHydratedListener = (payload: { gameId: string; detail?: OfflineVaultGameDetail }) => void;
type HydrationProgressListener = (payload: OfflineHydrationProgressPayload) => void;

class OnlineLifecycleManager {
  private onlineState: boolean =
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
  private onlineGeneration = 0;
  private connectivityListeners = new Set<ConnectivityListener>();
  private healthListeners = new Set<HealthListener>();
  private gameHydratedListeners = new Set<GameHydratedListener>();
  private progressListeners = new Set<HydrationProgressListener>();
  private endpointHealth = new Map<string, EndpointHealthSnapshot>();
  private initialized = false;
  private ipcUnsubscribers: Array<() => void> = [];

  constructor() {
    this.ensureInitialized();
  }

  public ensureInitialized(): void {
    if (this.initialized) return;
    if (typeof window === 'undefined') return;
    this.initialized = true;

    this.onlineState = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

    window.addEventListener('online', this.handleWindowOnline);
    window.addEventListener('offline', this.handleWindowOffline);

    this.bindElectronBridgeListeners();
  }

  public bindElectronBridgeListeners(): void {
    if (typeof window === 'undefined') return;
    const vault = window.electronAPI?.offlineVault;
    if (!vault || this.ipcUnsubscribers.length > 0) return;

    if (typeof vault.onHealthChanged === 'function') {
      this.ipcUnsubscribers.push(
        vault.onHealthChanged((snapshot) => {
          if (snapshot && snapshot.host) {
            this.recordEndpointHealth(snapshot);
          }
        })
      );
    }

    if (typeof vault.onGameHydrated === 'function') {
      this.ipcUnsubscribers.push(
        vault.onGameHydrated((payload) => {
          if (payload && payload.gameId) {
            for (const listener of this.gameHydratedListeners) {
              try {
                listener(payload);
              } catch {}
            }
          }
        })
      );
    }

    if (typeof vault.onHydrationProgress === 'function') {
      this.ipcUnsubscribers.push(
        vault.onHydrationProgress((payload) => {
          if (payload) {
            for (const listener of this.progressListeners) {
              try {
                listener(payload);
              } catch {}
            }
          }
        })
      );
    }
  }

  private handleWindowOnline = (): void => {
    const wasOffline = !this.onlineState;
    this.onlineState = true;
    if (wasOffline) {
      this.onlineGeneration += 1;
    } else {
      this.onlineGeneration += 1;
    }
    this.emitConnectivity(true);
  };

  private handleWindowOffline = (): void => {
    this.onlineState = false;
    this.emitConnectivity(false);
  };

  private emitConnectivity(online: boolean): void {
    for (const listener of this.connectivityListeners) {
      try {
        listener(online, this.onlineGeneration);
      } catch {}
    }
  }

  public isOnline(): boolean {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }
    return this.onlineState;
  }

  public getOnlineGeneration(): number {
    return this.onlineGeneration;
  }

  /**
   * Forces an online generation bump (used by tests or manual reconnect triggers)
   * so transient UI failure sets (failed covers, sidebar icons, attempted lookups) reset.
   */
  public triggerReconnectSweep(): number {
    this.onlineState = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    this.onlineGeneration += 1;
    this.emitConnectivity(this.onlineState);
    return this.onlineGeneration;
  }

  public onConnectivityChange(listener: ConnectivityListener): () => void {
    this.ensureInitialized();
    this.connectivityListeners.add(listener);
    return () => {
      this.connectivityListeners.delete(listener);
    };
  }

  public onOnline(listener: (generation: number) => void): () => void {
    return this.onConnectivityChange((online, generation) => {
      if (online) {
        listener(generation);
      }
    });
  }

  public recordEndpointHealth(snapshot: EndpointHealthSnapshot): void {
    const key = snapshot.host.toLowerCase();
    const prev = this.endpointHealth.get(key);
    this.endpointHealth.set(key, snapshot);

    // If a previously OPEN endpoint just recovered to CLOSED, bump generation so failed images retry!
    if (prev && prev.state === 'OPEN' && snapshot.state === 'CLOSED') {
      this.onlineGeneration += 1;
      this.emitConnectivity(this.isOnline());
    }

    for (const listener of this.healthListeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  public getEndpointHealth(host: string): EndpointHealthSnapshot | undefined {
    const snap = this.endpointHealth.get(host.toLowerCase());
    if (!snap) return undefined;
    if (snap.state === 'OPEN' && snap.openedUntil > 0 && Date.now() >= snap.openedUntil) {
      return { ...snap, state: 'HALF_OPEN' };
    }
    return snap;
  }

  public isHostCircuitOpen(host: string): boolean {
    const snap = this.getEndpointHealth(host);
    return snap?.state === 'OPEN';
  }

  public onHealthChanged(listener: HealthListener): () => void {
    this.ensureInitialized();
    this.bindElectronBridgeListeners();
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  public onGameHydrated(listener: GameHydratedListener): () => void {
    this.ensureInitialized();
    this.bindElectronBridgeListeners();
    this.gameHydratedListeners.add(listener);
    return () => {
      this.gameHydratedListeners.delete(listener);
    };
  }

  public onHydrationProgress(listener: HydrationProgressListener): () => void {
    this.ensureInitialized();
    this.bindElectronBridgeListeners();
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }
}

export const onlineLifecycleManager = new OnlineLifecycleManager();
