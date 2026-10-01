import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootAuth } from './cloud/auth';
import { AuthGate } from './cloud/AuthGate';
import { ConfirmHost } from './components/ConfirmHost';
import { loadBundle } from './data/loader';
import './styles.css';

bootAuth();
// Start downloading player data while the user signs in.
void loadBundle().catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
    <ConfirmHost />
  </StrictMode>,
);

// Installable/offline on phones: register the service worker in production builds.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
