# dsh-assistant-message-forge（消息锻造台）

双面（Host + Client）DSH 插件：在会话区新增一个 **消息锻造台** 页签，核心是
**详细上下文解析 → 记录 → 卡片化 → 动态编辑 → 开放修改**：

1. `context/refresh` 把当前会话完整解析成一张张 `ContextCard`
   （turn/step 边界、user/assistant 消息、tool call/result、request header、
   其他 log-only 事件；`assistant/chunk` 按轮折叠计数）；
2. 解析结果连同卡片 overrides 一起 **记录** 到
   `$DSH_HOME/assistant-message-forge/context-<sessionId>.json`；
3. 页签内按轮分组 **卡片化** 展示，含 surface 折叠状态（原始被替换 / 替换生效中）；
4. 卡片可 **动态编辑**：文本/reasoning/provider/model/usage、工具名与
   arguments、工具结果文本；编辑先保存为记录，也可 **保存并应用到会话**
   （surface replace 直接改写当前会话中的原消息）。

此外保留 v1 能力：创建/修改/删除/注入 assistant 草稿、上传识别
`session.jsonl(.zstd)`；导入区还会做完整性预览，并可把安全可解释的损坏
恢复为新的 `session-repaired-*` 会话。

## 能力

| 能力 | 入口 | 说明 |
|---|---|---|
| 上下文解析+记录 | 会话上下文 → **刷新解析** | 全事件分类解析并落盘为 context 记录 |
| 上下文卡片化 | 会话上下文卡片流 | 按轮分组，边界/消息/工具/请求/其他卡片 + surface 状态 |
| 卡片动态编辑 | 卡片 → **编辑** → **保存记录** | 修改只写入记录 override，刷新解析不丢 |
| 应用到会话 | 卡片 → **保存并应用到会话** / **应用到会话** | user/assistant/tool-result 用 surface replace 替换原消息，模型上下文即时生效 |
| 添加/修改/删除草稿 | 草稿区按钮 | 草稿持久化在 `drafts.json` |
| 注入到会话 | 草稿行 → **注入到当前会话** | 完整合成轮 + flush |
| 导入识别 sessionlog | 底部文件选择 → **导入并识别** | zstd/JSONL 解码 + packed chunk 展开 + 事件识别 |
| 修复损坏 sessionlog | 完整性预览 → **创建修复会话** | 后写分支覆盖 + 官方 crash closer + 官方 seed 校验；原日志只读 |
| 复用识别结果 | 识别行 → **存为草稿** / **注入** | 保留 reasoning+text/provider/model/usage |

## 架构

```
浏览器客户端                                  DSH host (Node)
ForgeView（conversation.view 页签）
  ├─ ContextPanel：解析记录卡片流 + 动态编辑
  ├─ 草稿区：添加/修改/删除/注入按钮
  ├─ sessionlog 文件选择 + 识别/修复预览
  └── connection.rpc.call(AMF_RPC_CHANNEL) ──▶ /dsh-assistant-message-forge
                                                   ├─ DraftStore（drafts.json）
                                                   ├─ ContextRecordStore（context-*.json + overrides）
                                                   ├─ parseContext / surface replace apply
                                                   ├─ parse/repairSessionLogBytes（node:zlib zstd）
                                                   └─ injectMessage（session.append + flush）
```

- Host 半通过 `ctx.connection.rpc.handle()` 注册通用 Connection RPC 通道（loopback 信任边界），不修改 apiproxy 允许列表。
- Client 半注册 `conversation.view` 页签（`scope: session`），组件经 `sessionId` 标准 prop 拿到当前会话。

## RPC 端点

通道：`/dsh-assistant-message-forge`

