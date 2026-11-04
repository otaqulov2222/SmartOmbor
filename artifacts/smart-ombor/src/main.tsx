import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

// Clean up any leftover ?_ui= query param without reloading
try {
  if (window.location.search.includes('_ui=')) {
    const url = new URL(window.location.href);
    url.searchParams.delete('_ui');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
} catch {
  /* ignore */
}

createRoot(document.getElementById('root')!, {
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
