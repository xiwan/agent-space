# TODO — Deferred work and decisions

> Phase 0 必读. 每项都注明背景、可行方案、为什么暂缓、何时再考虑.

---

## Per-agent LLM model display (deferred 2026-05-20)

### 背景

v2.12.0 给 sidebar 加了 Usage tab, 显示全局 + by\_model 的 token / cache 统计.
但用户想看 "每个 agent 实际在用什么 LLM". 调研结果: acp-bridge 当前**不真的
知道**, 因为 model 选择在 agent CLI 内部 (claude-cli / qwen-cli / kiro-cli
各自管各自的).

### 可行路径 (按精度排)

#### 方案 A: 真精度 — 改 acp-bridge 落库 schema (v2.14.0+ 候选)
- `data/usage.db` 的 `llm_usage` 表加 `agent TEXT` 列
- LiteLLM callback 端 (`src/routes/litellm_proxy.py::_record_usage`) 接收
  agent 字段并入库
- agent CLI 调 LiteLLM 时通过 `metadata.user_id` 或 `user` 字段透传 agent 名
- `/usage` 端点加 `by_agent` 聚合 (类似现有 `by_model`)
- agent-space 这边在 UsageView 加第二个 "By agent" 列表
- 改动跨 3 处: agent CLI / acp-bridge / agent-space — 工程量大

#### 方案 B: 配置声明 — 用 `/agents` 的 `recommended_models` 字段 (v2.13.0 候选)
- ACP 协议标准字段, acp-bridge `/agents` 端点已透出, 只是 config.yaml 没填
- 改 acp-bridge `config.yaml` 给每个 agent 填:
  ```yaml
  claude:
    metadata:
      recommended_models: ["claude-sonnet-4.5"]
  qwen:
    metadata:
      recommended_models: ["qwen3-coder-next"]
  codex:
    metadata:
      recommended_models: ["bedrock/deepseek.v3.2", "claude-haiku"]
  ```
- agent-space 拉 `/api/agents` (BridgePoller 现仅拉 `/health` + `/health/agents`),
  缓存 metadata
- 显示位置 (3 处可选):
  - Sidebar Agents tab 卡片新加一行 `🤖 claude-sonnet-4.5`
  - History 卡片头部加 `model: ...` chip
  - Composer agent chip tooltip
- ⚠️ 是"声明"不是"运行时绑定", agent CLI 实际可能换用别的 model

#### 方案 C: 启发式兜底 — 解析 `metadata.tags`
- 现有 tags 含 "claude-sonnet" / "qwen3-coder" / "deepseek" 等 model 关键字
- 纯前端, 不改 acp-bridge
- 不可靠: 新 agent 不一定打 model tag, 命名不规范

#### 方案 D: 时间窗启发 — 关联 `/usage/recent` 与 agent busy
- 拉 `/usage/recent`, 按时间戳关联 agent busy 区间
- 不准, 多 agent 并发就乱

### 推荐路径

**B + C 兜底** 一起做 v2.13.0 (B 优先 / C fallback). 但优先级低于功能性需求.
A 留 v2.14.0+, 等真有人需要"按 agent 看 cost"再做.

### 触发条件 (何时拿出来重做)

- 用户明确要"按 agent 看 token / cost" → 启动 A
- demo 现场有人问"qwen 这次用的是哪个 qwen 版本"? → 启动 B (10 分钟)
- 现状: 用户说"先作为 todo", 不再纠结

---

## v2.0.0 paused side branch — Tilemap room system + grid editor

### 背景

v2.0.0 (Phaser 4 双区办公 + tilemap + RoomScene + EditorScene) 自 v2.1.0
转 pixel viewer 主线后一直 paused. 工作树仍带未 stage 的 v2.0.0 改动:

- modified: `index.html`, `src/main.js`, `src/scenes/LpcMainScene.js`,
  `src/systems/AgentManager.js`, `src/bridge/AcpBridgeClient.js`,
  `public/assets/room/tilemap.json`
