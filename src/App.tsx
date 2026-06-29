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
    <div className="wub-shell-bg" style={styles.shell}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>WubLabz Control Surface</h1>
          <p style={styles.subtitle}>Local WubPad and engine dashboard</p>
        </div>
      </header>

      <nav style={styles.tabs} aria-label="WubLabz views">
        <TabButton active={view === 'pad'} onClick={() => setView('pad')}>WubPad</TabButton>
        <TabButton active={view === 'engine'} onClick={() => setView('engine')}>WubLabz Engine Dashboard</TabButton>
        <TabButton active={view === 'mangler'} onClick={() => setView('mangler')}>Sample Mangler</TabButton>
        <TabButton active={view === 'synth'} onClick={() => setView('synth')}>Bass Synth</TabButton>
        <TabButton active={view === 'flip-prep'} onClick={() => setView('flip-prep')}>Flip Prep</TabButton>
        <TabButton active={view === 'remix-dubstep'} onClick={() => setView('remix-dubstep')}>Remix to Dubstep</TabButton>
      </nav>

      <section style={styles.instructions} aria-label="Connection instructions">
        <strong>Connection:</strong> keep the engine running at <code>http://localhost:3001/health</code>, open this frontend at{' '}
        <code>http://localhost:3000</code>, and connect WubPad settings to <code>ws://localhost:3001</code>.
      </section>

      <main className="wub-view-mount" style={styles.main}>
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

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onBlur={() => setPressed(false)}
      style={{
        ...styles.tabButton,
        ...(hovered ? styles.tabButtonHover : {}),
        ...(pressed ? styles.tabButtonActive : {}),
        ...(active ? styles.activeTabButton : {})
      }}
    >
      {children}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: '100vh',
    color: '#f5f8ff',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: '1rem',
    display: 'grid',
    gap: '0.9rem'
  },
  header: {
    padding: '1.15rem 1.25rem',
    border: '1px solid rgba(210, 236, 255, 0.16)',
    borderTop: '1px solid rgba(255, 255, 255, 0.24)',
    borderRadius: '18px',
    background: 'linear-gradient(135deg, rgba(17, 25, 40, 0.78), rgba(12, 18, 30, 0.6))',
    boxShadow: '0 22px 60px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.14)'
  },
  title: {
    margin: 0,
    fontSize: '1.45rem',
    lineHeight: 1.2,
    letterSpacing: 0,
    fontWeight: 850
  },
  subtitle: {
    margin: '0.25rem 0 0',
    color: '#a8b3c7',
    fontSize: '0.88rem'
  },
  tabs: {
    display: 'flex',
    gap: '0.55rem',
    padding: '0.55rem',
    border: '1px solid rgba(210, 236, 255, 0.13)',
    borderTop: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '16px',
    background: 'rgba(10, 15, 25, 0.68)',
    boxShadow: '0 16px 42px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
    overflowX: 'auto',
    backdropFilter: 'blur(14px) saturate(130%)'
  },
  tabButton: {
    background: 'rgba(255, 255, 255, 0.055)',
    border: '1px solid rgba(210, 236, 255, 0.12)',
    borderRadius: '12px',
    color: '#cdd6e8',
    cursor: 'pointer',
    fontWeight: 760,
    minHeight: '42px',
    padding: '0.6rem 0.85rem',
    whiteSpace: 'nowrap',
    transition: 'background 150ms ease, border-color 150ms ease, color 150ms ease, transform 100ms ease, box-shadow 150ms ease'
  },
  activeTabButton: {
    border: '1px solid rgba(110, 231, 255, 0.72)',
    background: 'linear-gradient(135deg, rgba(110, 231, 255, 0.2), rgba(124, 255, 201, 0.12))',
    color: '#f5feff',
    boxShadow: '0 10px 24px rgba(110, 231, 255, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.22)'
  },
  tabButtonHover: {
    background: 'rgba(255, 255, 255, 0.1)',
    border: '1px solid rgba(210, 236, 255, 0.28)'
  },
  tabButtonActive: {
    transform: 'translateY(1px)',
    background: 'rgba(255, 255, 255, 0.07)'
  },
  instructions: {
    padding: '0.85rem 1rem',
    background: 'rgba(16, 22, 34, 0.64)',
    border: '1px solid rgba(210, 236, 255, 0.12)',
    borderRadius: '14px',
    color: '#cdd6e8',
    fontSize: '0.85rem',
    lineHeight: 1.5,
    boxShadow: '0 12px 28px rgba(0, 0, 0, 0.2)'
  },
  main: {
    minHeight: 'calc(100vh - 230px)'
  },
  errorPanel: {
    padding: '1rem',
    border: '1px solid rgba(255, 107, 122, 0.54)',
    borderTop: '1px solid rgba(255, 255, 255, 0.22)',
    borderRadius: '14px',
    background: 'rgba(62, 17, 26, 0.74)',
    color: '#fff',
    boxShadow: '0 18px 42px rgba(0, 0, 0, 0.3)'
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
