import Phaser from 'phaser';
import config from '../config.js';

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    if (!config.bridgeToken) {
      this.showConfigDialog();
    } else {
      this.scene.start('Office');
    }
  }

  showConfigDialog() {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.8)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '9999', fontFamily: 'monospace',
    });

    overlay.innerHTML = `
      <div style="background:#2b2b3d;padding:24px;border-radius:8px;color:#ccc;width:340px">
        <h3 style="margin:0 0 16px;color:#fff">🏢 Agent Space</h3>
        <label style="display:block;margin-bottom:4px;font-size:12px">Bridge URL</label>
        <input id="as-url" value="${config.bridgeUrl}"
          style="width:100%;padding:6px;margin-bottom:12px;background:#1a1a2e;color:#fff;border:1px solid #555;border-radius:4px;font-family:monospace" />
        <label style="display:block;margin-bottom:4px;font-size:12px">Token</label>
        <input id="as-token" type="password" placeholder="ACP_BRIDGE_TOKEN"
          style="width:100%;padding:6px;margin-bottom:16px;background:#1a1a2e;color:#fff;border:1px solid #555;border-radius:4px;font-family:monospace" />
        <button id="as-go"
          style="width:100%;padding:8px;background:#44aa44;color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:monospace">
          Connect
        </button>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('as-go').addEventListener('click', () => {
      const url = document.getElementById('as-url').value.trim();
      const token = document.getElementById('as-token').value.trim();
      if (!token) return;
      localStorage.setItem('bridge_url', url);
      localStorage.setItem('bridge_token', token);
      overlay.remove();
      this.scene.start('Office');
    });
  }
}
