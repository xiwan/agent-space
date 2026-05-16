/**
 * Demo Main — Summit Demo entry point
 * Input → Agent call (or local layout) → RoomRenderer
 */
import { RoomRenderer } from './RoomRenderer.js';
import { autoLayout } from './LayoutEngine.js';

const SYSTEM_PROMPT = `你是一个游戏关卡设计师。根据用户描述，输出一个 JSON 格式的游戏环境配置。
严格遵循输出格式，不要输出任何其他内容。只输出 JSON。

输出格式:
{
  "theme": "主题描述",
  "map_size": [12, 9],
  "rooms": [{
    "id": "room_id",
    "type": "office|meeting_room|server_room|living_room",
    "bounds": {"x": 1, "y": 2, "w": 10, "h": 6},
    "items": [{"item": "物品类型"}]
  }]
}

可用物品: desk, monitor, chair, sofa, armchair, table, bookshelf, whiteboard, tv, plant, lamp, floor_lamp, shelf, frame, carpet, cabinet, extinguisher

规则:
- items 只需要列出物品类型，不需要坐标（系统自动布局）
- items 数量 8-15 个
- 根据房间类型选择合适的物品组合`;

const PRESETS = {
  office: [
    { item: "whiteboard" }, { item: "bookshelf" },
    { item: "desk" }, { item: "monitor" }, { item: "chair" },
    { item: "desk" }, { item: "monitor" }, { item: "chair" },
    { item: "sofa" }, { item: "table" },
    { item: "plant" }, { item: "plant" }, { item: "lamp" },
  ],
  meeting: [
    { item: "whiteboard" }, { item: "bookshelf" },
    { item: "desk" }, { item: "monitor" }, { item: "chair" },
    { item: "desk" }, { item: "monitor" }, { item: "chair" },
    { item: "desk" }, { item: "monitor" }, { item: "chair" },
    { item: "plant" }, { item: "plant" },
  ],
  living: [
    { item: "tv" }, { item: "shelf" }, { item: "frame" },
    { item: "sofa" }, { item: "sofa" }, { item: "table" },
    { item: "armchair" },
    { item: "plant" }, { item: "plant" }, { item: "lamp" }, { item: "bookshelf" },
  ],
  server: [
    { item: "cabinet" }, { item: "cabinet" }, { item: "cabinet" },
    { item: "cabinet" }, { item: "cabinet" },
    { item: "desk" }, { item: "monitor" }, { item: "chair" },
    { item: "plant" }, { item: "lamp" },
  ],
};

let renderer = null;
let config = { bridgeUrl: '/api', token: '' };

function init() {
  const canvas = document.getElementById('demo-canvas');
  const input = document.getElementById('prompt-input');
  const seedInput = document.getElementById('seed-input');
  const btn = document.getElementById('generate-btn');
  const status = document.getElementById('status');
  const usageEl = document.getElementById('usage-panel');
  const tokenInput = document.getElementById('token-input');

  renderer = new RoomRenderer(canvas);
  renderer.loadTileset();

  // Load saved config
  try {
    const saved = JSON.parse(localStorage.getItem('agent-space-config') || '{}');
    if (saved.bridgeUrl) config.bridgeUrl = saved.bridgeUrl;
    if (saved.authToken) { config.token = saved.authToken; if (tokenInput) tokenInput.value = config.token; }
  } catch {}

  if (tokenInput) {
    tokenInput.addEventListener('change', () => {
      config.token = tokenInput.value.trim();
      try {
        const saved = JSON.parse(localStorage.getItem('agent-space-config') || '{}');
        saved.authToken = config.token;
        localStorage.setItem('agent-space-config', JSON.stringify(saved));
      } catch {}
    });
  }

  btn.addEventListener('click', () => {
    const seed = parseInt(seedInput.value) || Math.floor(Math.random() * 9999);
    seedInput.value = seed;
    generate(input.value.trim(), seed, status, usageEl);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const seed = parseInt(seedInput.value) || Math.floor(Math.random() * 9999);
      seedInput.value = seed;
      generate(input.value.trim(), seed, status, usageEl);
    }
  });

  // Generate on load
  const initSeed = Math.floor(Math.random() * 9999);
  seedInput.value = initSeed;
  generate('', initSeed, status, usageEl);
}

async function generate(prompt, seed, statusEl, usageEl) {
  statusEl.textContent = '🎨 生成中...';

  // Determine items: try bridge first, fallback to preset
  let items;
  if (prompt && config.token) {
    try {
      const env = await callAgent(prompt);
      items = env.rooms?.[0]?.items || PRESETS.office;
      usageEl.style.display = 'block';
      usageEl.innerHTML = '🤖 Agent 生成';
    } catch (err) {
      statusEl.textContent = `⚠️ Agent 失败，使用本地布局: ${err.message}`;
      items = guessPreset(prompt);
    }
  } else {
    items = guessPreset(prompt);
  }

  // Layout + render
  const mapSize = [12, 9];
  const bounds = { x: 1, y: 2, w: 10, h: 6 };
  const layoutItems = autoLayout(items, bounds, seed);

  const env = {
    map_size: mapSize,
    rooms: [{ id: "room", bounds, items: layoutItems }],
  };

  await renderer.render(env, (msg) => { statusEl.textContent = msg; });
  statusEl.textContent = `✓ 完成 (seed: ${seed}, ${layoutItems.length} 物品)`;
  usageEl.style.display = 'block';
  usageEl.innerHTML = `🎲 seed: ${seed}<br>📦 ${layoutItems.length} items`;
}

function guessPreset(prompt) {
  if (!prompt) return PRESETS.office;
  const p = prompt.toLowerCase();
  if (p.includes('会议') || p.includes('meeting')) return PRESETS.meeting;
  if (p.includes('客厅') || p.includes('living') || p.includes('休息')) return PRESETS.living;
  if (p.includes('服务器') || p.includes('server') || p.includes('机房')) return PRESETS.server;
  return PRESETS.office;
}

async function callAgent(prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`;

  const res = await fetch(`${config.bridgeUrl}/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: `${SYSTEM_PROMPT}\n\n用户描述: ${prompt}` }),
  });

  if (!res.ok) throw new Error(`${res.status}`);
  const job = await res.json();
  const jobId = job.id || job.job_id;
  if (!jobId) return parseEnvJSON(job.result || job.output || job);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`${config.bridgeUrl}/jobs/${jobId}`, { headers });
    if (!pollRes.ok) continue;
    const data = await pollRes.json();
    if (data.status === 'completed' || data.state === 'completed')
      return parseEnvJSON(data.result || data.output);
    if (data.status === 'failed' || data.state === 'failed')
      throw new Error(data.error || 'failed');
  }
  throw new Error('timeout');
}

function parseEnvJSON(raw) {
  if (typeof raw === 'object' && raw.rooms) return raw;
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, str];
  return JSON.parse(match[1].trim());
}

document.addEventListener('DOMContentLoaded', init);
