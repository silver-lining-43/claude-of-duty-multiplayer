// Movement-only protocol v1. Combat messages are deliberately unsupported.
export class MultiplayerClient {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.peers = new Map();
    this.status = 'offline';
    this.sequence = 0;
  }
  async connect(endpoint, code = '') {
    this.leave();
    this.endpoint = endpoint.replace(/\/$/, '');
    if (!/^https?:\/\//.test(this.endpoint)) throw new Error('Enter an HTTP(S) room server URL');
    if (!code) {
      const response = await fetch(`${this.endpoint}/rooms`, { method: 'POST' });
      if (!response.ok) throw new Error('Could not create room');
      code = (await response.json()).code;
    }
    this.code = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(this.code)) throw new Error('Room codes contain eight letters or digits');
    this.active = true;
    this.token = crypto.randomUUID();
    this.open();
  }
  open() {
    const socket = this.socket = new WebSocket(`${this.endpoint.replace(/^http/, 'ws')}/rooms/${this.code}?token=${this.token}`);
    this.setStatus('connecting');
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      const message = JSON.parse(data);
      if (message.type === 'error') { socket.close(4008, message.message); this.setStatus('room unavailable'); return; }
      if (message.type === 'welcome') {
        this.id = message.id;
        this.sequence = 0;
        this.peers.clear();
        for (const peer of message.peers) if (peer.state) this.receive(peer.id, peer.state);
        this.setStatus('connected');
      } else if (message.type === 'state') this.receive(message.id, message.state);
      else if (message.type === 'leave') this.peers.delete(message.id);
    };
    socket.onclose = ({ code }) => {
      if (this.socket !== socket || !this.active) return;
      this.peers.clear();
      if ((code === 1008 || code === 4008)) { this.setStatus('room unavailable'); return; }
      this.setStatus('reconnecting');
      this.retry = setTimeout(() => this.open(), 1500);
    };
  }
  setStatus(status) { this.status = status; this.onStatus(this); }
  receive(id, state) {
    const peer = this.peers.get(id) ?? { samples: [] };
    peer.samples.push({ ...state, time: performance.now() });
    peer.samples = peer.samples.slice(-12);
    this.peers.set(id, peer);
  }
  send(state) {
    const now = performance.now();
    if (this.socket?.readyState !== WebSocket.OPEN || this.status !== 'connected' || now - (this.lastSend ?? 0) < 50) return;
    this.lastSend = now;
    this.socket.send(JSON.stringify({ v: 1, type: 'state', seq: ++this.sequence, state }));
  }
  sample(peer, now = performance.now()) {
    const time = now - 100;
    const samples = peer.samples;
    while (samples.length > 2 && samples[1].time <= time) samples.shift();
    const a = samples[0], b = samples[1] ?? a;
    const t = Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time || 1)));
    const angle = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
    return { ...b, position: a.position.map((v, i) => v + (b.position[i] - v) * t), yaw: a.yaw + angle * t };
  }
  leave() {
    this.active = false;
    clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.peers.clear();
    this.setStatus('offline');
  }
  getState() {
    return { active: !!this.active, status: this.status, code: this.code, id: this.id,
      peers: [...this.peers].map(([id, peer]) => ({ id, ...this.sample(peer) })) };
  }
}
