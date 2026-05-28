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

## ~~v2.0.0 paused side branch~~ — RESOLVED 2026-05-28 (v2.14.1)

cleanup commit `546fefbb` 已删除 Phaser 副线全部代码 (index.html, src/main.js,
src/game.js, src/scenes/, src/systems/, src/bridge/, src/tilemap/, src/ui/,
src/config.js, public/assets/). v2.14.1 同步刷新 OPERATIONS.md 移除所有副线
描述, 并 `npm prune` 清掉 node_modules/phaser 死依赖. `versions/v2.0.0.md`
保留作为历史档案.

---

## Push pending local commits to origin

### 背景

v2.13.4 + v2.14.0 (+ v2.14.1 if/when committed) 本地未 push.
origin/master 当前落后 ≤ 3 个 commit.

### 推荐

任何下一次 push 之前:
1. 跑全套 build + test 一次
2. 一次性 `git push` 所有 commit

### 触发条件

- 想做 release
- 想让另一台机器同步
- 想让 git 历史脱离仅本地状态

---

## OPERATIONS.md self-maintenance reminders

- OPERATIONS.md 在 `.gitignore` 里, 改动只在本机存档
- Architecture / Read Order / Part 2 至少每 5 个版本核对一次, 防再次落后 8 版
- 历次自维护: v2.10.1 (v2.1–v2.10), v2.14.1 (v2.11–v2.14 + 副线下架).
  下次自维护建议在 v2.18.0–v2.20.0 之间
- 每次自维护单独走 patch 流程 (e.g. v2.10.1 / v2.14.1 模板)

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


---

## Stashed WIP — pickup as v2.18.0 (saved 2026-05-28 during v2.16.2; v2.17.0 superseded by HeartbeatView polish)

### 状态

`git stash list` 有一条 `stash@{0}: v2.14.2-WIP: SSE live + cancel + artifact UI + make-game pipeline rewrite`.
v2.16.2 phase 6 pre-commit 时发现工作目录有 5 个文件的非本次 scope 改动, 单独 stash 保留.

### Stash 包含的工作 (5 文件)

- **`src/pixel/CommandHistory.js`** (+454/-20 行)
  - SSE 流式订阅: `step_started` / `step_progress` / `step_completed` / `step_failed` /
    `pipeline_done` 事件渲染
  - 轮询兜底: `_tickLive()` + `LIVE_POLL_INTERVAL_MS`, SSE 失败时退回 `/api/jobs/{id}/live`
    与 `/api/pipelines/{id}/steps/{i}/live`
  - **Cancel 按钮** (todo.md #2 — Submit cancel / abort): `.ch-cancel-btn` 绑
    `cancelJob/cancelPipeline`
  - **Artifact 链接** 渲染: 根据 step.artifact metadata, 把 URL 渲成超链, file 渲成下载链
  - **Progress 折叠日志**: `<details>` 展示 tool / 思考 / 状态消息 (🔧 / 💭 / 📋)
  - **实时耗时**: `.ch-elapsed` 给运行中任务显示 elapsed
  - **Prompt preview**: 失败/无 text 的 step 也展示 prompt (不再被过滤)
  - 截断长度 200 → 140
  - `TERMINAL_STATUSES` 集合判断是否还在跑

- **`src/pixel/CommandClient.js`** (+30 行) — 4 个新 endpoint:
  - `pollJobLive(jobId)` → `/api/jobs/{id}/live`
  - `pollPipelineStepLive(pipelineId, stepIndex)` → `/api/pipelines/{id}/steps/{i}/live`
  - `cancelJob(jobId)` / `cancelPipeline(pipelineId)`

- **`src/pixel/ArtifactComposer.js`** (+48 行)
  - `renderTemplate` 加 `{{uid}}` 替换
  - `buildArtifactPayload` 生成 8 字 hex uid + `artifact.context` 模板化, 返回 `_artifacts` 数组
  - UI 加 steps chip 预览 (`agent → agent → agent`)

- **`public/pixel/artifacts.json`** — make-game pipeline 重做:
  - `context: {shared_cwd: "/tmp/opengame-{{uid}}"}` 对齐 OpenGame skill 沙箱要求
  - 三 step 各加 `artifact: {type, label, pattern}` (gdd.md / game.html / CloudFront URL)
  - prompt 全面重写: 策划师 → "prompt 工程师", 显式锚定文件名, S3/CloudFront 命令具体化

- **`test/pixel-history.test.js`** (+13/-7 行) 适配 CommandHistory 行为变化:
  - 截断 200 → 140
  - "step 没 output 被过滤" → "全部 step 显示 (含状态占位符)"
  - race 模式 turns 从 1 → 3 全显示, isWinner 仍标记
  - 注释里标 `v2.14.2`

### 取回流程 (推荐 v2.18.0)

⚠️ **不要直接 `git stash pop` 后散乱 commit**. 走完整流程:

1. Phase 0: 读这条 todo + 看 `git stash show -p stash@{0}` 复习实际 diff
2. Phase 1: 声明版本号 (推荐 **v2.18.0** minor — 加新 endpoint + UI 大块 + 响应式 SSE)
   写 `versions/v2.18.0.md` 设计文档, 拆 4 块 scope:
   - A. CommandClient 4 个 endpoint
   - B. ArtifactComposer `{{uid}}` + context 模板化
   - C. CommandHistory SSE / 轮询 / cancel / artifact / progress
   - D. artifacts.json make-game 重做
3. Phase 3: `git stash pop` 取回
4. Phase 4: 验证现有测试 + 补 SSE / cancel / artifact 渲染单测
5. Phase 5: README 加 SSE / cancel feature note (Tech stack 段)
6. Phase 6/7: pre-commit + commit

### 触发条件

- 想让 Heartbeat 之外也实时看 pipeline 进度 → 启动取回 (主要价值点)
- 用户抱怨"长 pipeline 没法取消" → 启动取回 (Cancel 是 todo #2)
- demo 里 make-game 失败需要看 GDD 中间件 → 启动取回 (artifact UI)

### 版本号检查

注意 stash 里的代码注释写 `v2.14.2` 是历史误标 (实际未版本化). 取回时**用新号**
(v2.18.0), 不要复用 2.14.2.

> 改号历史: 2026-05-28 原计划 v2.17.0 → 实际 v2.17.0 被 HeartbeatView UX polish
> (commit `5e250220`) 占用, stash 顺延 v2.18.0.
