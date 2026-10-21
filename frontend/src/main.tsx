import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/geist/index.css';
import '@fontsource-variable/geist-mono/index.css';
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
// The redesign (design_handoff_decimal/, 21 Oct 2026): everything under .ui.
import './styles/ui/tokens.css';
import './styles/ui/base.css';
import './styles/ui/shell.css';
import './styles/ui/components.css';
import './styles/ui/bills.css';
import './styles/ui/bill.css';
import './styles/ui/inbox.css';
import './styles/ui/home.css';
import './styles/ui/team.css';
import './styles/ui/vendors.css';
import './styles/ui/rules.css';
import './styles/ui/signin.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// The redesign is light only. The old pages still key their colours off
// data-theme, so pin it to light rather than reading an old choice of dark.
document.documentElement.setAttribute('data-theme', 'light');

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
