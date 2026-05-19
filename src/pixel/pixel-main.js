/**
 * pixel-main.js — pixel.html 入口
 *
 * 流程:
 *   1. 加载 sprite → renderer.init
 *   2. 实例化 Sidebar (右栏卡片列表) + MapEditor (编辑器)
 *   3. 启动 BridgePoller, 每 5s 收到 cfg → renderer.setConfig + sidebar.setAgents
 *   4. selectedAgentName 单一 source: canvas/sidebar 双向 toggle
 *   5. selected 在新一轮 cfg 中消失 → 自动清成 null
 *   6. 背景切换 (v2.3.0): header select → renderer.setBackground + localStorage
 *   7. 编辑模式 (v2.4.0): header ✏ 按钮 → MapEditor.open / close;
 *      mapConfig 改变后通知 BridgePoller, 下次 onConfig 时使用 PathFinder 计算 path,
 *      传给 renderer.setConfig 让 sprite 沿路径走.
 */
import { BridgePoller } from './BridgeAdapter.js';
import { PixelRenderer } from './PixelRenderer.js';
import { Sidebar } from './Sidebar.js';
import { MapEditor } from './MapEditor.js';
import {
  loadMapConfig, saveMapConfig, emptyMapConfig,
  getTargetCell, cellToPx, pxToCell, GRID_SIZE,
} from './MapConfig.js';
import { findPath } from './PathFinder.js';

const POLL_INTERVAL_MS = 5000;

const BG_BASE = '/pixel/backgrounds';
const BG_OPTIONS = {
  level1:    { label: 'Level 1 — Storage room',    url: `${BG_BASE}/level1.png`   },
  level2:    { label: 'Level 2 — Small office',    url: `${BG_BASE}/level2.png`   },
  level3:    { label: 'Level 3 — Mid office',      url: `${BG_BASE}/level3.png`   },
  'level3.5':{ label: 'Level 3.5 — Office + meet', url: `${BG_BASE}/level3.5.png` },
  level4:    { label: 'Level 4 — Full HQ',         url: `${BG_BASE}/level4.png`   },
  default:   { label: 'Default (placeholder)',     url: null },
};
const BG_DEFAULT = 'level3';
const BG_LS_KEY = 'pixel.background';

