import React, { Component, type ErrorInfo, type ReactNode, useState } from 'react';
import { WubPad } from './wubpad-integration/WubPad';
import { EngineMonitor } from './wubpad-integration/EngineMonitor';
import { SampleManglerView } from './producer-tools/SampleManglerView';
import { BassSynthView } from './producer-tools/BassSynthView';
import { FlipPrepView } from './producer-tools/FlipPrepView';
import { RemixToDubstepView } from './producer-tools/RemixToDubstepView';

type AppView = 'pad' | 'engine' | 'mangler' | 'synth' | 'flip-prep' | 'remix-dubstep';

type ErrorBoundaryProps = {
  children: ReactNode;
  boundaryKey: string;
};

type ErrorBoundaryState = {
  error: Error | null;
};

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('WubPad render boundary caught an error', error, errorInfo);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (prevProps.boundaryKey !== this.props.boundaryKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <section style={styles.errorPanel}>
        <h2 style={styles.errorTitle}>Render Error</h2>
        <p style={styles.errorText}>
          A WubPad component crashed during render. The shell is still available so you can switch tabs or inspect the error.
        </p>
        <pre style={styles.errorDetails}>{this.state.error.message}</pre>
      </section>
    );
  }
}

function App() {
  const [view, setView] = useState<AppView>('pad');

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>WubLabz Control Surface</h1>
          <p style={styles.subtitle}>Local WubPad and engine dashboard</p>
        </div>
      </header>

      <nav style={styles.tabs} aria-label="WubLabz views">
        <button
          type="button"
          onClick={() => setView('pad')}
          style={{ ...styles.tabButton, ...(view === 'pad' ? styles.activeTabButton : {}) }}
        >
          WubPad
        </button>
        <button
          type="button"
          onClick={() => setView('engine')}
          style={{ ...styles.tabButton, ...(view === 'engine' ? styles.activeTabButton : {}) }}
        >
          WubLabz Engine Dashboard
        </button>
        <button
          type="button"
          onClick={() => setView('mangler')}
          style={{ ...styles.tabButton, ...(view === 'mangler' ? styles.activeTabButton : {}) }}
        >
          Sample Mangler
        </button>
        <button
          type="button"
          onClick={() => setView('synth')}
          style={{ ...styles.tabButton, ...(view === 'synth' ? styles.activeTabButton : {}) }}
        >
          Bass Synth
        </button>
        <button
          type="button"
          onClick={() => setView('flip-prep')}
          style={{ ...styles.tabButton, ...(view === 'flip-prep' ? styles.activeTabButton : {}) }}
        >
          Flip Prep
        </button>
        <button
          type="button"
          onClick={() => setView('remix-dubstep')}
          style={{ ...styles.tabButton, ...(view === 'remix-dubstep' ? styles.activeTabButton : {}) }}
        >
          Remix to Dubstep
        </button>
      </nav>

      <section style={styles.instructions} aria-label="Connection instructions">
        <strong>Connection:</strong> keep the engine running at <code>http://127.0.0.1:3001/health</code>, open this frontend at{' '}
        <code>http://localhost:3000</code>, and connect WubPad settings to <code>ws://127.0.0.1:3001</code>.
      </section>

      <main style={styles.main}>
        <ErrorBoundary boundaryKey={view}>
          {view === 'pad' && <WubPad />}
          {view === 'engine' && <EngineMonitor />}
          {view === 'mangler' && <SampleManglerView />}
          {view === 'synth' && <BassSynthView />}
          {view === 'flip-prep' && <FlipPrepView />}
          {view === 'remix-dubstep' && <RemixToDubstepView />}
        </ErrorBoundary>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    backgroundColor: '#0a0a0a',
    minHeight: '100vh',
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  },
  header: {
    padding: '1rem 1rem 0.75rem',
    borderBottom: '1px solid #262626',
    backgroundColor: '#141414'
  },
  title: {
    margin: 0,
    fontSize: '1.25rem',
    lineHeight: 1.2,
    letterSpacing: 0
  },
  subtitle: {
    margin: '0.25rem 0 0',
    color: '#a8a8a8',
    fontSize: '0.85rem'
  },
  tabs: {
    display: 'flex',
    gap: '0.5rem',
    padding: '0.75rem 1rem',
    borderBottom: '1px solid #262626',
    backgroundColor: '#101010',
    overflowX: 'auto'
  },
  tabButton: {
    backgroundColor: '#1c1c1c',
    border: '1px solid #3a3a3a',
    borderRadius: '4px',
    color: '#cfcfcf',
    cursor: 'pointer',
    fontWeight: 700,
    minHeight: '40px',
    padding: '0.55rem 0.75rem',
    whiteSpace: 'nowrap'
  },
  activeTabButton: {
    borderColor: '#00ffcc',
    color: '#00ffcc'
  },
  instructions: {
    padding: '0.75rem 1rem',
    backgroundColor: '#151515',
    borderBottom: '1px solid #262626',
    color: '#d8d8d8',
    fontSize: '0.85rem',
    lineHeight: 1.5
  },
  main: {
    minHeight: 'calc(100vh - 170px)'
  },
  errorPanel: {
    margin: '1rem',
    padding: '1rem',
    border: '1px solid #ff6b6b',
    borderRadius: '4px',
    backgroundColor: '#260f0f',
    color: '#fff'
  },
  errorTitle: {
    margin: 0,
    color: '#ff8c8c',
    fontSize: '1rem'
  },
  errorText: {
    margin: '0.5rem 0',
    color: '#f2d0d0'
  },
  errorDetails: {
    margin: 0,
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    color: '#fff',
    fontSize: '0.8rem'
  }
};

export default App;
