/**
 * pixel-main.js — pixel.html 入口 (v2.5.0)
 *
 * 流程:
 *   1. 加载 sprite → renderer.init (默认 paused, sprite 隐藏)
 *   2. 实例化 Sidebar + MapEditor (global zones)
 *   3. 启动 BridgePoller, 每 5s 收到 cfg → renderer.setConfig + sidebar.setAgents
 *      sidebar 卡片始终更新, 即便未 Start
 *   4. ▶ Start 按钮: setSpritesVisible(true) + setPaused(false), sprite 出现
 *      (BridgeAdapter 用 mapConfig 把每个 agent spawn 在 home zone, 然后按当前 state 走 path)
 *   5. ⏸ Pause 按钮: setPaused(true), sprite 冻结
 *   6. ✏ Edit 按钮: 进编辑模式 (sprite 隐藏 / overlay 显示)
 *   7. 背景 select: 切换 mapConfig 来源
 *   8. selected agent 单一 source, sidebar/canvas 双向 toggle
 */
import { BridgePoller } from './BridgeAdapter.js';
import { PixelRenderer } from './PixelRenderer.js';
import { Sidebar } from './Sidebar.js';
import { MapEditor } from './MapEditor.js';
import { CommandComposer } from './CommandComposer.js';
import { CommandClient } from './CommandClient.js';
import { CommandHistory } from './CommandHistory.js';
import { UsageView } from './UsageView.js';
import { HeartbeatView } from './HeartbeatView.js';
import { ArtifactComposer } from './ArtifactComposer.js';
import {
  loadMapConfig, saveMapConfig, emptyMapConfig,
  loadMapConfigAsync, saveMapConfigAsync,
  getTargetCell, cellToPx, pxToCell, getZoneCells, stateToZone,
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

  const sidebarEl = document.getElementById('pixelSidebar');
  if (!sidebarEl) { console.error('[pixel] #pixelSidebar not found'); return; }
  // v2.18.0: composer 已并入 sidebar 第 5 tab — 不再有底部 #pixelComposer 节点

  const bgSelectEl = document.getElementById('pixelBgSelect');
  const editBtnEl = document.getElementById('pixelEditBtn');
  const editToolbarEl = document.getElementById('pixelEditToolbar');
  const startBtnEl = document.getElementById('pixelStartBtn');

  // === 选中状态 ===
  let selectedName = null;
  let lastAgents = [];
  const setSelected = (name) => {
    if (selectedName === name) return;
    selectedName = name;
    renderer.setSelected(name);
    renderer.setWaitOrder(name);   // v2.22.0: 选中 → 进入 wait-order, 头上浮现选择框
    sidebar.setSelected(name);
  };
  const toggleSelected = (name) => setSelected(selectedName === name ? null : name);

  // === bg + mapConfig ===
  let currentBg = BG_DEFAULT;
  let mapConfig = null;

  // v2.9.0: server-first load. 失败退 localStorage. 状态条显示来源.
  const reloadMapConfig = async () => {
    try {
      mapConfig = await loadMapConfigAsync(currentBg);
    } catch {
      mapConfig = loadMapConfig(currentBg);
    }
    poller.setMapConfig(mapConfig, getTargetCell, cellToPx);
    renderer.setMapConfig(mapConfig);
  };

  // === renderer / sidebar / editor ===
  setStatus('loading sprites...');
  const renderer = new PixelRenderer(canvas, {
    assetPath: '/pixel',
    onAgentClick: (agent) => toggleSelected(agent.name),
    // v2.22.0: wait-order 选择框点击 → 发预设问题给 agent, 回复冒泡
    onAgentOrder: (name, presetId, label) => handleAgentOrder(name, presetId, label),
  });
  // v2.13.4: 默认就 running (从 v2.5.0 的 paused+hidden 翻转)
  renderer.setPaused(false);
  renderer.setSpritesVisible(true);
  // 首次 onConfig 时强制 spawn 在 home zone (等价于 v2.5.0 第一次点 Start)
  let firstSpawnPending = true;

  const sidebar = new Sidebar(sidebarEl, {
    onToggle: (name) => toggleSelected(name),
    // v2.13.0: clear 按钮触发 history.clear()
    onClearHistory: () => {
      if (history) history.clear();
    },
  });

  // === v2.10.0: Command Composer + Client + History ===
  const commandClient = new CommandClient();

  // v2.22.0: wait-order 预设 → prompt 映射
  const ORDER_PROMPTS = {
    last_task: '用一句话说说你上一个任务在干嘛？',
    say_something: '有什么想说的？随便聊一句。',
  };

  // v2.22.0: 选择框点击 → 发 job, 回复冒泡; 发完退出 wait-order
  const handleAgentOrder = async (name, presetId, label) => {
    const prompt = ORDER_PROMPTS[presetId];
    if (!name || !prompt) return;
    renderer.setWaitOrder(null);
    renderer.enqueueBubble(name, '…', { duration: 60000 });
    try {
      const res = await commandClient.submitJob({ body: { agent_name: name, prompt } });
      const jobId = res && res.job_id;
      if (!jobId) { renderer.enqueueBubble(name, '(no reply)'); return; }
      // 轮询直到完成 (最多 ~3min, 冷启动 agent 起 session 较慢)
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const job = await commandClient.pollJob(jobId);
        if (job && (job.status === 'completed' || job.status === 'failed')) {
          const text = job.result || job.error || '(empty)';
          renderer.enqueueBubble(name, text);
          return;
        }
      }
      renderer.enqueueBubble(name, '还在想…（任务仍在运行，去 History 看结果）');
    } catch (e) {
      renderer.enqueueBubble(name, `(error: ${e.message || e})`);
    }
  };

  const historyContainer = sidebar.getHistoryContainer();
  const history = historyContainer ? new CommandHistory(historyContainer, {
    client: commandClient,
    onAgentOutput: (name, text, opts) => {
      if (name && text) renderer.enqueueBubble(name, text, opts);
    },
    // v2.13.0: count 变化 → sidebar 工具行更新
    onCountChange: (n) => sidebar.setHistoryCount(n),
  }) : null;

  // === v2.18.0: Composer 已并入 Sidebar 第 5 tab ===
  // 布局: Quick (ArtifactComposer) 上 + Advanced (CommandComposer) 下, 都默认展开,
  // 各自独立 Submit. 中间用一个分隔标题区分.
  const composerEl = sidebar.getComposerContainer();
  let composer = null;
  let artifactComposer = null;

  if (composerEl) {
    // Quick panel (上)
    const quickHeader = document.createElement('div');
    quickHeader.className = 'composer-section-head';
    quickHeader.textContent = '⚡ Quick';
    const quickPanel = document.createElement('div');
    quickPanel.className = 'composer-panel composer-quick';

    // Advanced panel (下)
    const advHeader = document.createElement('div');
    advHeader.className = 'composer-section-head';
    advHeader.textContent = '⚙ Advanced';
    const advancedPanel = document.createElement('div');
    advancedPanel.className = 'composer-panel composer-advanced';

    composerEl.appendChild(quickHeader);
    composerEl.appendChild(quickPanel);
    composerEl.appendChild(advHeader);
    composerEl.appendChild(advancedPanel);

    // Advanced = 现有 CommandComposer
    composer = new CommandComposer(advancedPanel, {
      onSubmit: async (payload) => {
        const state = composer.getState();
        const kind = payload.endpoint === '/api/runs' ? 'run'
                   : payload.endpoint === '/api/jobs' ? 'job'
                   : 'pipeline';
        const agents = [...state.agents];
        const prompt = state.prompt;
        const mode = state.mode;
        const response = await commandClient.submit(payload);
        if (history) history.pushSubmission({ kind, mode, agents, prompt }, response);
      },
    });

    // Quick = ArtifactComposer (artifacts 异步加载)
    artifactComposer = new ArtifactComposer(quickPanel, {
      onSubmit: async (payload) => {
        const response = await commandClient.submit(payload);
        const mode = payload.body?.mode || 'pipeline';
        const agents = payload.body?.participants || (payload.body?.steps || []).map(s => s.agent);
        const prompt = payload.body?.topic || (payload.body?.steps?.[0]?.prompt || '').slice(0, 80);
        if (history) history.pushSubmission({ kind: 'pipeline', mode, agents, prompt, _artifacts: payload._artifacts, _artifactName: payload._artifactName || '', gameId: payload._uid || '' }, response);
      },
    });

    // 异步加载 artifacts.json
    fetch('/pixel/artifacts.json')
      .then(r => r.ok ? r.json() : [])
      .then(data => artifactComposer.setArtifacts(data))
      .catch(() => {});
  }

  if (history) history.start();

  // === v2.12.0: Usage tab ===
  const usageContainer = sidebar.getUsageContainer();
  const usage = usageContainer ? new UsageView(usageContainer) : null;
  if (usage) usage.start();

  // === v2.15.0: Heartbeat tab ===
  // v2.20.0 C: heartbeat log → Canvas bubble 联动 (复用 history 的 enqueueBubble 入口)
  const heartbeatContainer = sidebar.getHeartbeatContainer();
  const heartbeat = heartbeatContainer ? new HeartbeatView(heartbeatContainer, {
    onAgentOutput: (name, text) => {
      if (name && text) renderer.enqueueBubble(name, text);
    },
  }) : null;
  if (heartbeat) heartbeat.start();

  const editor = (editBtnEl && editToolbarEl) ? new MapEditor(canvas, editToolbarEl, {
    onSave: async () => {
      try {
        await saveMapConfigAsync(currentBg, mapConfig);
        setStatus(`map saved to server for ${currentBg}`, 'ok');
      } catch (e) {
        // 服务端失败 → 退到本地保存, 至少不丢
        saveMapConfig(currentBg, mapConfig);
        setStatus(`server save failed (${e.message}) — saved locally only`, 'error');
      }
    },
    onUploadLocal: async () => {
      // v2.9.0: 把当前浏览器 localStorage 的同 bgId 配置推到 server (一次性迁移)
      const local = loadMapConfig(currentBg);
      if (!local) {
        setStatus(`no local map for ${currentBg}`, 'error');
        return;
      }
      try {
        await saveMapConfigAsync(currentBg, local);
        // 推完后让 in-memory 也指向这份, 以免编辑器里 zones 是空的
        mapConfig = local;
        poller.setMapConfig(mapConfig, getTargetCell, cellToPx);
        renderer.setMapConfig(mapConfig);
        if (editor) editor.setMapConfig(mapConfig);
        setStatus(`local map uploaded to server (${currentBg})`, 'ok');
      } catch (e) {
        setStatus(`upload failed: ${e.message}`, 'error');
      }
    },
    onChange: () => {},
    onExit: () => {
      renderer.setEditMode(false);
      poller.setMapConfig(mapConfig, getTargetCell, cellToPx);
      if (editBtnEl) editBtnEl.classList.remove('active');
    },
  }) : null;

  try { await renderer.init(); }
  catch (e) { setStatus(`sprite load failed: ${e.message}`, 'error'); return; }

  // v2.6.0: inject pathfinder for wander
  renderer.setPathFinder({ findPath, getZoneCells, stateToZone });

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
      await reloadMapConfig();
    });
  }

  if (currentBg !== 'default') {
    await renderer.setBackground(BG_OPTIONS[currentBg].url);
  }

  // === Edit 按钮 ===
  if (editBtnEl && editor) {
    editBtnEl.addEventListener('click', () => {
      if (editor.isOpen()) {
        editor.close();
      } else {
        if (!mapConfig) mapConfig = emptyMapConfig();
        renderer.setEditMode(true, mapConfig);
        editor.open(mapConfig);
        editBtnEl.classList.add('active');
      }
    });
  }

  // === v2.5.0: Start/Pause 按钮 ===
  const updateStartBtn = () => {
    if (!startBtnEl) return;
    if (!renderer.areSpritesVisible()) {
      startBtnEl.textContent = '▶ Start';
      startBtnEl.classList.remove('active');
    } else if (renderer.isPaused()) {
      startBtnEl.textContent = '▶ Resume';
      startBtnEl.classList.remove('active');
    } else {
      startBtnEl.textContent = '⏸ Pause';
      startBtnEl.classList.add('active');
    }
  };
  updateStartBtn();
  if (startBtnEl) {
    startBtnEl.addEventListener('click', () => {
      if (!renderer.areSpritesVisible()) {
        // 第一次 Start: 显示 sprite + unpause + 触发一次 setConfig 立即 spawn
        renderer.setSpritesVisible(true);
        renderer.setPaused(false);
        // 用最后一次 cfg 立即更新 (sprite 会出现在 BridgeAdapter 算好的位置 = home zone)
        if (lastBridgeCfg) onConfigInternal(lastBridgeCfg, /*forceSpawn=*/true);
      } else if (renderer.isPaused()) {
        renderer.setPaused(false);
        // resume: 让下次 onConfig 重算 path; 立即触发一次 (基于最近 cfg)
        if (lastBridgeCfg) onConfigInternal(lastBridgeCfg);
      } else {
        renderer.setPaused(true);
      }
      updateStartBtn();
    });
  }

  // === BridgePoller ===
  let lastAgentCount = -1;
  let lastBridgeCfg = null;

  const onConfigInternal = (cfg, forceSpawn = false) => {
    lastAgents = cfg.agents || [];
    lastBridgeCfg = cfg;

    // v2.13.4: 首次拿到 cfg 时一律按 forceSpawn (从 home zone 出现)
    if (firstSpawnPending) {
      forceSpawn = true;
      firstSpawnPending = false;
    }

    // 路径计算: paused 时不算 (无意义); spritesVisible=false 时也不算 (省点 CPU);
    // forceSpawn 时即便 sprite 还没存在也允许首帧 spawn, path 不重要 (起点=终点)
    const willRender = renderer.areSpritesVisible() && !renderer.isPaused();
    if (mapConfig && willRender) {
      for (const a of lastAgents) {
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

    // 但是: 第一次 spawn (forceSpawn 或 sprite 不存在), BridgeAdapter 已经把 a.x/a.y 算成了 home zone
    // (因为 BridgePoller.setMapConfig 后, adaptToPixelConfig 走 mapConfig 路径)
    // 这时不需要 path, 让 makeAgent 直接放在那里.
    // 注: BridgeAdapter 给 busy 的 agent 算的是 work zone 而不是 home —— 这是 Q 的设计差异.
    // 用户预期: Start 时 sprite 全部从 home 出现, 然后再走到对应状态位置.
    // 实现方式: 在 forceSpawn 时, 先把 a.x/a.y 强制改为 home zone (临时 override),
    // 让 sprite spawn 在 home; 然后下一帧 onConfig 自然会按真实 state 走过去.
    if (forceSpawn && mapConfig) {
      for (const a of lastAgents) {
        const homeCell = getTargetCell(a.name, 'offline', mapConfig); // offline → home
        if (homeCell) {
          const [hx, hy] = cellToPx(homeCell[0], homeCell[1], mapConfig.gridSize);
          a.x = hx;
          a.y = hy;
          a.path = null; // spawn 不走路, 直接出现
        }
      }
    }

    renderer.setConfig(cfg);
    sidebar.setAgents(lastAgents);
    if (composer) composer.setAvailableAgents(lastAgents);
    if (artifactComposer) artifactComposer.setAvailableAgents(lastAgents);

    if (selectedName && !lastAgents.find(a => a.name === selectedName)) {
      setSelected(null);
    }

    if (editor && editor.isOpen()) {
      // global zones 模式下不需要传 agentNames, 但若 editor 内部还引用就保持 fresh
    }

    const n = lastAgents.length;
    const ts = new Date().toLocaleTimeString();
    const runState = renderer.areSpritesVisible() ? (renderer.isPaused() ? 'paused' : 'running') : 'stopped';
    setStatus(`${n} agents — ${runState} — last update ${ts}`, 'ok');
    if (n !== lastAgentCount) lastAgentCount = n;
  };

  const poller = new BridgePoller({
    intervalMs: POLL_INTERVAL_MS,
    onConfig: (cfg) => onConfigInternal(cfg),
    // v2.13.4: 显示连续失败次数, 让用户区分一次抖动 vs 真挂了
    onError: (err, n = 0) => {
      const suffix = n > 1 ? ` (retry ${n})` : '';
      setStatus(`bridge error: ${err.message}${suffix}`, 'error');
    },
  });

  await reloadMapConfig();
  renderer.start();
  setStatus('connecting to bridge...');
  poller.start();
}

main();
