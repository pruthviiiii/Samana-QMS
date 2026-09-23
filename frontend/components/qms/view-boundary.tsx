'use client';
import { Component, type ReactNode } from 'react';
// A rendering error inside one view (Team, Reports, the TV board, a dialog)
// shows a message with a reload button in that area instead of blanking the
// whole workspace. The error is logged for the browser console; nothing
// about it is sent anywhere.
export class ViewBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('View failed:', this.props.name, error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty-state" role="alert">
        <h2>This part of the screen stopped working</h2>
        <p>
          The {this.props.name} view hit an unexpected error. The rest of the
          workspace is unaffected.
        </p>
        <button
          type="button"
          className="button"
          onClick={() => this.setState({ failed: false })}
        >
          Try again
        </button>
      </div>
    );
  }
}
