import { describe, it, expect } from 'vitest';
import { renderTemplate, buildArtifactPayload } from '../src/pixel/ArtifactComposer.js';

describe('renderTemplate', () => {
  it('replaces single {{input}}', () => {
    expect(renderTemplate('Hello {{input}}!', 'world')).toBe('Hello world!');
  });

  it('replaces multiple {{input}} occurrences', () => {
    expect(renderTemplate('{{input}} and {{input}}', 'X')).toBe('X and X');
  });

  it('returns unchanged if no placeholder', () => {
    expect(renderTemplate('no placeholder', 'val')).toBe('no placeholder');
  });
});

describe('buildArtifactPayload', () => {
  const sequenceArtifact = {
    id: 'test-seq',
    mode: 'sequence',
    steps: [
      { agent: 'a1', promptTemplate: 'Step1: {{input}}' },
      { agent: 'a2', promptTemplate: 'Step2: {{input}}' },
    ],
  };

  const conversationArtifact = {
    id: 'test-conv',
    mode: 'conversation',
    agents: ['a1', 'a2', 'a3'],
    minAgents: 2,
    maxTurns: 8,
    promptTemplate: 'Discuss: {{input}}',
  };

  it('throws if artifact is null', () => {
    expect(() => buildArtifactPayload(null, 'hi')).toThrow();
  });

  it('throws if input is empty', () => {
    expect(() => buildArtifactPayload(sequenceArtifact, '')).toThrow();
    expect(() => buildArtifactPayload(sequenceArtifact, '   ')).toThrow();
  });

  it('builds sequence pipeline payload', () => {
    const p = buildArtifactPayload(sequenceArtifact, 'snake game');
    expect(p.endpoint).toBe('/api/pipelines');
    expect(p.body.mode).toBe('sequence');
    expect(p.body.steps).toHaveLength(2);
    expect(p.body.steps[0].agent).toBe('a1');
    expect(p.body.steps[0].prompt).toBe('Step1: snake game');
    expect(p.body.steps[1].prompt).toBe('Step2: snake game');
  });

  it('v2.24.0: returns _uid (8-hex game id) for sequence + conversation', () => {
    const seq = buildArtifactPayload(sequenceArtifact, 'snake game');
    expect(seq._uid).toMatch(/^[0-9a-f]{8}$/);
    const conv = buildArtifactPayload(conversationArtifact, 'AI future');
    expect(conv._uid).toMatch(/^[0-9a-f]{8}$/);
  });

  it('builds conversation payload with default agents', () => {
    const p = buildArtifactPayload(conversationArtifact, 'AI future');
    expect(p.endpoint).toBe('/api/pipelines');
    expect(p.body.mode).toBe('conversation');
    expect(p.body.participants).toEqual(['a1', 'a2', 'a3']);
    expect(p.body.topic).toBe('Discuss: AI future');
    expect(p.body.config.max_turns).toBe(8);
  });

  it('builds conversation payload with selected agents override', () => {
    const p = buildArtifactPayload(conversationArtifact, 'test', ['a1', 'a3']);
    expect(p.body.participants).toEqual(['a1', 'a3']);
  });

  it('falls back to artifact.agents if selectedAgents has < 2', () => {
    const p = buildArtifactPayload(conversationArtifact, 'test', ['a1']);
    expect(p.body.participants).toEqual(['a1', 'a2', 'a3']);
  });

  it('handles parallel mode', () => {
    const art = {
      id: 'par',
      mode: 'parallel',
      steps: [
        { agent: 'x', promptTemplate: '{{input}}' },
        { agent: 'y', promptTemplate: '{{input}}' },
      ],
    };
    const p = buildArtifactPayload(art, 'go');
    expect(p.body.mode).toBe('parallel');
    expect(p.body.steps[0].prompt).toBe('go');
  });
});

// =============================================================================
// v2.19.0: {{uid}} + context + _artifacts (from stashed v2.14.2-WIP)
// =============================================================================

