export class BridgeClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.ws = null;
    this.wsUrl = null;
    this.onAgentUpdate = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
  }

  async _fetch(path) {
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  connect(onAgentUpdate) {
    this.onAgentUpdate = onAgentUpdate;
    this.wsUrl = this.baseUrl.replace(/^http:/, 'ws:') + '/ws';
    this._doConnect();
  }

  _doConnect() {
    if (this.ws) this.ws.close();

    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'agent_update' && this.onAgentUpdate) {
          this.onAgentUpdate({ name: data.name, status: data.status });
        }
      } catch (e) {}
    };

    this.ws.onclose = () => {
      this._maybeReconnect();
    };

    this.ws.onerror = () => {
      this.ws.close();
    };
  }

  _maybeReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    setTimeout(() => this._doConnect(), delay);
  }

  disconnect() {
    this.reconnectAttempts = this.maxReconnectAttempts;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}