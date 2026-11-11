import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import {
  AlertTriangle,
  RotateCcw,
  RefreshCw,
  Power,
  Shield,
  Copy,
  Check,
} from 'lucide-react';
import { emergencyResetModalOverlayLock } from '../../utils/modalOverlayLock';

export interface AppErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  resetKey: number;
  copied: boolean;
}

/**
 * Root-level error boundary preventing white screen of death (#root unmounting).
 * Traps uncaught render and lifecycle exceptions in the React tree, automatically
 * executes emergency modal overlay and inert resets to eliminate UI deadlock, and
 * presents a comprehensive recovery dashboard matching One Launcher styling.
 *
 * Conforms to Feature 20 & Feature 22 (Zero `: any` keywords).
 */
class AppErrorBoundaryClass extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  private titleId = `app-error-boundary-title-${Math.random().toString(36).slice(2, 9)}`;

  public override state: AppErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
    resetKey: 0,
    copied: false,
  };

  public static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error || 'Unknown application error'));
    return {
      hasError: true,
      error: normalizedError,
    };
  }

  public override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    // Automatically release any stuck modal overlay locks or #root[inert] attribute
    // so user interaction is immediately restored even if a modal threw during unmount.
    emergencyResetModalOverlayLock();

    console.error(
      '[AppErrorBoundary] Critical uncaught application exception trapped:',
      error,
      errorInfo
    );

    this.setState({ errorInfo });
  }

  public handleTryAgain = (): void => {
    emergencyResetModalOverlayLock();
    this.setState((prev) => ({
      hasError: false,
      error: null,
      errorInfo: null,
      resetKey: prev.resetKey + 1,
      copied: false,
    }));
  };

  public handleReloadView = (): void => {
    emergencyResetModalOverlayLock();
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
  };

  public handleRelaunchApp = (): void => {
    emergencyResetModalOverlayLock();
    const win =
      typeof window !== 'undefined'
        ? (window as unknown as { electronAPI?: { restartApp?: () => void } })
        : null;
    if (typeof win?.electronAPI?.restartApp === 'function') {
      win.electronAPI.restartApp();
    } else if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
  };

  public handleSafeModeRestart = (): void => {
    emergencyResetModalOverlayLock();
    if (typeof window !== 'undefined') {
      try {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem('one_launcher_safe_mode', 'true');
        }
      } catch {
        // Ignore storage errors in sandboxed test environments
      }
      if (typeof window.location?.reload === 'function') {
        window.location.reload();
      }
    }
  };

  public handleCopyDetails = (): void => {
    const message = this.state.error?.message || 'Unknown error';
    const name = this.state.error?.name || 'Error';
    const stack = this.state.error?.stack || '';
    const compStack = this.state.errorInfo?.componentStack || '';

    const payload = [
      `Application Error: ${name}: ${message}`,
      stack ? `\nStack:\n${stack}` : '',
      compStack ? `\nComponent Stack:\n${compStack}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      navigator.clipboard
        .writeText(payload)
        .then(() => {
          this.setState({ copied: true });
          setTimeout(() => {
            this.setState({ copied: false });
          }, 2000);
        })
        .catch(() => {});
    }
  };

  public override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const errorMessage = this.state.error?.message || 'An unexpected error occurred.';
      const errorName = this.state.error?.name || 'Error';

      return (
        <div
          role="region"
          aria-labelledby={this.titleId}
          className="min-h-screen w-full bg-[#0e141b] text-slate-100 flex flex-col items-center justify-center p-6 select-none"
        >
          <div className="max-w-2xl w-full bg-[#1b2838] border border-red-500/40 rounded-2xl shadow-2xl p-8 space-y-6">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 shrink-0">
                <AlertTriangle className="w-8 h-8" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h1
                  id={this.titleId}
                  className="text-xl font-bold text-white tracking-wide"
                >
                  Application Encountered an Error
                </h1>
                <p className="text-sm text-slate-300">
                  One Launcher isolated an unexpected rendering exception to prevent a complete crash.
                  Your local games and data are safe.
                </p>
              </div>
            </div>

            <div
              role="alert"
              aria-live="assertive"
              className="p-4 rounded-xl bg-[#090d13]/90 border border-[#2a475e] text-xs font-mono text-red-300 break-words max-h-48 overflow-y-auto space-y-1 select-text"
            >
              <div className="font-semibold text-red-400">
                {errorName}: {errorMessage}
              </div>
              {this.state.error?.stack && (
                <div className="text-[11px] text-slate-400/80 whitespace-pre-wrap">
                  {this.state.error.stack}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                autoFocus
                onClick={this.handleTryAgain}
                className="px-4 py-2 rounded-lg bg-[#2a475e] hover:bg-[#3d658a] text-xs font-bold text-white flex items-center gap-2 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" aria-hidden="true" />
                <span>Try Again</span>
              </button>

              <button
                type="button"
                onClick={this.handleReloadView}
                className="px-4 py-2 rounded-lg bg-[#2a475e]/70 hover:bg-[#2a475e] text-xs font-bold text-white flex items-center gap-2 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                <span>Reload View</span>
              </button>

              <button
                type="button"
                onClick={this.handleRelaunchApp}
                className="px-4 py-2 rounded-lg bg-[#2a475e]/70 hover:bg-[#2a475e] text-xs font-bold text-white flex items-center gap-2 transition-colors cursor-pointer"
              >
                <Power className="w-4 h-4" aria-hidden="true" />
                <span>Relaunch Application</span>
              </button>

              <button
                type="button"
                onClick={this.handleSafeModeRestart}
                className="px-4 py-2 rounded-lg bg-amber-600/80 hover:bg-amber-600 text-xs font-bold text-white flex items-center gap-2 transition-colors cursor-pointer"
              >
                <Shield className="w-4 h-4" aria-hidden="true" />
                <span>Safe Mode Restart</span>
              </button>

              <button
                type="button"
                onClick={this.handleCopyDetails}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 flex items-center gap-2 transition-colors cursor-pointer ml-auto"
              >
                {this.state.copied ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                    <span className="text-emerald-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" aria-hidden="true" />
                    <span>Copy Error Details</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
  }
}

export const AppErrorBoundary: typeof AppErrorBoundaryClass = new Proxy(
  AppErrorBoundaryClass,
  {
    apply(target, _thisArg, argArray) {
      const props = (argArray[0] || {}) as AppErrorBoundaryProps;
      return new target(props).render();
    },
    construct(target, argArray) {
      const props = (argArray[0] || {}) as AppErrorBoundaryProps;
      return new target(props);
    },
  }
);

export { AppErrorBoundaryClass };
