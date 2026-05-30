import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/geist/index.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import { App } from './App';
import { ToastProvider } from './ui/Toast';
import './styles.css';
import './styles/design-tokens.css';
import './styles/canonical.css';
import './styles/sidebar.css';
import './styles/run-detail.css';
// Decimal design system (Mercury-clean institutional bank look). All classes
// live under the .dec namespace — wrap the app surface in <div className="dec">
// to activate. Order: tokens (CSS vars + Google Fonts import) → components
// (buttons / pills / tables / etc) → pages (page-specific layouts).
import './styles/decimal/tokens.css';
import './styles/decimal/components.css';
import './styles/decimal/pages.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Theme handling — the new design CSS keys off [data-theme="light"|"dark"]
// on the <html> element. Always set it explicitly so the [data-theme="light"]
// selector matches (rather than relying on :root defaulting).
const storedTheme = window.localStorage.getItem('decimal.theme');
const initialTheme = storedTheme === 'dark' ? 'dark' : 'light';
document.documentElement.setAttribute('data-theme', initialTheme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