async function main() {
  const canvas = document.getElementById('pixelCanvas');
  if (!canvas) { console.error('[pixel] #pixelCanvas not found'); return; }

  const statusEl = document.getElementById('pixelStatus');
  const setStatus = (text, kind = 'info') => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  };

  const sidebarEl = document.getElementById('pixelSidebarCards');
  if (!sidebarEl) { console.error('[pixel] #pixelSidebarCards not found'); return; }

  const bgSelectEl = document.getElementById('pixelBgSelect');
  const editBtnEl = document.getElementById('pixelEditBtn');
  const editToolbarEl = document.getElementById('pixelEditToolbar');

  // === 选中状态 ===
  let selectedName = null;
  let lastAgents = [];
  const setSelected = (name) => {
    if (selectedName === name) return;
    selectedName = name;
    renderer.setSelected(name);
    sidebar.setSelected(name);
  };
  const toggleSelected = (name) => setSelected(selectedName === name ? null : name);

  // === 当前 bg + mapConfig 状态 ===
  let currentBg = BG_DEFAULT;
  let mapConfig = null;

  const reloadMapConfig = () => {
    mapConfig = loadMapConfig(currentBg);
    poller.setMapConfig(mapConfig, getTargetCell, cellToPx);
    renderer.setMapConfig(mapConfig); // for edit overlay
  };

  // === renderer / sidebar / editor 实例 ===
  setStatus('loading sprites...');
  const renderer = new PixelRenderer(canvas, {
    assetPath: '/pixel',
    onAgentClick: (agent) => toggleSelected(agent.name),
  });
  const sidebar = new Sidebar(sidebarEl, {
    onToggle: (name) => toggleSelected(name),
  });

  const editor = (editBtnEl && editToolbarEl) ? new MapEditor(canvas, editToolbarEl, {
    onSave: () => {
      saveMapConfig(currentBg, mapConfig);
      setStatus(`map saved for ${currentBg}`, 'ok');
    },
    onChange: () => {
      // mutate 同一对象, renderer 下一帧自动看到
    },
    onExit: () => {
      // 退出编辑模式: 隐藏工具栏, 恢复 sprite
      renderer.setEditMode(false);
      // poller 重读最新 mapConfig (可能用户没 save)
      poller.setMapConfig(mapConfig, getTargetCell, cellToPx);
      if (editBtnEl) editBtnEl.classList.remove('active');
    },
  }) : null;

  try { await renderer.init(); }
  catch (e) { setStatus(`sprite load failed: ${e.message}`, 'error'); return; }

  // === 背景 select ===
  let storedBg = null;
  try { storedBg = localStorage.getItem(BG_LS_KEY); } catch {}
  if (!storedBg || !BG_OPTIONS[storedBg]) storedBg = BG_DEFAULT;
  currentBg = storedBg;

  if (bgSelectEl) {
    bgSelectEl.innerHTML = '';
    for (const [key, opt] of Object.entries(BG_OPTIONS)) {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = opt.label;
      bgSelectEl.appendChild(o);
    }
    bgSelectEl.value = currentBg;
    bgSelectEl.addEventListener('change', async () => {
      currentBg = bgSelectEl.value;
      try { localStorage.setItem(BG_LS_KEY, currentBg); } catch {}
      const opt = BG_OPTIONS[currentBg];
      if (opt) await renderer.setBackground(opt.url);
      reloadMapConfig();
    });
  }

  if (currentBg !== 'default') {
    await renderer.setBackground(BG_OPTIONS[currentBg].url);
  }

  // === 编辑按钮 ===
  if (editBtnEl && editor) {
    editBtnEl.addEventListener('click', () => {
      if (editor.isOpen()) {
        editor.close();
      } else {
        // 进入编辑模式: 没 mapConfig 创建一份空的
        if (!mapConfig) mapConfig = emptyMapConfig();
        const agentNames = lastAgents.map(a => a.name);
        renderer.setEditMode(true, mapConfig);
        editor.open(mapConfig, agentNames);
        editBtnEl.classList.add('active');
      }
    });
  }

  // === BridgePoller ===
  let lastAgentCount = -1;
  const poller = new BridgePoller({
    intervalMs: POLL_INTERVAL_MS,
    onConfig: (cfg) => {
      lastAgents = cfg.agents || [];

      // v2.4.0: 在 mapConfig 模式下, 给每个 agent 计算 path (起点 = sprite 当前位置 / 终点 = adapter 算好的 cell)
      if (mapConfig) {
        for (const a of lastAgents) {
          // 找 sprite 当前位置 (pxToCell), 找目标 cell (从 a.x/a.y 反推)
          const renderState = renderer.agents?.find(r => r.name === a.name);
          const startPx = renderState ? [renderState.cx, renderState.cy] : [a.x, a.y];
          const startCell = pxToCell(startPx[0], startPx[1], mapConfig.gridSize);
          const endCell = pxToCell(a.x, a.y, mapConfig.gridSize);
          const p = findPath(mapConfig.obstacles, startCell, endCell);
          if (p) {
            a.path = p;
            a.pathGridSize = mapConfig.gridSize;
          }
        }
      }

      renderer.setConfig(cfg);
      sidebar.setAgents(lastAgents);

      if (selectedName && !lastAgents.find(a => a.name === selectedName)) {
        setSelected(null);
      }

      // 编辑模式下, 如果 agentNames 列表更新了, 同步给 editor (但不强制重开)
      if (editor && editor.isOpen()) {
        // 重渲工具栏以反映可能的新 agent 列表
        editor.agentNames = lastAgents.map(a => a.name);
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

  reloadMapConfig();
  renderer.start();
  setStatus('connecting to bridge...');
  poller.start();
}

main();
