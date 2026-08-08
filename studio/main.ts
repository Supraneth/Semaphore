import './studio';

/**
 * The editor boots with no Home Assistant, no network and no account: the
 * document lives in the browser, the export is a block of text you paste.
 */
document.getElementById('app')!.appendChild(document.createElement('semaphore-studio'));
