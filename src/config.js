const DEFAULTS = {
  bridgeUrl: 'http://localhost:18010',
  authToken: '',
};

export function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('agent-space-config') || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  try { localStorage.setItem('agent-space-config', JSON.stringify(cfg)); } catch {}
}
