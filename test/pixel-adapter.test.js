import { describe, it, expect } from 'vitest';
import {
  SPRITE_COUNT,
  deriveStatus,
  defaultSlots,
  adaptToPixelConfig,
} from '../src/pixel/BridgeAdapter.js';

// === 测试夹具 ===
//
// 真实采样自 ACP Bridge (2026-05-18 from localhost:18010, v2.1.0 Phase 2):
// 9 enabled agents, 6 sprite slots, 各种 mode/alive/healthy 组合.

const sampleHealth = () => ({
  status: 'degraded',
  agents: [
    { name: 'kiro',     mode: 'acp', enabled: true, alive: 0, healthy: false },
    { name: 'claude',   mode: 'acp', enabled: true, alive: 0, healthy: false },
    { name: 'codex',    mode: 'pty', enabled: true, alive: 0, healthy: true  },
    { name: 'trae',     mode: 'pty', enabled: true, alive: 0, healthy: true  },
    { name: 'qwen',     mode: 'acp', enabled: true, alive: 0, healthy: false },
    { name: 'opengame', mode: 'acp', enabled: true, alive: 0, healthy: false },
    { name: 'opencode', mode: 'acp', enabled: true, alive: 0, healthy: false },
    { name: 'hermes',   mode: 'acp', enabled: true, alive: 0, healthy: false },
    { name: 'harness',  mode: 'acp', enabled: true, alive: 1, healthy: true  },
  ],
  pool: { active: 1, busy: 0, max: 8 },
  jobs: { pending: 0, running: 0 },
});

const sampleHeartbeat = () => ({
  snapshot: {
    agents: {
      harness:  { busy: 0, idle: 1, description: 'Harness Factory lite', domains: [] },
      kiro:     { busy: 0, idle: 0, description: 'Kiro CLI',     domains: ['coding'] },
      claude:   { busy: 0, idle: 0, description: 'Claude Code',  domains: ['coding'] },
      qwen:     { busy: 0, idle: 0, description: 'Qwen3-Coder',  domains: ['coding'] },
      opengame: { busy: 0, idle: 0, description: 'OpenGame',     domains: ['game']   },
      opencode: { busy: 0, idle: 0, description: 'OpenCode',     domains: ['coding'] },
      hermes:   { busy: 0, idle: 0, description: 'Hermes',       domains: ['coding'] },
    },
  },
});

// /health/agents — per-session 实时 state. 真实样例: harness 1 个 idle session.
const sampleHealthAgents = () => ({
  version: '0.20.1',
  agents: [
    { name: 'kiro',     mode: 'acp', alive_sessions: 0, responsive_sessions: 0, healthy: true,  sessions: [] },
    { name: 'claude',   mode: 'acp', alive_sessions: 0, responsive_sessions: 0, healthy: true,  sessions: [] },
    { name: 'codex',    mode: 'pty', alive_sessions: 0, responsive_sessions: 0, healthy: true,  sessions: [] },
    { name: 'trae',     mode: 'pty', alive_sessions: 0, responsive_sessions: 0, healthy: true,  sessions: [] },
    { name: 'qwen',     mode: 'acp', alive_sessions: 0, responsive_sessions: 0, healthy: false, sessions: [] },
    { name: 'opengame', mode: 'acp', alive_sessions: 0, responsive_sessions: 0, healthy: false, sessions: [] },
    { name: 'opencode', mode: 'acp', alive_sessions: 0, responsive_sessions: 0, healthy: true,  sessions: [] },
    { name: 'hermes',   mode: 'acp', alive_sessions: 0, responsive_sessions: 0, healthy: true,  sessions: [] },
    { name: 'harness',  mode: 'acp', alive_sessions: 1, responsive_sessions: 1, healthy: true,
      sessions: [{ session_id: 's1', alive: true, state: 'idle', idle: 5.0 }] },
  ],
});

// === deriveStatus — 状态判定优先级 ===

