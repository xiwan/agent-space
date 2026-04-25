# Agent Space — 设计文档

> 像素风格的 AI Agent 可视化办公室，实时展示 ACP Bridge 中各 agent 的工作状态。

## 愿景

一个星露谷物语美术风格的像素办公室，每个 AI agent 是一个像素小人，坐在自己的工位上。用户打开网页就能看到：谁在忙、谁在摸鱼、谁在和谁聊天 — 像一个真实的办公室一样有生命力。

## 定位

- **独立项目**，不依赖 ACP Bridge 代码，仅通过 HTTP API 获取数据
- **纯前端**，无后端，静态部署即可（GitHub Pages / S3 / Nginx）
- **观赏优先**，第一阶段不做交互，像一个实时的像素动画窗口
- **移动端友好**，响应式布局，手机上也能看

## 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 游戏引擎 | **Phaser 3** | 2D tilemap 原生支持、精灵动画、图层管理，星露谷风格最合适 |
| 打包 | **Vite** | 快速 HMR，Phaser 生态兼容好 |
| 语言 | **JavaScript (ES Modules)** | 简单直接，前期不需要 TypeScript |
| 美术 | **占位符 → 逐步替换** | 先用色块/简单像素，后期可换正式美术 |

## 美术风格

- **星露谷物语**风格：16-bit 像素、暖色调、柔和光影
- Tile 尺寸：**32×32 px**
- 角色尺寸：**32×48 px**（32 宽，48 高，比 tile 略高）
- 视角：**俯视 45°**（经典 RPG 俯视角）
- 气泡文字：**英文**，像素字体

---

## ACP Bridge 对接协议

### 数据源

Agent Space 通过轮询 ACP Bridge HTTP API 获取所有状态数据，无 WebSocket 依赖。

| API | 方法 | 用途 | 轮询频率 |
|-----|------|------|----------|
| `/health` | GET | agent 列表、在线/离线、busy/idle 计数、进程池状态 | 10s |
| `/heartbeat` | GET | 心跳启用的 agent 集合、环境快照 | 10s |
| `/heartbeat/logs` | GET | 最近 50 条心跳对话记录（含 agent、response、silent、duration） | 10s |
| `/stats` | GET | 每个 agent 的调用统计（成功率、平均耗时、工具使用） | 30s |

### 认证

所有请求需携带 Bearer token：

```
Authorization: Bearer <ACP_BRIDGE_TOKEN>
```

Token 由用户首次打开时输入，存入 `localStorage`。

### `/health` 响应结构

这是核心数据源，决定 agent 列表和状态。

```json
{
  "status": "healthy",
  "version": "0.18.2",
  "uptime": 3600,
  "uptime_human": "1h 0m",
  "agents": [
    {
      "name": "kiro",
      "mode": "acp",
      "enabled": true,
      "alive": 1,
      "healthy": true
    },
    {
      "name": "claude",
      "mode": "acp",
      "enabled": true,
      "alive": 2,
      "healthy": true
    }
  ],
  "pool": {
    "active": 7,
    "busy": 2,
    "max": 8,
    "memory_used_pct": 57.3
  }
}
```

**状态映射规则：**

| 条件 | Agent Space 状态 | 视觉 |
|------|-----------------|------|
| `enabled=false` | hidden | 不显示 |
| `enabled=true, alive=0` | offline | 空椅子，电脑灰屏 |
| `enabled=true, alive>0, healthy=false` | error | 角色在，电脑冒烟 ❌ |
| `alive>0, healthy=true` + pool 中该 agent busy>0 | busy | 打字动画 ⚡ |
| `alive>0, healthy=true` + pool 中该 agent busy=0 | idle | 坐着发呆/伸懒腰 |

注意：`/health` 的 `pool.busy` 是全局计数，不区分 agent。需要结合 `/heartbeat` 的 per-agent snapshot 判断具体哪个 agent 在 busy。

### `/heartbeat` 响应结构

提供 per-agent 的 busy/idle 细分。

```json
{
  "enabled_agents": ["claude", "harness", "hermes", "opencode", "qwen"],
  "snapshot": {
    "agents": {
      "claude": { "busy": 0, "idle": 1, "description": "...", "domains": [] },
      "harness": { "busy": 1, "idle": 0, "description": "...", "domains": [] },
      "qwen": { "busy": 0, "idle": 1, "description": "...", "domains": [] }
    },
    "ts": 1745582400.0
  }
}
```

