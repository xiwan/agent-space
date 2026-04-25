/** ChatLog — renders heartbeat chat entries in the right panel (HTML). */
export class ChatLog {
  constructor(containerEl) {
    this.el = containerEl;
    this._lastTs = 0;
  }

  update(client) {
    const chats = client.getRecentChats(600);
    if (!chats.length) return;
    // Only append new entries
    const newChats = chats.filter(c => c.ts > this._lastTs);
    if (!newChats.length) return;
    this._lastTs = Math.max(...chats.map(c => c.ts));

    for (const chat of newChats.reverse()) {
      const div = document.createElement('div');
      div.className = 'chat-entry';
      const time = new Date(chat.ts * 1000).toLocaleTimeString();
      const text = (chat.response || '').slice(0, 120) || '[silent]';
      div.innerHTML = `
        <span class="chat-time">${time}</span>
        <span class="chat-agent">${chat.agent}</span>
        <div class="chat-text">${this._escape(text)}</div>
      `;
      // Insert at top
      this.el.insertBefore(div, this.el.querySelector('.chat-entry'));
    }

    // Trim old entries
    const entries = this.el.querySelectorAll('.chat-entry');
    for (let i = 50; i < entries.length; i++) entries[i].remove();
  }

  _escape(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}
