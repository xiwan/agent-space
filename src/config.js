const isBrowser = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

export default {
  bridgeUrl: (isBrowser && localStorage.getItem('bridge_url')) || 'http://localhost:3010',
  bridgeToken: (isBrowser && localStorage.getItem('bridge_token')) || '',
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
