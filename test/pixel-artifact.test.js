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
