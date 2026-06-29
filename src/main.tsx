import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './glass.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  document.body.innerHTML = [
    '<div style="background:#0a0a0a;color:#fff;min-height:100vh;padding:1rem;font-family:system-ui,sans-serif">',
    '<h1 style="font-size:1.25rem;margin:0 0 .5rem">WubPad Startup Error</h1>',
    '<p style="margin:0;color:#d8d8d8">Missing root element. Ensure index.html contains <code>&lt;div id="root"&gt;&lt;/div&gt;</code>.</p>',
    '</div>'
  ].join('');
} else {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
