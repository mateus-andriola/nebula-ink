import React from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { App } from './App.tsx';
import { DesktopHostApp } from './renderer/DesktopHostApp.tsx';
import { ScreenReflectionApp } from './renderer/ScreenReflectionApp.tsx';
import './styles.css';

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: '24px',
            color: '#f8fafc',
            background: '#0f172a',
            height: '100vh',
            fontFamily: 'monospace',
          }}
        >
          <h2>Erro de renderização detectado</h2>
          <pre style={{ color: '#f87171', whiteSpace: 'pre-wrap', marginTop: '12px' }}>
            {this.state.error.stack || this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '16px',
              padding: '8px 16px',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Recarregar Aplicação
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

const root = createRoot(container);
const isReflectionWindow = new URLSearchParams(window.location.search).get('reflection') === '1';
const isNativeDesktop = isTauri();
root.render(
  <React.StrictMode>
    <RootErrorBoundary>
      {isReflectionWindow ? (
        <ScreenReflectionApp />
      ) : isNativeDesktop ? (
        <DesktopHostApp />
      ) : (
        <App />
      )}
    </RootErrorBoundary>
  </React.StrictMode>
);