**状态判断优先级：**

```
if agent in snapshot.agents:
    if agent.busy > 0 → busy
    else → idle
else:
    # 不在 snapshot 中但 health 显示 alive → idle（非心跳 agent）
    fallback to /health 的 alive 字段
```

### `/heartbeat/logs` 响应结构

驱动对话气泡显示。

```json
{
  "total": 15,
  "logs": [
    {
      "ts": 1745582400.0,
      "agent": "claude",
      "silent": false,
      "duration": 12.7,
      "response": "I'll help qwen with the trace.py tests...",
      "prompt_preview": "[HEARTBEAT] You are 'claude'..."
    },
    {
      "ts": 1745582395.0,
      "agent": "harness",
      "silent": true,
      "duration": 1.5,
      "response": null,
      "prompt_preview": "..."
    }
  ]
}
```

**气泡规则：**
- `silent=true` → 不显示气泡
- `silent=false` → 显示 `response` 前 60 字符（英文），像素气泡，2-3 秒后淡出
- 按 `ts` 排序，只显示最近 5 分钟内的非 silent 记录
- 同一 agent 新消息覆盖旧气泡

### `/stats` 响应结构（可选，Phase 2+）

用于未来的详情面板。

```json
{
  "agents": {
    "claude": {
      "total": 42,
      "success": 40,
      "fail": 2,
      "avg_duration": 15.3,
      "top_tools": ["Read", "Write", "Bash"]
    }
  }
}
```

### 轮询策略

```
┌─────────────────────────────────────────┐
│           BridgeClient                   │
│                                          │
│  每 10s:                                 │
│    GET /health      → agentList, status  │
│    GET /heartbeat   → busy/idle detail   │
│    GET /heartbeat/logs → chat bubbles    │
│                                          │
│  每 30s:                                 │
│    GET /stats       → (Phase 2)          │
│                                          │
│  错误处理:                                │
│    连续 3 次失败 → 显示断线 UI            │
│    恢复后自动重连                         │
└─────────────────────────────────────────┘
```

**CORS 注意：** ACP Bridge 需要允许 Agent Space 的 origin。如果同机部署（localhost），无问题。跨域部署需要 Bridge 侧配置 CORS header，或通过反向代理解决。

---

## 办公室布局

预设 10 个工位，2 排 × 5 列：

```
┌───────────────────────────────────────────────────┐
│  🪟        🪟        🪟        🪟        🪟       │
│                                                   │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│  │  0  │ │  1  │ │  2  │ │  3  │ │  4  │       │
│  │ 🖥️  │ │ 🖥️  │ │ 🖥️  │ │ 🖥️  │ │ 🖥️  │       │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘       │
│                                                   │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│  │  5  │ │  6  │ │  7  │ │  8  │ │  9  │       │
│  │ 🖥️  │ │ 🖥️  │ │ 🖥️  │ │ 🖥️  │ │ 🖥️  │       │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘       │
│                                                   │
│     🪴        ☕ 茶水间        📋 看板       🪴    │
│                                                   │
└───────────────────────────────────────────────────┘
```

- 工位按 `/health` 返回的 agent 顺序分配（slot 0-9）
- agent 少于 10 个时，多余工位显示为空桌
- agent 超过 10 个时，后续 agent 不显示（Phase 1 限制）

## Agent 状态映射

| Bridge 状态 | 视觉表现 |
|-------------|----------|
| **offline** | 空椅子，电脑灰屏 |
| **idle** | 角色坐着，偶尔伸懒腰/喝咖啡 idle 动画 |
| **busy** | 快速打字动画，电脑屏幕亮起，头顶 ⚡ |
| **talking** | 头顶弹出像素对话气泡 |
| **error** | 头顶 ❌，电脑冒烟 |

## 动画状态机

```
offline ──(alive>0)──► idle
idle ──(busy>0)──► busy
idle ──(heartbeat response)──► talking ──(3s)──► idle
busy ──(busy=0)──► idle
any ──(alive=0)──► offline
any ──(healthy=false)──► error
```

