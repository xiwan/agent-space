/** ChatLog — renders heartbeat chat entries in the right panel (HTML). */
export class ChatLog {
  constructor(containerEl) {
    this.el = containerEl;
    this._lastTs = 0;
  }

  updateFromLogs(logs) {
    const chats = logs.filter(l => !l.silent);
    const newChats = chats.filter(c => c.ts > this._lastTs);
    if (!newChats.length) return;
    this._lastTs = Math.max(...chats.map(c => c.ts));

    for (const chat of newChats.sort((a, b) => a.ts - b.ts)) {
      const div = document.createElement('div');
      div.className = 'chat-entry';
      const time = new Date(chat.ts * 1000).toLocaleTimeString();
      const text = (chat.response || '').slice(0, 200);
      div.innerHTML = `
        <span class="chat-time">${time}</span>
        <span class="chat-agent">${chat.agent}</span>
        <div class="chat-text">${this._escape(text)}</div>
      `;
      this.el.appendChild(div);
    }

    // Trim old entries from top
    const entries = this.el.querySelectorAll('.chat-entry');
    for (let i = 0; i < entries.length - 50; i++) entries[i].remove();

    // Auto-scroll to bottom
    this.el.scrollTop = this.el.scrollHeight;
  }

  _escape(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}
