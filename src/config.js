const isBrowser = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

if (isBrowser) {
  // Clear stale direct URLs — must use proxy now
  const old = localStorage.getItem('bridge_url');
  if (old && old.startsWith('http')) {
    localStorage.removeItem('bridge_url');
  }
}

const config = {
  get bridgeUrl() {
    return (isBrowser && localStorage.getItem('bridge_url')) || '/api';
  },
  get bridgeToken() {
    return (isBrowser && localStorage.getItem('bridge_token')) || '';
  },
  pollInterval: {
    health: 10000,
    heartbeat: 10000,
    logs: 10000,
    stats: 30000,
  },
  office: {
    cols: 5,
    rows: 2,
    maxSlots: 10,
  },
  tile: 32,
  gameWidth: 480,
  gameHeight: 320,
};

export default config;