## 对话气泡

- 像素风圆角矩形，尾巴指向角色头顶
- 英文像素字体，最多 60 字符，超出截断加 `...`
- silent 回复不显示
- 显示 2-3 秒后淡出
- 多 agent 同时说话时气泡错开避免重叠

## 响应式 / 移动端

- Phaser 的 `Scale.FIT` 模式，画布自动缩放适配屏幕
- 基础分辨率：**480×320**（经典像素游戏分辨率），整数倍缩放
- 移动端：横屏提示，或竖屏时地图自动旋转/缩放
- 触摸支持：双指缩放（Phase 2）

## 项目结构

```
agent-space/
├── index.html
├── package.json
├── vite.config.js
├── DESIGN.md
├── README.md
├── src/
│   ├── main.js              — Phaser 启动 + 场景注册
│   ├── config.js             — Bridge URL、轮询间隔、工位布局
│   ├── scenes/
│   │   ├── BootScene.js      — 资源加载 + loading bar
│   │   └── OfficeScene.js    — 主场景：地图 + agent 精灵 + 气泡
│   ├── sprites/
│   │   └── AgentSprite.js    — agent 角色（状态机、动画）
│   ├── ui/
│   │   ├── Bubble.js         — 像素对话气泡
│   │   └── StatusBar.js      — 顶部状态栏（Bridge 连接状态、版本）
│   └── bridge/
│       └── BridgeClient.js   — API 轮询 + 状态解析 + 错误重试
├── public/
│   └── assets/
│       ├── tiles/            — tilemap 图块
│       ├── sprites/          — 角色精灵表
│       └── maps/             — Tiled JSON 地图（或程序化生成）
└── tools/
    └── gen-placeholder.js    — 生成占位符精灵的脚本
```

## 地图制作方案（待讨论）

两种方案各有优劣：

### 方案 A：Tiled 编辑器

- 用 [Tiled](https://www.mapeditor.org/) 可视化编辑地图，导出 JSON
- Phaser 原生加载 Tiled JSON
- **优点：** 美术可控，细节丰富，标准工作流
- **缺点：** 需要额外工具，地图修改需重新导出

### 方案 B：程序化生成

- 代码中定义工位坐标和装饰物位置，运行时生成 tilemap
- **优点：** 零外部依赖，工位数量可动态调整
- **缺点：** 美术效果受限，难做复杂装饰

**建议：** Phase 1 用方案 B（快速出原型），Phase 2 切方案 A（正式美术）。

## 开发阶段

### Phase 1：骨架 + 占位符（MVP）

- [ ] Vite + Phaser 3 项目搭建
- [ ] 配置页：输入 Bridge URL + Token
- [ ] BridgeClient：轮询 `/health` + `/heartbeat` + `/heartbeat/logs`
- [ ] 程序化生成办公室地图（色块占位符）
- [ ] 色块占位符角色（不同颜色方块 = 不同 agent）
- [ ] 状态映射：offline/idle/busy 用颜色区分
- [ ] 文字标签显示 agent 名称
- [ ] 基础响应式缩放

### Phase 2：像素美术

- [ ] 32×32 tileset（地板、墙、桌子、电脑、窗户、植物）
- [ ] 角色精灵表：idle / busy 动画帧
- [ ] Tiled 地图替换程序化生成
- [ ] 像素字体集成

### Phase 3：动画与气泡

- [ ] 角色动画状态机
- [ ] 对话气泡渲染
- [ ] idle 随机动作
- [ ] 状态切换过渡动画
- [ ] 断线重连 UI

### Phase 4：交互（未来）

- [ ] 点击 agent 查看详情面板
- [ ] 点击触发心跳 ping
- [ ] 双指缩放 / 拖拽
- [ ] 音效

## 开放问题

1. ~~工位数量~~ → 固定 10 个
2. ~~气泡语言~~ → 英文
3. **地图方案** → Phase 1 程序化，Phase 2 Tiled？还是一步到位用 Tiled？
4. ~~移动端~~ → 支持
5. **多 Bridge** — 未来是否支持连接多个 Bridge（多楼层）？
6. **CORS** — Bridge 侧是否需要加 CORS 支持？还是建议同域部署？
