import { Component, type ErrorInfo, type ReactNode } from "react";

interface State { error: Error | null }

/**
 * Keeps a render error from unmounting the whole window: React drops the entire tree
 * when nothing catches it, which leaves only the page background behind.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("mild-editor crashed while rendering", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <strong>mild editor hit an error and stopped rendering.</strong>
        <pre>{error.stack || error.message}</pre>
        <button className="primary-button" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