describe('deriveStatus', () => {
  it('返回 offline 当 agent 不在 health 列表里', () => {
    expect(deriveStatus('ghost', sampleHealth(), sampleHealthAgents())).toBe('offline');
  });

  it('返回 offline 当 enabled=false', () => {
    const health = sampleHealth();
    health.agents[0].enabled = false;
    expect(deriveStatus('kiro', health, sampleHealthAgents())).toBe('offline');
  });

  it('返回 busy 当 任一 session.state=busy', () => {
    const health = sampleHealth();
    health.agents.find(a => a.name === 'harness').alive = 1;
    const ha = sampleHealthAgents();
    ha.agents.find(a => a.name === 'harness').sessions = [
      { state: 'busy', alive: true },
    ];
    expect(deriveStatus('harness', health, ha)).toBe('busy');
  });

  it('返回 busy 当 多个 session 中只有一个 busy', () => {
    const health = sampleHealth();
    const ha = sampleHealthAgents();
    ha.agents.find(a => a.name === 'harness').alive_sessions = 2;
    ha.agents.find(a => a.name === 'harness').sessions = [
      { state: 'idle', alive: true },
      { state: 'busy', alive: true }, // ← 一个 busy 就算 busy
    ];
    expect(deriveStatus('harness', health, ha)).toBe('busy');
  });

  it('返回 idle 当 alive_sessions>0 且无 busy session', () => {
    expect(deriveStatus('harness', sampleHealth(), sampleHealthAgents())).toBe('idle');
  });

  it('返回 idle 当 alive>0 且 healthAgents 不可用 (兼容 fallback)', () => {
    const health = sampleHealth();
    health.agents.find(a => a.name === 'harness').alive = 1;
    expect(deriveStatus('harness', health, null)).toBe('idle');
  });

  it('REGRESSION: 即使 jobs.running>0 也不会把 alive>0 的 agent 误判成 busy', () => {
    // 旧 bug 1: heartbeat 缺失时 fallback 看 health.pool.busy / jobs.running.
    // 新逻辑: 完全不看全局计数器, 只看 per-session state.
    const health = sampleHealth();
    health.agents.find(a => a.name === 'harness').alive = 1;
    health.jobs.running = 1;
    health.pool.busy = 1;
    expect(deriveStatus('harness', health, sampleHealthAgents())).toBe('idle');
  });

  it('REGRESSION: alive>0 多 agent 场景, 只有 session=busy 的才是 busy', () => {
    // 模拟"顺序执行" — 只有 claude 真的在 busy.
    const health = {
      agents: [
        { name: 'kiro',     mode: 'acp', enabled: true, alive: 1, healthy: true },
        { name: 'claude',   mode: 'acp', enabled: true, alive: 2, healthy: true },
        { name: 'opencode', mode: 'acp', enabled: true, alive: 1, healthy: true },
        { name: 'hermes',   mode: 'acp', enabled: true, alive: 1, healthy: true },
        { name: 'harness',  mode: 'acp', enabled: true, alive: 1, healthy: true },
      ],
      pool: { active: 5, busy: 1 },
      jobs: { running: 1 },
    };
    const ha = {
      agents: [
        { name: 'kiro',     alive_sessions: 1, sessions: [{ state: 'idle' }] },
        { name: 'claude',   alive_sessions: 2, sessions: [{ state: 'busy' }, { state: 'idle' }] },
        { name: 'opencode', alive_sessions: 1, sessions: [{ state: 'idle' }] },
        { name: 'hermes',   alive_sessions: 1, sessions: [{ state: 'idle' }] },
        { name: 'harness',  alive_sessions: 1, sessions: [{ state: 'idle' }] },
      ],
    };
    expect(deriveStatus('claude',   health, ha)).toBe('busy');
    expect(deriveStatus('kiro',     health, ha)).toBe('idle');
    expect(deriveStatus('opencode', health, ha)).toBe('idle');
    expect(deriveStatus('hermes',   health, ha)).toBe('idle');
    expect(deriveStatus('harness',  health, ha)).toBe('idle');
  });

  it('REGRESSION: heartbeat snapshot 的 busy 字段不再被 deriveStatus 使用', () => {
    // 旧 bug 2: heartbeat snapshot 是 5 分钟刷新一次的缓存,
    // 抓不到瞬时 busy. 新逻辑完全不读 snapshot.busy.
    // 这里故意构造 snapshot.busy=99, healthAgents 显示 idle, 应该判 idle.
    const ha = sampleHealthAgents();
    ha.agents.find(a => a.name === 'harness').sessions = [{ state: 'idle' }];
    // 注意: 第 3 个参数是 healthAgents, 不是 heartbeat. heartbeat 不再传入 deriveStatus.
    expect(deriveStatus('harness', sampleHealth(), ha)).toBe('idle');
  });

  it('返回 offline 当 mode=acp 且 alive=0 (lazy-start 常态, 即使 healthy=false)', () => {
    expect(deriveStatus('kiro', sampleHealth(), sampleHealthAgents())).toBe('offline');
  });

  it('返回 error 当 mode=pty 且 alive=0 且 healthy=false (常驻进程故障)', () => {
    const health = sampleHealth();
    health.agents.find(a => a.name === 'codex').healthy = false;
    expect(deriveStatus('codex', health, sampleHealthAgents())).toBe('error');
  });

  it('返回 offline 当 mode=pty 且 alive=0 但 healthy=true (尚未拉起, 不是故障)', () => {
    expect(deriveStatus('codex', sampleHealth(), sampleHealthAgents())).toBe('offline');
  });
});

