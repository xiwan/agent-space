/**
 * pixel-main.js — pixel.html 入口
 *
 * 流程: 加载 sprite → 启动 BridgePoller → 每次 onConfig 推到 PixelRenderer
 */
import { BridgePoller } from './BridgeAdapter.js';
import { PixelRenderer } from './PixelRenderer.js';

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

  const infoCard = document.getElementById('pixelInfoCard');
  const infoName = document.getElementById('pixelInfoName');
  const infoDesc = document.getElementById('pixelInfoDesc');
  const infoDomains = document.getElementById('pixelInfoDomains');
  const infoState = document.getElementById('pixelInfoState');
  const infoClose = document.getElementById('pixelInfoClose');

  const showAgentInfo = (agent) => {
    if (!infoCard) return;
    infoName.textContent = agent.name;
    infoState.textContent = agent.state;
    infoState.className = `pixel-state pixel-state-${agent.state}`;
    infoDesc.textContent = agent.description || '(no description)';
    infoDomains.textContent = (agent.domains && agent.domains.length)
      ? agent.domains.join(', ')
      : '(no domains)';
    infoCard.style.display = 'block';
  };

  const hideAgentInfo = () => { if (infoCard) infoCard.style.display = 'none'; };
  if (infoClose) infoClose.addEventListener('click', hideAgentInfo);

  setStatus('loading sprites...');
  const renderer = new PixelRenderer(canvas, {
    assetPath: '/pixel',
    onAgentClick: showAgentInfo,
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
      renderer.setConfig(cfg);
      const n = cfg.agents.length;
      if (n !== lastAgentCount) {
        lastAgentCount = n;
        setStatus(`${n} agents — last update ${new Date().toLocaleTimeString()}`, 'ok');
      } else {
        setStatus(`${n} agents — last update ${new Date().toLocaleTimeString()}`, 'ok');
      }
    },
    onError: (err) => {
      setStatus(`bridge error: ${err.message}`, 'error');
    },
  });
  poller.start();
}

main();
