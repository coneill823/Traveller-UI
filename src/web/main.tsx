import '@fontsource/orbitron/500.css';
import '@fontsource/orbitron/600.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/theme.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/map.css';
import './styles/characters.css';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { act, boot } from './net';
import { useApp } from './store';

// Development only: a handle for poking at the running app from the browser console and from test scripts.
if (import.meta.env.DEV) (window as unknown as { __traveller: unknown }).__traveller = { act, useApp };

createRoot(document.getElementById('root')!).render(<App />);
void boot();
