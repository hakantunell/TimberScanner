const pairingHelp = document.querySelector('#pairing-help');
const qrCode = document.querySelector('#qr-code');
const sessionLabel = document.querySelector('#peer-label');
const sessionCode = document.querySelector('#peer-code');
const connectButton = document.querySelector('#connect-peer');
const connectionStatus = document.querySelector('#connection-status');

function hideManualPairingControls() {
  if (sessionLabel) sessionLabel.hidden = true;
  if (sessionCode) sessionCode.hidden = true;
  if (connectButton) connectButton.hidden = true;
}

function showViewerConnectedState() {
  if (qrCode) {
    qrCode.replaceChildren();
    qrCode.hidden = true;
  }
  if (pairingHelp) {
    pairingHelp.textContent = 'Telefonen är ansluten. Nya skanningsbilder och analysresultat visas automatiskt.';
  }
}

function showCaptureConnectedState() {
  hideManualPairingControls();
  if (pairingHelp) {
    pairingHelp.textContent = 'Telefonen är ansluten till datorns skanning. Starta kameran när du är klar.';
  }
}

const params = new URLSearchParams(window.location.search);
if (params.get('mode') === 'capture' && params.get('session') && params.get('uploadToken')) {
  showCaptureConnectedState();
}

if (connectionStatus) {
  const update = () => {
    const status = connectionStatus.textContent ?? '';
    if (status.startsWith('Ansluten')) showViewerConnectedState();
    if (status === 'Klar för uppladdning' || status === 'Bild uppladdad') showCaptureConnectedState();
  };

  new MutationObserver(update).observe(connectionStatus, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  update();
}
