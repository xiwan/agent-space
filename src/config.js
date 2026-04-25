const DEFAULTS = {
  bridgeUrl: 'http://localhost:18010',
  authToken: '',
  pollInterval: 10000,
  statsPollInterval: 30000,
  maxChatEntries: 50,
  maxDesks: 10,
  tileSize: 32,
  gameWidth: 480,
  gameHeight: 320,
};

/** Load config from localStorage, merged with defaults. */
export function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('agent-space-config') || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Save config to localStorage. */
export function saveConfig(cfg) {
  try { localStorage.setItem('agent-space-config', JSON.stringify(cfg)); } catch {}
}
