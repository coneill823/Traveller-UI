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
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { boot } from './net';

createRoot(document.getElementById('root')!).render(<App />);
void boot();
