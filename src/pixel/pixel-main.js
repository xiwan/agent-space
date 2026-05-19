/**
 * pixel-main.js — pixel.html 入口
 *
 * 流程:
 *   1. 加载 sprite → renderer.init
 *   2. 实例化 Sidebar (右栏卡片列表)
 *   3. 启动 BridgePoller, 每 5s 收到 cfg → renderer.setConfig + sidebar.setAgents
 *   4. 维护 selectedAgentName (单一 source), canvas/sidebar 双向同步选中态
 *   5. selected 在新一轮 cfg 中消失 → 自动清成 null
 *   6. 背景切换 (v2.3.0): header select → renderer.setBackground + localStorage
 */
import { BridgePoller } from './BridgeAdapter.js';
import { PixelRenderer } from './PixelRenderer.js';
import { Sidebar } from './Sidebar.js';

const POLL_INTERVAL_MS = 5000;

// === v2.3.0: 背景选项 ===
const BG_BASE = '/pixel/backgrounds';
const BG_OPTIONS = {
  level1:    { label: 'Level 1 — Storage room',    url: `${BG_BASE}/level1.png`   },
  level2:    { label: 'Level 2 — Small office',    url: `${BG_BASE}/level2.png`   },
  level3:    { label: 'Level 3 — Mid office',      url: `${BG_BASE}/level3.png`   },
  'level3.5':{ label: 'Level 3.5 — Office + meet', url: `${BG_BASE}/level3.5.png` },
  level4:    { label: 'Level 4 — Full HQ',         url: `${BG_BASE}/level4.png`   },
  default:   { label: 'Default (placeholder)',     url: null /* fallback to placeholder */ },
};
const BG_DEFAULT = 'level3';   // contain 黑边最少
const BG_LS_KEY = 'pixel.background';

async function main() {
  const canvas = document.getElementById('pixelCanvas');
  if (!canvas) {
    console.error('[pixel] #pixelCanvas not found');
    return;
  }

  const statusEl = document.getElementById('pixelStatus');
  const setStatus = (text, kind = 'info') => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  };

  const sidebarEl = document.getElementById('pixelSidebarCards');
  if (!sidebarEl) {
    console.error('[pixel] #pixelSidebarCards not found');
    return;
  }

  const bgSelectEl = document.getElementById('pixelBgSelect');

  // === 单一 source: 选中状态 ===
  let selectedName = null;
  let lastAgents = [];

  const setSelected = (name) => {
    if (selectedName === name) return;
    selectedName = name;
    renderer.setSelected(name);
    sidebar.setSelected(name);
  };

  const toggleSelected = (name) => {
    setSelected(selectedName === name ? null : name);
  };

  setStatus('loading sprites...');
  const renderer = new PixelRenderer(canvas, {
    assetPath: '/pixel',
    onAgentClick: (agent) => toggleSelected(agent.name),
  });

  const sidebar = new Sidebar(sidebarEl, {
    onToggle: (name) => toggleSelected(name),
  });

  try {
    await renderer.init();
  } catch (e) {
    setStatus(`sprite load failed: ${e.message}`, 'error');
    return;
  }

  // === v2.3.0: 背景 select 控件 ===
  // 1. 决定初始背景: localStorage 或默认
  let storedBg = null;
  try {
    storedBg = localStorage.getItem(BG_LS_KEY);
  } catch { /* 无 localStorage 时静默 */ }
  if (!storedBg || !BG_OPTIONS[storedBg]) storedBg = BG_DEFAULT;

  // 2. 填充 select 选项 + 绑定
  if (bgSelectEl) {
    bgSelectEl.innerHTML = '';
    for (const [key, opt] of Object.entries(BG_OPTIONS)) {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = opt.label;
      bgSelectEl.appendChild(o);
    }
    bgSelectEl.value = storedBg;
    bgSelectEl.addEventListener('change', async () => {
      const key = bgSelectEl.value;
      const opt = BG_OPTIONS[key];
      if (!opt) return;
      try { localStorage.setItem(BG_LS_KEY, key); } catch {}
      await renderer.setBackground(opt.url);
    });
  }

  // 3. 加载初始背景 (非默认时切换)
  if (storedBg !== 'default') {
    await renderer.setBackground(BG_OPTIONS[storedBg].url);
  }

  renderer.start();
  setStatus('connecting to bridge...');

  let lastAgentCount = -1;
  const poller = new BridgePoller({
    intervalMs: POLL_INTERVAL_MS,
    onConfig: (cfg) => {
      lastAgents = cfg.agents || [];
      renderer.setConfig(cfg);
      sidebar.setAgents(lastAgents);

      // 选中的 agent 在新 cfg 中不存在 → 自动清空选中
      if (selectedName && !lastAgents.find(a => a.name === selectedName)) {
        setSelected(null);
      }

      const n = lastAgents.length;
      const ts = new Date().toLocaleTimeString();
      setStatus(`${n} agents — last update ${ts}`, 'ok');
      if (n !== lastAgentCount) lastAgentCount = n;
    },
    onError: (err) => {
      setStatus(`bridge error: ${err.message}`, 'error');
    },
  });
  poller.start();
}

main();
