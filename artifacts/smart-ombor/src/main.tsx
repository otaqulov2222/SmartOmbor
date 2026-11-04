import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

// Yangi UI chiqqanda eski cache (guruh/pachka "—") qolmasin — bir marta hard reload.
// index.html dagi inline BUILD bilan bir xil — eski cache qolsa yana bir marta yangilanadi.
const UI_BUILD = '2026-11-04-waybill-inline-v3';
const UI_BUILD_KEY = 'smart-ombor-ui-build';
try {
  const prev = localStorage.getItem(UI_BUILD_KEY);
  if (prev !== UI_BUILD) {
    localStorage.setItem(UI_BUILD_KEY, UI_BUILD);
    if (prev) {
      const url = new URL(window.location.href);
      url.searchParams.set('_ui', UI_BUILD);
      window.location.replace(url.toString());
    }
  }
} catch {
  /* ignore */
}

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
