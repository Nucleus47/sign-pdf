/**
 * The last line of defence: when a view throws while it draws, the person
 * sees what happened and can copy the details, not a blank page.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { failureOf, type Failure } from '../lib/errorReport.ts';
import { ErrorDetails } from './ErrorDetails.tsx';

interface State {
  failure: Failure | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failure: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failure: failureOf(error, 'render-error') };
  }

  override componentDidCatch(_error: unknown, info: ErrorInfo): void {
    // The component stack says which view failed; it holds component names only.
    const componentStack = info.componentStack ?? '';
    this.setState((previous) =>
      previous.failure && !previous.failure.stack?.includes(componentStack)
        ? { failure: { ...previous.failure, stack: `${previous.failure.stack ?? ''}\n${componentStack}` } }
        : previous,
    );
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    return (
      <main className="centered" id="main">
        <section className="card narrow" role="alert" data-testid="boundary-error">
          <h1>The page stopped working</h1>
          <p>
            An error stopped this page. The document and the values you entered are not kept. Reload
            the page, then open the document again.
          </p>
          <div className="button-row">
            <button type="button" className="button primary" data-testid="boundary-reload" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
          <ErrorDetails failure={failure} />
        </section>
      </main>
    );
  }
}
