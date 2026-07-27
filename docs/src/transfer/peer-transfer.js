const DEFAULT_OPTIONS = {
  debug: 1,
};

export class PeerTransfer {
  constructor({ onStatus, onCapture } = {}) {
    this.onStatus = onStatus ?? (() => {});
    this.onCapture = onCapture ?? (() => {});
    this.peer = null;
    this.connection = null;
  }

  async startViewer() {
    this.dispose();
    this.onStatus('Skapar parkoppling');
    this.peer = new window.Peer(undefined, DEFAULT_OPTIONS);

    const peerId = await new Promise((resolve, reject) => {
      this.peer.once('open', resolve);
      this.peer.once('error', reject);
    });

    this.peer.on('connection', (connection) => this.#attachConnection(connection));
    this.peer.on('error', (error) => this.#handleError(error));
    this.onStatus('Väntar på telefon');
    return peerId;
  }

  async connectToViewer(peerId) {
    this.dispose();
    this.onStatus('Ansluter till dator');
    this.peer = new window.Peer(undefined, DEFAULT_OPTIONS);

    await new Promise((resolve, reject) => {
      this.peer.once('open', resolve);
      this.peer.once('error', reject);
    });

    const connection = this.peer.connect(peerId, {
      reliable: true,
      serialization: 'binary',
      metadata: { role: 'capture', protocol: 1 },
    });
    this.#attachConnection(connection);

    await new Promise((resolve, reject) => {
      connection.once('open', resolve);
      connection.once('error', reject);
    });
    return connection;
  }

  sendCapture(capture) {
    if (!this.isConnected()) return false;
    this.connection.send({ type: 'capture', capture });
    return true;
  }

  sendState(state) {
    if (!this.isConnected()) return false;
    this.connection.send({ type: 'state', state });
    return true;
  }

  isConnected() {
    return Boolean(this.connection?.open);
  }

  dispose() {
    this.connection?.close();
    this.peer?.destroy();
    this.connection = null;
    this.peer = null;
  }

  #attachConnection(connection) {
    if (this.connection?.open) {
      connection.close();
      return;
    }

    this.connection = connection;
    connection.on('open', () => this.onStatus('Ansluten'));
    connection.on('close', () => this.onStatus('Frånkopplad'));
    connection.on('error', (error) => this.#handleError(error));
    connection.on('data', (message) => {
      if (message?.type === 'capture') this.onCapture(message.capture);
    });
  }

  #handleError(error) {
    console.error('Peer transfer error', error);
    this.onStatus(`Anslutningsfel: ${error.type ?? error.message}`);
  }
}
