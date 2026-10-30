import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/bricolage-grotesque/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import '@fontsource/noto-sans-bengali/400.css';
import '@fontsource/noto-sans-bengali/700.css';
import './index.css';
import util from '@/lib/util';
import App from './App.jsx';
import { ScreenBoundary } from '@/lib/lazyScreen';

// Open the connection to the API while the rest of the app loads. The origin comes from config.js, not the source.
try {
  const origin = new URL(window.API_BASE_URL).origin;
  const link = document.createElement('link');
  link.rel = 'preconnect'; link.href = origin;
  document.head.appendChild(link);
} catch (e) { /* no or bad API_BASE_URL: nothing to connect to */ }

// The UI tests read Core.util from the page to compute the dates the form should show.
window.Core = { util };

// React logs every caught error with console.error. A screen boundary logs its own (once, in componentDidCatch), so skip those here.
const onCaughtError = (error, info) => { if (!(info.errorBoundary instanceof ScreenBoundary)) console.error(error); };

createRoot(document.getElementById('root'), { onCaughtError }).render(
  <StrictMode>
    <App />
  </StrictMode>
);
