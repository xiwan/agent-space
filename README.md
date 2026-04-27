# Agent Space

Pixel-art AI Agent office — real-time visualization of ACP Bridge agents.

![Agent Space](public/test001.png)

Dual-zone layout: Office (left) + Living Room (right). Agents walk to office when busy, relax in living room when idle.
Responsive: side-by-side on desktop, stacked on mobile. Draggable divider between panels.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

### Production

```bash
npm run build
ACP_BRIDGE_TOKEN=<token> npm run serve
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_URL` | `http://localhost:18010` | ACP Bridge backend URL |
| `ACP_BRIDGE_TOKEN` | *(empty)* | Bearer token for Bridge API auth |
| `PORT` | `5173` | Production server port |

## Tech Stack

- **Phaser 4** — 2D pixel-art game engine
- **Vite** — bundler + dev proxy
- **Express** — production static server + API proxy
- **JavaScript (ES Modules)**
