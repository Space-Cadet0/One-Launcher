import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import { ModalShell } from './ModalShell';

export interface ModalErrorBoundaryProps {
  modalName?: string;
  isOpen?: boolean;
  onClose?: () => void;
  children: ReactNode;
}

interface ModalErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  resetKey: number;
}

/**
 * Fault-isolating React Error Boundary for modals and dialogs.
 * Prevents modal-level render exceptions from unmounting the root application tree (#root),
 * rendering an accessible top-layer ModalShell error fallback with recovery actions.
 * Automatically clears error state whenever isOpen transitions back to false or re-opens.
 */
export class ModalErrorBoundary extends Component<
  ModalErrorBoundaryProps,
  ModalErrorBoundaryState
> {
  private titleId = `modal-error-boundary-${Math.random().toString(36).slice(2, 9)}`;

  public override state: ModalErrorBoundaryState = {
    hasError: false,
    error: null,
    resetKey: 0,
  };

  public static getDerivedStateFromError(error: Error): Partial<ModalErrorBoundaryState> {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[ModalErrorBoundary] Uncaught exception in ${this.props.modalName || 'Modal'}:`,
      error,
      errorInfo
    );
  }

  public override componentDidUpdate(prevProps: ModalErrorBoundaryProps): void {
    // Automatically clear error when modal visibility changes (e.g. closes or re-opens)
    if (this.state.hasError && prevProps.isOpen !== this.props.isOpen) {
      this.setState({ hasError: false, error: null });
    }
  }

  public handleReset = (): void => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      resetKey: prev.resetKey + 1,
    }));
  };

  public handleClose = (): void => {
    this.setState({ hasError: false, error: null });
    if (this.props.onClose) {
      this.props.onClose();
    }
  };

  public override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.isOpen === false) {
        return null;
      }
      const modalLabel = this.props.modalName || 'Dialog';
      return (
        <ModalShell
          isOpen={this.props.isOpen ?? true}
          onClose={this.handleClose}
          ariaLabelledBy={this.titleId}
          className="max-w-lg w-full bg-[#1b2838] border border-amber-500/40 rounded-xl shadow-2xl p-6 text-white"
        >
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                <AlertTriangle className="w-6 h-6" aria-hidden="true" />
              </div>
              <div>
                <h2
                  id={this.titleId}
                  className="text-lg font-bold text-white tracking-wide"
                >
                  {modalLabel} Error
                </h2>
                <p className="text-xs text-slate-300">
                  An unexpected error occurred while rendering this dialog.
                </p>
              </div>
            </div>

            {this.state.error?.message && (
              <div className="p-3 rounded-lg bg-[#0e141b]/80 border border-[#2a475e] text-xs font-mono text-amber-200/90 break-words max-h-32 overflow-y-auto">
                {this.state.error.message}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="px-3.5 py-1.5 rounded bg-[#2a475e] hover:bg-[#3d658a] text-xs font-bold text-white flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Try Again</span>
              </button>
              <button
                type="button"
                onClick={this.handleClose}
                className="px-3.5 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-xs font-bold text-slate-950 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Close</span>
              </button>
            </div>
          </div>
        </ModalShell>
      );
    }

    return (
      <Fragment key={this.state.resetKey}>
        {this.props.children}
      </Fragment>
    );
  }
}