| endpoint | payload | 返回 |
|---|---|---|
| `drafts/list` | `{}` | `AssistantDraft[]` |
| `drafts/save` | `{ draft: { id?, title?, content, reasoning?, provider?, model? } }` | 保存后的 `AssistantDraft` |
| `drafts/delete` | `{ id }` | `boolean` |
| `session/inject` | `{ sessionId, message: { content, reasoning?, provider?, model?, usage? } }` | `{ sessionId, turn, step, seq, messageId, flushed }` |
| `context/load` | `{ sessionId }` | 已记录的 `ContextSnapshot` 或 `null` |
| `context/refresh` | `{ sessionId }` | 重新解析并记录后的 `ContextSnapshot` |
| `records/update` | `{ sessionId, key, patch }` | 合并卡片 override 后的 `ContextSnapshot` |
| `records/reset` | `{ sessionId }` | 丢弃全部 override 后的 `ContextSnapshot` 或 `null` |
| `context/apply` | `{ sessionId, key }` | `{ sessionId, replacedSeq, newSeq, type, turn?, step?, flushed }` |
| `sessionlog/parse` | `{ name, dataBase64 }` | `SessionLogParseResponse` |
| `sessionlog/repair-preview` | `{ name, dataBase64 }` | `SessionLogRepairReport` |
| `sessionlog/repair-create` | `{ name, dataBase64 }` | `{ sessionId, flushed, report }` |

错误统一走 `RpcResult` 的 `{ ok:false, error:{ code:'internal', ... } }` 分支；参数校验失败、会话不存在、当前会话存在未闭合 turn 时都会返回可读 message。

## 卡片与修改语义

- **卡片解析覆盖**：`turn/start|end`、`step/start|end`、`user/message`、
  `assistant/message`（reasoning/text/provider/model/usage）、`tool/call`、
  `tool/result`、`request/header`、`request/context`、其余 log-only 事件。
  `assistant/chunk` 不逐条成卡，按轮统计 `chunkCount`。
- **记录优先**：`records/update` 只改 override；之后 `context/refresh` 重新解析时
  会合并 override，不会丢。`records/reset` 丢弃全部记录修改。
- **应用到会话 = surface replace**：对 `user/message`、`assistant/message`、
  `tool/result` 追加一个 `surfaceOp: {op:'replace', start:seq, end:seq}` 事件，
  原节点被 shadow（模型 `deriveMessages` 用新内容），原始 append 事件仍保留在
  日志与官方对话流中；卡片流会同时显示「原始已被替换」和「替换生效」两张卡。
- **tool/result 特殊限制**：DSH surface 校验只允许改写 tool-result 的
  `content`；message id/source/isError/error wrapper 必须保持原值，因此
  `isError` 在记录里可改，但应用时按原值写回。
- **会话正在运行**（存在未闭合 turn）时注入和应用都会拒绝，避免破坏执行边界。
- **导入识别的投影**：识别结果把 content 块投影为 `text` + `reasoning` 两条；
  `tool-call`、`image` 等非文本块计数为 `unsupportedBlocks`，注入时不会携带。
- **传输上限**：上传 base64 ≤ 128 MiB；解压后 ≤ 128 MiB；识别列表每批最多 200 条（`truncated` 标记）。

## 会话修复语义与边界

- **后写分支覆盖**：物理日志出现 `seq < 当前逻辑长度` 时，从该 seq 回滚候选尾部，
  再接入后写分支；报告会列出 `fromSeq` 和丢弃事件数。
- **不猜缺口**：坏 JSON、坏 packed row 或向前跳号会让扫描保守停止；不会伪造缺失业务事件。
- **官方闭合**：候选前缀交给 `@deepseek-ai/dsh-session` 的
  `interruptedTurnClosers()` 补齐未完成 tool/step/turn。
- **官方终审**：使用 `Session.create(seed)` 重新验证从 0 连续的 seq、事件 envelope、
  surface append/replace 引用和 JSON 可持久化约束；失败则禁用创建按钮。
- **不可覆盖**：插件不截断、不重命名、不写回源 `session.jsonl(.zstd)`；只创建新的
  `session-repaired-*` 会话，并把原 session id 记录为 `parentSession`。

## 目录结构

