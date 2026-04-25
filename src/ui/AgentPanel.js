/** AgentPanel — renders agent status list in the right panel (HTML). */
export class AgentPanel {
  constructor(containerEl) {
    this.el = containerEl;
    this._items = {};
  }

  update(client) {
    const names = client.getAgentNames();
    // Remove stale
    for (const name of Object.keys(this._items)) {
      if (!names.includes(name)) {
        this._items[name].remove();
        delete this._items[name];
      }
    }
    // Add / update
    for (const name of names) {
      const state = client.getAgentState(name);
      if (!this._items[name]) {
        const div = document.createElement('div');
        div.className = 'agent-item';
        div.innerHTML = `<span class="agent-dot"></span><span class="agent-name"></span>`;
        this.el.appendChild(div);
        this._items[name] = div;
      }
      const div = this._items[name];
      const dot = div.querySelector('.agent-dot');
      dot.className = `agent-dot dot-${state}`;
      div.querySelector('.agent-name').textContent = `${name} (${state})`;
    }
  }
}
