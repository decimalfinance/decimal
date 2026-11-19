import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** When this changes (the address, say), a crashed page gets another go. */
  resetKey?: string;
};
type State = { error: Error | null };

// A render error shows this in place of a white page: plain words and a way
// back. The error itself never goes on screen. It goes to the console, and to
// data-app-crash, which scripts/drive reads, so a crash is a state a check can
// see and name rather than a blank pane.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('A page crashed while rendering.', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="ui page" data-app-crash={error.message || error.name || 'error'}>
        <h1 className="page-title">This page couldn’t be shown</h1>
        <p className="page-sub">Something went wrong while showing it. Reloading usually fixes it.</p>
        <div className="page-actions">
          <button type="button" className="btn is-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
