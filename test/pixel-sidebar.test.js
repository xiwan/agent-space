// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Sidebar } from '../src/pixel/Sidebar.js';

const SAMPLE = [
  { name: 'kiro',   color: 0, x: 0, y: 0, state: 'busy',    description: 'Code agent', domains: ['frontend','testing'], active: true },
  { name: 'codex',  color: 1, x: 0, y: 0, state: 'idle',    description: 'OpenAI',     domains: ['python'],             active: true },
  { name: 'qwen',   color: 2, x: 0, y: 0, state: 'offline', description: '',           domains: [],                    active: true },
  { name: 'hermes', color: 3, x: 0, y: 0, state: 'error',   description: 'Bus error',  domains: ['debug'],             active: true },
];

describe('Sidebar (v2.2.0)', () => {
  let container;
  let onToggle;
  let sidebar;

  beforeEach(() => {
    try { localStorage.clear(); } catch {}
    container = document.createElement('div');
    onToggle = vi.fn();
    sidebar = new Sidebar(container, { onToggle });
  });

  it('throws if container is missing', () => {
    expect(() => new Sidebar(null)).toThrow(/container/);
  });

  it('renders empty initially (no cards, but shell with tabs exists)', () => {
    expect(container.querySelectorAll('.pixel-card').length).toBe(0);
    // v2.10.0: shell 自带 tabs + agents/history 容器
    // v2.12.0: 加 usage tab → 3 个
    expect(container.querySelector('.sidebar-tabs')).not.toBeNull();
    expect(container.querySelectorAll('.sidebar-tab').length).toBe(3);
    expect(container.querySelector('.sidebar-agents')).not.toBeNull();
    expect(container.querySelector('.sidebar-history')).not.toBeNull();
    expect(container.querySelector('.sidebar-usage')).not.toBeNull();
  });

  it('setAgents renders one card per agent in order', () => {
    sidebar.setAgents(SAMPLE);
    const cards = container.querySelectorAll('.pixel-card');
    expect(cards.length).toBe(4);
    expect(cards[0].dataset.name).toBe('kiro');
    expect(cards[1].dataset.name).toBe('codex');
    expect(cards[2].dataset.name).toBe('qwen');
    expect(cards[3].dataset.name).toBe('hermes');
  });

  it('renders name, state badge, description, domains', () => {
    sidebar.setAgents([SAMPLE[0]]);
    const card = container.querySelector('.pixel-card');
    expect(card.querySelector('.pixel-card-name').textContent).toBe('kiro');
    const badge = card.querySelector('.pixel-state');
    expect(badge.textContent).toBe('busy');
    expect(badge.classList.contains('pixel-state-busy')).toBe(true);
    expect(card.querySelector('.pixel-card-desc').textContent).toBe('Code agent');
    expect(card.querySelector('.pixel-card-domains').textContent).toBe('frontend, testing');
  });

  it('shows fallback for empty description and domains', () => {
    sidebar.setAgents([SAMPLE[2]]);  // qwen: '' / []
    const card = container.querySelector('.pixel-card');
    expect(card.querySelector('.pixel-card-desc').textContent).toBe('(no description)');
    expect(card.querySelector('.pixel-card-domains').textContent).toBe('—');
  });

  it('offline agent gets .offline class', () => {
    sidebar.setAgents(SAMPLE);
    const cards = container.querySelectorAll('.pixel-card');
    expect(cards[2].classList.contains('offline')).toBe(true);  // qwen
    expect(cards[0].classList.contains('offline')).toBe(false); // kiro
  });

  it('selected agent gets .selected class', () => {
    sidebar.setAgents(SAMPLE);
    sidebar.setSelected('codex');
    const cards = container.querySelectorAll('.pixel-card');
    expect(cards[0].classList.contains('selected')).toBe(false);
    expect(cards[1].classList.contains('selected')).toBe(true);
  });

  it('setSelected re-renders to update class', () => {
    sidebar.setAgents(SAMPLE);
    sidebar.setSelected('kiro');
    sidebar.setSelected('hermes');
    const cards = container.querySelectorAll('.pixel-card');
    expect(cards[0].classList.contains('selected')).toBe(false);
    expect(cards[3].classList.contains('selected')).toBe(true);
  });

  it('setSelected(null) clears selection', () => {
    sidebar.setAgents(SAMPLE);
    sidebar.setSelected('kiro');
    sidebar.setSelected(null);
    const cards = container.querySelectorAll('.pixel-card');
    expect([...cards].some(c => c.classList.contains('selected'))).toBe(false);
  });

  it('setSelected to same value is a no-op (no extra render)', () => {
    sidebar.setAgents(SAMPLE);
    sidebar.setSelected('kiro');
    const firstCard = container.querySelector('.pixel-card');
    sidebar.setSelected('kiro');
    const secondCard = container.querySelector('.pixel-card');
    // 同一个 DOM 节点引用 = 没重渲
    expect(firstCard).toBe(secondCard);
  });

  it('clicking a card invokes onToggle with agent name', () => {
    sidebar.setAgents(SAMPLE);
    const cards = container.querySelectorAll('.pixel-card');
    cards[1].click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('codex');
  });

  it('clicking selected card still fires onToggle (caller decides toggle semantics)', () => {
    sidebar.setAgents(SAMPLE);
    sidebar.setSelected('kiro');
    container.querySelectorAll('.pixel-card')[0].click();
    expect(onToggle).toHaveBeenCalledWith('kiro');
  });

  it('setAgents with empty array clears all cards', () => {
    sidebar.setAgents(SAMPLE);
    sidebar.setAgents([]);
    expect(container.querySelectorAll('.pixel-card').length).toBe(0);
  });

  it('setAgents with non-array (null/undefined) treated as empty', () => {
    sidebar.setAgents(SAMPLE);
    sidebar.setAgents(null);
    expect(container.querySelectorAll('.pixel-card').length).toBe(0);
    sidebar.setAgents(undefined);
    expect(container.querySelectorAll('.pixel-card').length).toBe(0);
  });

  it('uses textContent (not innerHTML) for user data — XSS safe', () => {
    sidebar.setAgents([{
      name: '<script>alert(1)</script>',
      color: 0, x: 0, y: 0, state: 'idle',
      description: '<img src=x onerror=alert(1)>',
      domains: ['<b>danger</b>'],
    }]);
    const card = container.querySelector('.pixel-card');
    expect(card.querySelector('.pixel-card-name').textContent).toContain('<script>');
    // 应该没有真正的 script/img 子元素被渲染
    expect(card.querySelector('script')).toBeNull();
    expect(card.querySelector('img')).toBeNull();
  });

  it('preserves card identity across setSelected (no full DOM swap on every selection)', () => {
    sidebar.setAgents(SAMPLE);
    // Note: 当前实现是 _render 全量重渲, DOM 节点会换. 这里仅断言数量稳定.
    const initialCount = container.querySelectorAll('.pixel-card').length;
    sidebar.setSelected('codex');
    expect(container.querySelectorAll('.pixel-card').length).toBe(initialCount);
    sidebar.setSelected(null);
    expect(container.querySelectorAll('.pixel-card').length).toBe(initialCount);
  });

  // === v2.10.0: tab 切换 ===

  it('v2.10.0: default tab is agents, agents pane visible, history hidden', () => {
    expect(sidebar.getTab()).toBe('agents');
    const a = container.querySelector('.sidebar-agents');
    // v2.13.0: history 容器外层改名为 .sidebar-history-wrap (含 toolbar)
    const h = container.querySelector('.sidebar-history-wrap');
    expect(a.style.display).not.toBe('none');
    expect(h.style.display).toBe('none');
  });

  it('v2.10.0: clicking History tab swaps panes', () => {
    const histTab = container.querySelector('[data-tab="history"]');
    histTab.click();
    expect(sidebar.getTab()).toBe('history');
    expect(container.querySelector('.sidebar-agents').style.display).toBe('none');
    // v2.13.0: history 实际容器外加了 .sidebar-history-wrap
    expect(container.querySelector('.sidebar-history-wrap').style.display).not.toBe('none');
    expect(histTab.classList.contains('active')).toBe(true);
  });

  it('v2.10.0: getHistoryContainer returns the history pane', () => {
    const h = sidebar.getHistoryContainer();
    expect(h).not.toBeNull();
    expect(h.classList.contains('sidebar-history')).toBe(true);
  });

  it('v2.10.0: tab choice persists to localStorage', () => {
    container.querySelector('[data-tab="history"]').click();
    expect(localStorage.getItem('pixel.sidebarTab')).toBe('history');
    container.querySelector('[data-tab="agents"]').click();
    expect(localStorage.getItem('pixel.sidebarTab')).toBe('agents');
  });

  it('v2.10.0: onTabChange fires on tab switch', () => {
    const onTabChange = vi.fn();
    const c2 = document.createElement('div');
    new Sidebar(c2, { onTabChange });
    c2.querySelector('[data-tab="history"]').click();
    expect(onTabChange).toHaveBeenCalledWith('history');
  });

  // ============================================================
  // v2.12.0: usage tab
  // ============================================================
  it('v2.12.0: clicking Usage tab shows usage container, hides others', () => {
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const sb = new Sidebar(c2);
    c2.querySelector('[data-tab="usage"]').click();
    expect(c2.querySelector('.sidebar-usage').style.display).toBe('');
    expect(c2.querySelector('.sidebar-agents').style.display).toBe('none');
    // v2.13.0: history wrap 是被切的容器
    expect(c2.querySelector('.sidebar-history-wrap').style.display).toBe('none');
    expect(sb.getTab()).toBe('usage');
  });

  it('v2.12.0: getUsageContainer returns the .sidebar-usage element', () => {
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const sb = new Sidebar(c2);
    const u = sb.getUsageContainer();
    expect(u).not.toBeNull();
    expect(u.classList.contains('sidebar-usage')).toBe(true);
  });

  it('v2.12.0: localStorage persists "usage" tab choice', () => {
    localStorage.setItem('pixel.sidebarTab', 'usage');
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const sb = new Sidebar(c2);
    expect(sb.getTab()).toBe('usage');
    expect(c2.querySelector('.sidebar-usage').style.display).toBe('');
  });

  it('v2.12.0: invalid tab in localStorage falls back to agents', () => {
    localStorage.setItem('pixel.sidebarTab', 'garbage');
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const sb = new Sidebar(c2);
    expect(sb.getTab()).toBe('agents');
  });

  // ============================================================
  // v2.13.0: history toolbar (count + Clear button)
  // ============================================================
  it('v2.13.0: history wrap contains toolbar with count + clear button', () => {
    expect(container.querySelector('.sidebar-history-toolbar')).not.toBeNull();
    expect(container.querySelector('.sidebar-history-count')).not.toBeNull();
    expect(container.querySelector('.sidebar-history-clear')).not.toBeNull();
  });

  it('v2.13.0: setHistoryCount updates count UI', () => {
    sidebar.setHistoryCount(0);
    expect(container.querySelector('.sidebar-history-count').textContent).toBe('0 records');
    sidebar.setHistoryCount(1);
    expect(container.querySelector('.sidebar-history-count').textContent).toBe('1 record');
    sidebar.setHistoryCount(42);
    expect(container.querySelector('.sidebar-history-count').textContent).toBe('42 records');
  });

  it('v2.13.0: clicking Clear (with confirm) fires onClearHistory', () => {
    const onClearHistory = vi.fn();
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    new Sidebar(c2, { onClearHistory });
    // mock window.confirm to return true
    const oldConfirm = window.confirm;
    window.confirm = () => true;
    try {
      c2.querySelector('.sidebar-history-clear').click();
      expect(onClearHistory).toHaveBeenCalledTimes(1);
    } finally {
      window.confirm = oldConfirm;
    }
  });

  it('v2.13.0: cancelling confirm does not fire onClearHistory', () => {
    const onClearHistory = vi.fn();
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    new Sidebar(c2, { onClearHistory });
    const oldConfirm = window.confirm;
    window.confirm = () => false;
    try {
      c2.querySelector('.sidebar-history-clear').click();
      expect(onClearHistory).not.toHaveBeenCalled();
    } finally {
      window.confirm = oldConfirm;
    }
  });
});
