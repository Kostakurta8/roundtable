/**
 * The hosted demo's entry: the real app, fed from a recording instead of a hub.
 *
 * `npm run build:pages` points `index.html` here instead of at `src/main.tsx`; nothing else does.
 * That is what keeps the demo out of the app people install — no flag the local bundle has to
 * evaluate, no branch a minifier has to prove dead. The recording, the player and the banner are
 * reachable only from this file, so a bundle built from `src/main.tsx` cannot contain them.
 *
 * Everything else is `src/main.tsx` verbatim, imports in the same order, so the cascade is the same
 * one the app ships with and the demo is not quietly styled differently from what it advertises.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';
import { feedFrom } from '../ws';
import { DemoBanner } from './DemoBanner';
import { playDemo } from './source';
import '../index.css';
import './demo.css';

feedFrom(playDemo);
document.documentElement.classList.add('rt-demo');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoBanner />
    <App />
  </StrictMode>,
);
