/**
 * pixel-main.js — pixel.html 入口
 *
 * 流程:
 *   1. 加载 sprite → renderer.init
 *   2. 实例化 Sidebar (右栏卡片列表)
 *   3. 启动 BridgePoller, 每 5s 收到 cfg → renderer.setConfig + sidebar.setAgents
 *   4. 维护 selectedAgentName (单一 source), canvas/sidebar 双向同步选中态
 *   5. selected 在新一轮 cfg 中消失 → 自动清成 null
 */
import { BridgePoller } from './BridgeAdapter.js';
import { PixelRenderer } from './PixelRenderer.js';
import { Sidebar } from './Sidebar.js';

const POLL_INTERVAL_MS = 5000;

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