describe('v2.19.0: renderTemplate {{uid}} support', () => {
  it('replaces {{uid}} alongside {{input}}', () => {
    expect(renderTemplate('use {{input}} in {{uid}}', 'snake', 'abc12345'))
      .toBe('use snake in abc12345');
  });

  it('replaces multiple {{uid}} occurrences', () => {
    expect(renderTemplate('{{uid}} and {{uid}}', '', 'xx'))
      .toBe('xx and xx');
  });
});

describe('v2.19.0: buildArtifactPayload {{uid}} + context + _artifacts', () => {
  const makeGameArtifact = {
    id: 'make-game',
    mode: 'sequence',
    context: { shared_cwd: '/tmp/opengame-{{uid}}' },
    steps: [
      { agent: 'harness', promptTemplate: 'plan {{input}}', artifact: { type: 'file', label: 'GDD', pattern: 'gdd.md' } },
      { agent: 'opengame', promptTemplate: 'build', artifact: { type: 'file', label: '游戏', pattern: 'game.html' } },
      { agent: 'kiro', promptTemplate: 'deploy {{uid}}', artifact: { type: 'url', label: 'URL', pattern: 'https://d1x0' } },
    ],
  };

  it('generates 8-char hex uid and uses it in steps + context', () => {
    const p = buildArtifactPayload(makeGameArtifact, 'racing game');
    // step 3 has {{uid}} in template
    const deployPrompt = p.body.steps[2].prompt;
    expect(deployPrompt).toMatch(/^deploy [0-9a-f]{1,8}$/);
    // context.shared_cwd has uid filled
    expect(p.body.context.shared_cwd).toMatch(/^\/tmp\/opengame-[0-9a-f]{1,8}$/);
    // same uid across steps + context
    const uid = deployPrompt.replace(/^deploy /, '');
    expect(p.body.context.shared_cwd).toBe(`/tmp/opengame-${uid}`);
  });

  it('exposes per-step artifact metadata via _artifacts', () => {
    const p = buildArtifactPayload(makeGameArtifact, 'snake');
    expect(p._artifacts).toHaveLength(3);
    expect(p._artifacts[0]).toEqual({ type: 'file', label: 'GDD', pattern: 'gdd.md' });
    expect(p._artifacts[1].pattern).toBe('game.html');
    expect(p._artifacts[2].type).toBe('url');
  });

  it('skips context if artifact has none', () => {
    const noContext = {
      id: 'plain', mode: 'sequence',
      steps: [{ agent: 'a', promptTemplate: '{{input}}' }],
    };
    const p = buildArtifactPayload(noContext, 'hi');
    expect(p.body.context).toBeUndefined();
  });

  it('renders non-string context values as-is', () => {
    const art = {
      id: 'mixed', mode: 'sequence',
      context: { shared_cwd: '/tmp/{{uid}}', timeout: 300, debug: true },
      steps: [{ agent: 'a', promptTemplate: '{{input}}' }],
    };
    const p = buildArtifactPayload(art, 'x');
    expect(p.body.context.shared_cwd).toMatch(/^\/tmp\/[0-9a-f]+$/);
    expect(p.body.context.timeout).toBe(300);
    expect(p.body.context.debug).toBe(true);
  });

  it('_artifacts is null-padded for steps without artifact field', () => {
    const art = {
      id: 'mixed', mode: 'sequence',
      steps: [
        { agent: 'a', promptTemplate: '{{input}}', artifact: { type: 'url', label: 'L', pattern: 'P' } },
        { agent: 'b', promptTemplate: '{{input}}' },  // no artifact
      ],
    };
    const p = buildArtifactPayload(art, 'x');
    expect(p._artifacts).toHaveLength(2);
    expect(p._artifacts[0].type).toBe('url');
    expect(p._artifacts[1]).toBeNull();
  });
});