```
assistant-message-forge/
├── cordis.patch.yml          # bundle patch：insert 一行，包名即 loader 行名
├── package.json              # dsh.client + dsh.bundle + exports["./client"]
├── tsconfig.json             # tsc：lib/index.js + lib/types（Host 半 + 中间 Client JS）
├── tsdown.config.ts          # tsdown：lib/client.js 浏览器闭包工厂
├── scripts/
│   ├── check-client-bundle.mjs  # 校验 client bundle 只 require 模块表内依赖
│   ├── test-session-repair.mjs  # 分支回退 + crash closer 纯函数回归
│   └── e2e-smoke.mjs            # 编辑/apply/导入/修复新会话全流程冒烟
└── src/
    ├── index.ts              # Host 半：RPC 通道 + 全部端点路由
    ├── store.ts              # 草稿 JSON 持久化
    ├── context.ts            # 详细上下文解析 + context 记录 + surface replace apply
    ├── sessionlog.ts         # zstd 帧扫描 + JSONL 解码 + 事件识别
    ├── shared-types.ts       # 双面共享 wire 类型
    └── client/
        ├── index.ts          # Client 半：注册 conversation.view 页签
        ├── ForgeView.tsx     # 锻造台三段式 UI（上下文/草稿/导入）
        ├── ContextPanel.tsx  # 解析记录卡片流 + 动态编辑
        ├── ForgeView.module.css
        └── locales.ts        # zh/en + LocaleNamespaceMap 增广
```

## 构建

```sh
cd D:/codeproject/dsh-plugin/plugins/assistant-message-forge
pnpm install
pnpm run build          # rm -rf lib && tsc && tsdown
pnpm run test:session-repair
pnpm run test:client-bundle
```

产物：
- `lib/index.js` — Host 半（`@deepseek-ai/*` import 保持外部，由安装 profile 解析）
- `lib/client.js` — 浏览器闭包工厂（`window.__ModuleLoader__.load({id:"dsh-assistant-message-forge"})`）
- `lib/types/**` — 声明文件

## 激活（Web UI 需要 bundle 安装，不能用裸 `--patch`）

`--patch` 只能把 Host 源码挂进插件树；`dsh.client` 扫描器按**包名**经 `require.resolve` 发现 `exports["./client"]`，因此浏览器半必须作为 bundle 安装进 profile：

```sh
cd D:/codeproject/deepseek-harness

# 独立测试 profile（第一次会只初始化 base，手动把 web-app bundle 加进 dsh.profile.bundles）
pnpm dsh plugin --profile amf-test add D:/codeproject/dsh-plugin/plugins/assistant-message-forge
pnpm dsh --profile amf-test --port 3090

# 正式使用：装进默认 web profile，重启 dsh web 生效
pnpm dsh plugin --profile web add D:/codeproject/dsh-plugin/plugins/assistant-message-forge
pnpm dsh web
```

> `dsh web` 是 `--profile web` 的硬别名；给自定义 profile 启动 Web 应用要用
> `pnpm dsh --profile <name> --port <port>`，并保证该 profile 的 `dsh.profile.bundles`
> 依次包含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-assistant-message-forge`。

## 开发期热更

- Client 半：`client-hmr` 会 watch 所有已挂载 bundle 的 `lib/client.js`。改完 `src/client/**` 后
  `pnpm run build`，浏览器自动拉取新 rev（本插件构建约 1 秒）。
- Host 半：web profile 的 loader HMR 关闭；改 `src/index.ts` / `src/store.ts` /
  `src/sessionlog.ts` 后需重启 `dsh web`。

## E2E 冒烟

对运行中的实例执行按钮级验证（创建一次性会话 → 上下文刷新解析 →
助手卡片记录编辑/应用 → 丢弃记录修改 → 草稿添加/修改/注入 →
导入识别 → 损坏日志预览/创建修复会话 → 删除草稿）：

```sh
$env:AMF_URL='http://127.0.0.1:3090'
$env:SESSION_LOG=$env:DSH_SESSION_JSONL
node scripts/e2e-smoke.mjs
```

脚本用 `D:/codeproject/dsh-browser/node_modules/playwright`（可用 `PLAYWRIGHT_ROOT` 覆盖），
先经 RPC 创建一个 workspace-attached 的一次性会话再逐项点击中文 UI，避免污染真实会话；
`PLAYWRIGHT_CHANNEL=chrome` 可显式使用本机 Chrome，`AMF_HEADED=1` 可打开可见浏览器窗口。
