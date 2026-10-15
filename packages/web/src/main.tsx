// First: the browser is probed before any shim fills a gap.
import { requiredMissing, startupFeatures } from './lib/browserSupport.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { BrowserBanner } from './components/BrowserBanner.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { listenForUncaught } from './lib/lastError.ts';
import { readRelayLink } from './lib/relayLink.ts';
import { readRequestLink } from './lib/requestLink.ts';
import { pruneRelayEntries } from './lib/relayStore.ts';
import { pruneSentHandoffs } from './lib/sentStore.ts';
import { markSessionLinkUsed, readSessionNonce, removeSessionFromAddressBar, takeSessionLinkUsed } from './lib/transport.ts';
import './styles/tokens.css';
import './styles/app.css';
import { allowReloadForRelease, reloadForNewRelease } from './lib/release.ts';

// Errors that nothing caught are kept for the "Technical details" of the next error report.
listenForUncaught(window);

// A loopback session starts with a one-time nonce in the URL fragment. Take it
// out of the address bar at once; the app exchanges it for the session token.
const sessionNonce = readSessionNonce(window.location.hash);
if (sessionNonce) removeSessionFromAddressBar(window.location, window.history);

// A relay link (#relay=…&k=…) carries a document key in the fragment. Take it
// out of the address bar at once, too; it is kept in memory only. A link with
// a key opens the "Open the document" card (views/RelayOpen.tsx).
const relayLink = readRelayLink(window.location, window.history);

// A request in the link (#request=…, issue #45) is put on the page when the
// person opens the PDF it was written for. It is taken out of the address bar
// too, so a reload does not apply it again.
const requestLink = sessionNonce || relayLink ? null : readRequestLink(window.location, window.history);

// Keys of emailed documents are kept on this device until the relay deletes
// the documents (lib/relayStore.ts); expired ones go at start-up.
// The hand-offs kept to send again (lib/sentStore.ts) go after their keep
// time, or once the key of a live link is gone (the signed PDF came back).
let deviceStorage: Storage | undefined;
try {
  deviceStorage = window.localStorage;
  pruneRelayEntries(deviceStorage);
} catch {
  // No storage: nothing was kept.
}
void pruneSentHandoffs(deviceStorage);

// The session token lives in memory only, so a reload cannot resume the session.
// A mark in this tab's storage lets the reloaded page say so.
let tabStorage: Storage | undefined;
try {
  tabStorage = window.sessionStorage;
} catch {
  tabStorage = undefined;
}
if (sessionNonce) markSessionLinkUsed(tabStorage);
const sessionLinkReloaded = !sessionNonce && takeSessionLinkUsed(tabStorage);

// A tab left open across a release: see lib/release.ts. A reload would also
// lose a relay link's key, which is now only in memory.
allowReloadForRelease(!sessionNonce && !sessionLinkReloaded && !relayLink && !requestLink);
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewRelease()) event.preventDefault();
});

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <BrowserBanner missing={requiredMissing(startupFeatures)} secure={window.isSecureContext !== false} />
    <ErrorBoundary>
      <App sessionNonce={sessionNonce} sessionLinkReloaded={sessionLinkReloaded} relayLink={relayLink} requestLink={requestLink} />
    </ErrorBoundary>
  </StrictMode>,
);