- deleted: `public/assets/desk/*` (18 个 PNG)
- untracked: `index.v1.html`, `src/scenes/{Editor,Room}Scene.js`,
  `src/tilemap/`, `public/assets/room/desk/`

每个新版本 (v2.7.0–v2.12.0) commit 时都把它们排除在 stage 外.

### 选择空间

1. **完整复活 v2.0.0** — 接续 RoomScene/EditorScene/TilemapManager 重构,
   做 Phaser 主线的 v2.x.0 (与 pixel 主线并行)
2. **彻底放弃 v2.0.0** — 把工作树 reset / 删掉相关文件 + 删 v2.0.0 的 README,
   把 / 入口指向 pixel 或简化
3. **现状维持** — 不做任何动作, 工作树继续 dirty

### 推荐

**选项 2 + 收拢入口** 是最干净的. 但需要明确决策:
- `index.html` (Phaser) 是否保留作为 demo / fallback?
- 如保留: 至少把当前 modified 的几个文件 commit 或 reset 一次, 让工作树 clean
- 如放弃: `git rm` 一组文件 + reset modified + 删 RoomScene/EditorScene/tilemap

### 触发条件

- 想清理工作树 (要 release / 上 origin 推 push) → 处理掉
- 决定用哪条主线展示给观众 → 选 1 或 2

---

## Push pending local commits to origin

### 背景

v2.3.0 → v2.12.0 共 13 个本地 commit 全部未 push (含 v2.10.1 / v2.11.0 /
v2.11.1 / v2.12.0 + 10 个早期). origin/master 当前落后 13 个.

### 推荐

任何下一次 push 之前:
1. 决定 v2.0.0 副线工作树怎么处理 (见上一项)
2. 跑全套 build + test 一次
3. 一次性 `git push` 所有 commit

### 触发条件

- 想做 release
- 想让另一台机器同步
- 想让 git 历史脱离仅本地状态

---

## OPERATIONS.md self-maintenance reminders

- OPERATIONS.md 在 `.gitignore` 里, 改动只在本机存档
- Architecture / Read Order / Part 2 至少每 5 个版本核对一次, 防再次落后 8 版
- v2.10.1 是上一次自我维护. 下次自维护建议在 v2.15.0–v2.16.0 之间
- 每次自维护单独走 patch 流程 (e.g. v2.10.1 模板)

---

## v2.13.0+ candidates (UX / 功能)

按用户优先级排, 任意时刻可启动:

1. **History 命令上一条 / ↑↓ 回填** (v2.10.0 提到的 D 包)
   - prompt 提交后清掉, 想改一字重发要重打 — ↑ 调出最近, Enter 编辑
   - localStorage 持久化最近 10 条
2. **Submit cancel / abort**
   - submitting 中长 pipeline 没法取消, 用户只能刷页面
   - 需要 ACP Bridge `DELETE /jobs/{id}` 或 `/pipelines/{id}` 支持
3. **常用命令模板 / Recipes** (v2.10.0 F 包)
   - "summit demo / 翻译接力 / 4 模型并行对比"等预设
   - localStorage 保存自定义模板
4. **i18n** (v2.10.0 H 包)
   - placeholder / 按钮 / status 中英两套
5. **/heartbeat/logs 关联** (v2.11.0 方案 2️⃣)
   - history 卡片展开时拉对应 agent + 时间窗的 heartbeat logs, 拼成对话流
   - 比"终态 output"信息更丰富, 但精度有限 (跨 job 混入)
6. **SSE / 流式输出** (v2.11.0 方案 3️⃣)
   - 需要 ACP Bridge 支持 `/jobs/{id}/stream` (SSE 或 chunked)
   - 体验最好, 工程量最大
7. **Cost 字段对接** (v2.12.0 留的钩子)
   - acp-bridge `/usage` SELECT 加 `cost_usd` (litellm_proxy.py)
   - acp-bridge `Job.to_dict` 暴露 `cost_usd / model_name / input_tokens / output_tokens`
   - agent-space UsageView 把 "—" 换成实际数字
   - history 卡片头加 `[$0.0012]` chip
