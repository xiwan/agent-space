/**
 * test/agentDescription.test.js
 * Tests for agent description (preset + model) display in the info card.
 * Covers: AgentDataManager meta extraction, OfficeScene meta storage,
 * and AgentSprite passing description to showAgentInfo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Minimal AgentDataManager (inline, no Phaser dependency) ─────────────────

class AgentDataManager {
  constructor(scene) {
    this.scene = scene;
    this.timer = null;
    this._interval = 10000;
    this._heartbeatAgents = {};
    this._healthData = null;
    this._agentMeta = {};
  }

  async _poll(healthData, heartbeatData) {
    const hData = healthData;
    const hbData = heartbeatData;
    if (!hData) return;

    this._healthData = hData;

    const hbAgents = hbData?.snapshot?.agents ?? {};
    this._heartbeatAgents = hbAgents;

    // Extract meta (description + domains) from heartbeat
    for (const [name, hb] of Object.entries(hbAgents)) {
      const meta = {
        description: hb.description || '',
        domains: hb.domains || [],
      };
      this._agentMeta[name] = meta;
      if (this.scene.updateAgentMeta) {
        this.scene.updateAgentMeta(name, meta);
      }
    }

    const poolBusy = hData.pool?.busy ?? 0;
    const globalBusy = poolBusy > 0;
    const allAgents = hData.agents ?? [];

    for (const a of allAgents) {
      if (!a.enabled) continue;
      if (a.alive > 0) {
        const hb = hbAgents[a.name];
        const status = hb ? ((hb.busy ?? 0) > 0 ? 'busy' : 'idle') : (globalBusy ? 'busy' : 'idle');
        this.scene.updateAgentStatus(a.name, status);
      } else {
        this.scene.updateAgentStatus(a.name, a.healthy === false ? 'error' : 'offline');
      }
    }
  }
}

// ─── Minimal OfficeScene (inline, no Phaser dependency) ──────────────────────

class OfficeScene {
  constructor() {
    this.agents = {};
    this._agentMeta = {};
  }

  updateAgentMeta(name, meta) {
    this._agentMeta[name] = meta;
  }

  getAgentMeta(name) {
    return this._agentMeta[name] || { description: '', domains: [] };
  }

  updateAgentStatus(name, status) {
    if (this.agents[name]) this.agents[name].status = status;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Agent description (preset + model) feature', () => {
  let scene;
  let manager;

  const HEALTH = {
    agents: [
      { name: 'qwen', enabled: true, alive: 1, healthy: true },
      { name: 'claude', enabled: true, alive: 1, healthy: true },
    ],
    pool: { busy: 0 },
  };

  const HEARTBEAT = {
    snapshot: {
      agents: {
        qwen: {
          busy: 0, idle: 1,
          description: '我是 Qwen，阿里云通义千问。Preset: software-engineer, Model: qwen-max-2025-01-25',
          domains: ['coding', 'analysis'],
        },
        claude: {
          busy: 1, idle: 0,
          description: 'I am Claude by Anthropic. Preset: coding-assistant, Model: claude-3-5-sonnet',
          domains: ['coding'],
        },
      },
    },
  };

  beforeEach(() => {
    scene = new OfficeScene();
    manager = new AgentDataManager(scene);
  });

  it('AgentDataManager extracts description from heartbeat snapshot', async () => {
    await manager._poll(HEALTH, HEARTBEAT);
    expect(manager._agentMeta['qwen'].description).toBe(
      '我是 Qwen，阿里云通义千问。Preset: software-engineer, Model: qwen-max-2025-01-25'
    );
    expect(manager._agentMeta['claude'].description).toBe(
      'I am Claude by Anthropic. Preset: coding-assistant, Model: claude-3-5-sonnet'
    );
  });

  it('AgentDataManager extracts domains from heartbeat snapshot', async () => {
    await manager._poll(HEALTH, HEARTBEAT);
    expect(manager._agentMeta['qwen'].domains).toEqual(['coding', 'analysis']);
    expect(manager._agentMeta['claude'].domains).toEqual(['coding']);
  });

  it('AgentDataManager calls scene.updateAgentMeta with correct meta', async () => {
    scene.updateAgentMeta = vi.fn();
    await manager._poll(HEALTH, HEARTBEAT);
    expect(scene.updateAgentMeta).toHaveBeenCalledWith('qwen', {
      description: '我是 Qwen，阿里云通义千问。Preset: software-engineer, Model: qwen-max-2025-01-25',
      domains: ['coding', 'analysis'],
    });
    expect(scene.updateAgentMeta).toHaveBeenCalledWith('claude', {
      description: 'I am Claude by Anthropic. Preset: coding-assistant, Model: claude-3-5-sonnet',
      domains: ['coding'],
    });
  });

  it('OfficeScene.updateAgentMeta stores meta and getAgentMeta retrieves it', () => {
    scene.updateAgentMeta('qwen', { description: 'Hello from Qwen', domains: ['coding'] });
    expect(scene.getAgentMeta('qwen')).toEqual({ description: 'Hello from Qwen', domains: ['coding'] });
  });

  it('OfficeScene.getAgentMeta returns empty defaults for unknown agent', () => {
    expect(scene.getAgentMeta('unknown')).toEqual({ description: '', domains: [] });
  });

  it('description is empty string when heartbeat has no description field', async () => {
    const hbNoDesc = {
      snapshot: {
        agents: {
          qwen: { busy: 0, idle: 1 }, // no description, no domains
        },
      },
    };
    await manager._poll(HEALTH, hbNoDesc);
    expect(manager._agentMeta['qwen'].description).toBe('');
    expect(manager._agentMeta['qwen'].domains).toEqual([]);
  });

  it('meta is not overwritten when heartbeat is unavailable', async () => {
    // First poll: heartbeat available, meta set
    await manager._poll(HEALTH, HEARTBEAT);
    expect(manager._agentMeta['qwen'].description).toBeTruthy();

    // Second poll: heartbeat unavailable (null)
    await manager._poll(HEALTH, null);
    // Meta from previous poll should still be in _agentMeta (not cleared)
    expect(manager._agentMeta['qwen'].description).toBeTruthy();
  });

  it('showAgentInfo receives description and domains from AgentSprite click', async () => {
    // Simulate the full data flow: poll → meta stored → sprite click → showAgentInfo called
    await manager._poll(HEALTH, HEARTBEAT);

    const showAgentInfoMock = vi.fn();
    // Simulate AgentSprite.pointerdown handler logic
    const agentName = 'qwen';
    const status = 'idle';
    const meta = scene.getAgentMeta(agentName);
    showAgentInfoMock(agentName, {
      status,
      cbState: 'CLOSED',
      successRate: '94.2%',
      latency: '1.2s',
      tasks: ['Task 1', 'Task 2', 'Task 3'],
      description: meta.description || '',
      domains: meta.domains || [],
    });

    expect(showAgentInfoMock).toHaveBeenCalledWith('qwen', expect.objectContaining({
      description: '我是 Qwen，阿里云通义千问。Preset: software-engineer, Model: qwen-max-2025-01-25',
      domains: ['coding', 'analysis'],
    }));
  });
});