// === defaultSlots — 布局生成 ===

describe('defaultSlots', () => {
  it('office 区 baseY=400', () => {
    const slots = defaultSlots('office', 1);
    expect(slots[0].y).toBe(400);
  });

  it('reception 区 baseY=700', () => {
    const slots = defaultSlots('reception', 1);
    expect(slots[0].y).toBe(700);
  });

  it('5 列后换行, 每行 +60', () => {
    const slots = defaultSlots('office', 6);
    expect(slots[5].x).toBe(120); // 第二行第一列, x 复位
    expect(slots[5].y).toBe(460); // 400 + 60
  });

  it('返回正确数量', () => {
    expect(defaultSlots('office', 0)).toHaveLength(0);
    expect(defaultSlots('office', 9)).toHaveLength(9);
  });
});

// === adaptToPixelConfig — 主适配 ===

describe('adaptToPixelConfig', () => {
  it('过滤 enabled=false 的 agent', () => {
    const health = sampleHealth();
    health.agents.find(a => a.name === 'kiro').enabled = false;
    const cfg = adaptToPixelConfig(health, sampleHeartbeat(), sampleHealthAgents());
    expect(cfg.agents.find(a => a.name === 'kiro')).toBeUndefined();
    expect(cfg.agents).toHaveLength(8);
  });

  it('agents 按 name 字典序排序', () => {
    const cfg = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    const names = cfg.agents.map(a => a.name);
    expect(names).toEqual([...names].sort());
  });

  it('前 SPRITE_COUNT (6) 个 agent 各占一个 sprite', () => {
    const cfg = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    const colors = cfg.agents.slice(0, SPRITE_COUNT).map(a => a.color);
    expect(new Set(colors).size).toBe(SPRITE_COUNT);
  });

  it('第 7 个起循环 sprite (idx % 6)', () => {
    const cfg = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    cfg.agents.forEach((a, idx) => {
      expect(a.color).toBe(idx % SPRITE_COUNT);
    });
  });

  it('busy agent 在 office 区 (baseY=400)', () => {
    const health = sampleHealth();
    health.agents.find(a => a.name === 'harness').alive = 1;
    const ha = sampleHealthAgents();
    ha.agents.find(a => a.name === 'harness').sessions = [{ state: 'busy' }];
    const cfg = adaptToPixelConfig(health, sampleHeartbeat(), ha);
    const harness = cfg.agents.find(a => a.name === 'harness');
    expect(harness.state).toBe('busy');
    expect(harness.y).toBe(400);
  });

  it('idle agent 在 reception 区 (baseY=700)', () => {
    const cfg = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    const harness = cfg.agents.find(a => a.name === 'harness');
    expect(harness.state).toBe('idle');
    expect(harness.y).toBe(700);
  });

  it('error agent 在 office 区 (与 busy 同区)', () => {
    const health = sampleHealth();
    health.agents.find(a => a.name === 'codex').healthy = false;
    const cfg = adaptToPixelConfig(health, sampleHeartbeat(), sampleHealthAgents());
    const codex = cfg.agents.find(a => a.name === 'codex');
    expect(codex.state).toBe('error');
    expect(codex.y).toBe(400);
  });

  it('active 字段反映 state !== offline', () => {
    const cfg = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    cfg.agents.forEach(a => {
      expect(a.active).toBe(a.state !== 'offline');
    });
  });

  it('从 heartbeat 提取 description / domains', () => {
    const cfg = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    const kiro = cfg.agents.find(a => a.name === 'kiro');
    expect(kiro.description).toBe('Kiro CLI');
    expect(kiro.domains).toEqual(['coding']);
  });

  it('heartbeat 缺失时 description / domains 兜底为空', () => {
    const cfg = adaptToPixelConfig(sampleHealth(), null, sampleHealthAgents());
    cfg.agents.forEach(a => {
      expect(a.description).toBe('');
      expect(a.domains).toEqual([]);
    });
  });

  it('空 health.agents 列表返回空 agents 数组', () => {
    const cfg = adaptToPixelConfig({ agents: [] }, sampleHeartbeat(), sampleHealthAgents());
    expect(cfg.agents).toHaveLength(0);
    expect(cfg.rooms).toHaveLength(2);
  });

  it('rooms 始终返回 Office 和 Reception', () => {
    const cfg = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    expect(cfg.rooms).toEqual([
      { name: 'Office',    x: 320, y: 400 },
      { name: 'Reception', x: 320, y: 700 },
    ]);
  });

  it('多次调用同一份输入产生稳定结果 (sprite 分配确定性)', () => {
    const cfg1 = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    const cfg2 = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    expect(cfg2.agents.map(a => [a.name, a.color, a.x, a.y]))
      .toEqual(cfg1.agents.map(a => [a.name, a.color, a.x, a.y]));
  });

  it('真实 9-agent 状态分布: harness=idle, 其余=offline', () => {
    const cfg = adaptToPixelConfig(sampleHealth(), sampleHeartbeat(), sampleHealthAgents());
    const counts = cfg.agents.reduce((acc, a) => {
      acc[a.state] = (acc[a.state] || 0) + 1;
      return acc;
    }, {});
    expect(counts.idle).toBe(1);
    expect(counts.offline).toBe(8);
    expect(counts.error).toBeUndefined();
    expect(counts.busy).toBeUndefined();
  });

  it('REGRESSION: 顺序执行场景 — 只有 claude 1 个 agent 是 busy, 其他都不是', () => {
    // 这是 v2.1.0 截图 bug 的反例: 旧逻辑用 pool.busy 全局兜底导致多个 BUSY.
    const health = {
      agents: [
        { name: 'kiro',     mode: 'acp', enabled: true, alive: 1, healthy: true },
        { name: 'claude',   mode: 'acp', enabled: true, alive: 2, healthy: true },
        { name: 'opencode', mode: 'acp', enabled: true, alive: 1, healthy: true },
        { name: 'hermes',   mode: 'acp', enabled: true, alive: 1, healthy: true },
        { name: 'harness',  mode: 'acp', enabled: true, alive: 1, healthy: true },
      ],
      pool: { busy: 1 },
      jobs: { running: 1 },
    };
    const ha = {
      agents: [
        { name: 'kiro',     alive_sessions: 1, sessions: [{ state: 'idle' }] },
        { name: 'claude',   alive_sessions: 2, sessions: [{ state: 'idle' }, { state: 'busy' }] },
        { name: 'opencode', alive_sessions: 1, sessions: [{ state: 'idle' }] },
        { name: 'hermes',   alive_sessions: 1, sessions: [{ state: 'idle' }] },
        { name: 'harness',  alive_sessions: 1, sessions: [{ state: 'idle' }] },
      ],
    };
    const cfg = adaptToPixelConfig(health, null, ha);
    const counts = cfg.agents.reduce((acc, a) => {
      acc[a.state] = (acc[a.state] || 0) + 1;
      return acc;
    }, {});
    expect(counts.busy).toBe(1);
    expect(counts.idle).toBe(4);
    expect(cfg.agents.find(a => a.name === 'claude').state).toBe('busy');
  });
});
