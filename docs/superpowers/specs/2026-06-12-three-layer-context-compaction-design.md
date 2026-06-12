# 三层上下文压缩设计文档

**日期：** 2026-06-12
**分支：** fix/codex-context-compaction
**状态：** 已批准，待实现

---

## 核心思路

用 `@ai-sdk/anthropic` / `@ai-sdk/openai` 实现 OpenCow 自管理的三层上下文压缩，替代依赖 Codex SDK 内置压缩（SDK 不暴露 `context_compacted` 事件）。压缩后开启新线程，通过 systemPrompt 注入压缩上下文摘要，UI 历史完整保留。

---

## 分层结构

### "轮"的定义

一轮 = 一个 user 消息 + 对应的完整 assistant 回复（含所有工具调用步骤）。轮编号从最新往旧倒数（1 = 最新）。

### 三层映射（最多保留 33 轮）

```
轮编号（从最新到最旧）
│  1  2  3  │  4  5 … 13  │  14  15 … 33  │  34+ →丢弃
│           │             │               │
│  Layer 1  │   Layer 2   │    Layer 3    │  超出窗口
│ user+bot  │user原文+bot  │  LLM 摘要段   │
│  完整保留  │ 一行摘要(150 │               │
│            │字确定性截断)│               │
```

| 层级 | 轮范围 | User 内容 | Bot 内容 | 方式 |
|------|--------|-----------|---------|------|
| Layer 1 | 最新 3 轮 | 完整保留 | 完整保留 | 直接传递 |
| Layer 2 | 往前 10 轮（4–13）| 完整保留（原文）| 前 150 字确定性截断 | 无 LLM |
| Layer 3 | 再往前 20 轮（14–33）| 全部 | 全部（工具数据摘要化） | LLM 摘要 |
| 超出窗口 | 34 轮以上 | — | — | 完全丢弃 |

---

## 数据结构

### CompactContinuationContext

```typescript
interface CompactContinuationContext {
  /** 最新 3 轮完整消息（Layer 1） */
  layer1Messages: ManagedSessionMessage[]
  /** 轮 4-13 的用户提示词原文（Layer 2 user 部分） */
  layer2UserPrompts: string[]
  /** 轮 4-13 的 bot 一行摘要（Layer 2 bot 部分，最多 150 字/条）*/
  layer2BotBriefs: string[]
  /** LLM 生成的轮 14-33 综合摘要（Layer 3） */
  layer3Summary: string
  /** 压缩时间戳 */
  compactedAt: number
  /** 被压缩进摘要的轮数 */
  totalTurnsCompacted: number
  /** 摘要是否为 LLM 生成（false = 降级确定性摘要）*/
  layer3IsLLM: boolean
}
```

### ManagedSession 新增字段（schema 兼容，旧数据 undefined）

```typescript
compactContinuationContext?: CompactContinuationContext
pendingCompact?: boolean   // true = 下次发消息必须 startThread() 而非 resumeThread()
```

---

## Layer 3 LLM 摘要

### 模型路由

| 会话引擎 | 摘要模型来源 |
|---------|------------|
| Claude 会话 | `@ai-sdk/anthropic`，复用会话的 auth config（同 HeadlessLLMClient） |
| Codex / OpenAI 会话 | `@ai-sdk/openai`，复用会话的 auth config |

通过现有 `HeadlessLLMClient` 调用，不新增 HTTP client。

### 摘要 Prompt

```
你是一个对话压缩助手。以下是一段用户与 AI 的对话历史（从最旧到最近）。
请将其压缩为一段不超过 600 字的摘要，需包含：
1. 任务背景与目标
2. 已完成的关键操作（文件修改、功能实现等）
3. 当前状态与遗留问题

不要重复用户的原始提问，聚焦于"做了什么、结果如何"。

[对话内容]
```

### 摘要参数

- **输出 token 上限：** 600 tokens
- **超时：** 30 秒（复用 HeadlessLLMClient 默认值）

### 失败降级

```
LLM 调用失败（超时 / API 错误）
  → 确定性降级：取轮 14–33 所有 user 提示词原文按时间顺序拼接
  → 超过 2000 字：截断 + "…（更早内容已省略）"
  → layer3IsLLM = false
```

### 超预算保护

压缩后，若 Layer 1 + Layer 2 + Layer 3 摘要合计超过 session context limit 的 60%，视为压缩失败：
- 不设置 `pendingCompact`
- 不清空 `engineSessionRef`
- 向用户显示明确错误系统事件（不静默失败）

---

## 触发机制

### 手动触发

两个入口，行为一致：

| 入口 | 拦截位置 | 行为 |
|------|---------|------|
| UI 按钮（Slash 菜单选 `/compact`）| `SessionOrchestrator.sendMessage()` 入口前 | 调用 `compactSession()`，不进入 `pushMessage()` |
| 用户手动输入 `/compact` 并发送 | 同上 | 同上 |

**检测逻辑：** content 为纯文本 `/compact`（exact match 或纯 text block `/compact`），在所有漂移检测之前优先判断。

### 自动触发（90% 阈值）

**检测时机：** 每次 `sendMessage()` 准备推送前

```typescript
const display = resolveContextDisplayState(session.snapshot())
const usageRatio = display.usedTokens / display.limitTokens

if (usageRatio >= 0.90) {
  // 先执行压缩，显示 loading 状态
  const compacted = await compactSession(sessionId)
  if (!compacted) {
    // 压缩失败：发 engine.diagnostic warning，仍继续发消息（不阻断用户）
  }
  // 压缩成功：继续发消息（在新线程里）
}
```

**UI 交互：** 自动触发时，发出 `compact_boundary` 系统事件（`phase: 'compacting'`），复用现有 loading 动画，用户看到"正在压缩上下文…"状态，完成后继续。

**失败处理：** 压缩失败时不阻断用户消息发送，仅打 `engine.diagnostic` warning。

---

## 压缩上下文注入

### 压缩完成后状态变化

```typescript
session.compactContinuationContext = { ... }
session.pendingCompact = true
session.engineSessionRef = null  // 旧 thread ID 作废
```

### 注入格式（systemPrompt 前缀）

```xml
<context_continuation>
  <summary>
    [Layer 3 摘要文本，600 字以内]
  </summary>

  <previous_turns>
    <!-- 轮 14→4（从旧到新），user 原文 + bot 一行摘要 -->
    <turn n="14">
      <user>用户提示词原文</user>
      <assistant_brief>bot 前 150 字摘要…</assistant_brief>
    </turn>
    <!-- ... -->
    <turn n="4">
      <user>用户提示词原文</user>
      <assistant_brief>bot 前 150 字摘要…</assistant_brief>
    </turn>
  </previous_turns>
</context_continuation>
```

Layer 1（最新 3 轮完整对话）按引擎差异处理：

| 引擎 | Layer 1 注入方式 |
|------|----------------|
| **Claude** | systemPrompt 前缀 + messages 数组保留 Layer 1 的 3 轮真实消息对象 |
| **Codex** | Layer 1 格式化为 `<recent_turns>` XML 追加到 systemPrompt 末尾（Codex 新线程无消息回放能力）。格式示例：`<recent_turns><turn n="3"><user>…</user><assistant>…</assistant></turn></recent_turns>` |

### resumeSessionInternal() 修改

检测到 `pendingCompact = true`：
1. 强制走 `startThread()`（忽略 `engineSessionRef`，等效于 `forceRestart`）
2. 将 continuation context 序列化为 systemPrompt 注入
3. 清除 `pendingCompact`

---

## 新增模块清单

| 模块 | 路径 | 职责 |
|------|------|------|
| `conversationContinuationSummary.ts` | `electron/command/` | 分层算法 + LLM 摘要 + 降级 + 超预算检测 |
| IPC handler | `electron/ipc/channels.ts` | 新增 `command:compact-session` 通道 |
| `compactSession()` | `electron/command/sessionOrchestrator.ts` | 手动/自动压缩入口，管理 lifecycle 切换 |

### 修改模块清单

| 模块 | 变更内容 |
|------|---------|
| `electron/command/managedSession.ts` | 新增 `compactContinuationContext`、`pendingCompact` 字段及相关 getter/setter |
| `electron/command/sessionOrchestrator.ts` | `sendMessage()` 前置 `/compact` 拦截 + 90% 阈值检测；`resumeSessionInternal()` 读取 `pendingCompact` |
| `src/shared/slashItems.ts` | Codex `builtin:compact` 标记 `nativeAction: { kind: 'codex.compact_context' }` |
| `src/renderer/hooks/useMessageComposer.ts` | Slash 菜单选择 `builtin:compact` 时不插入 mention，直接调用 `command:compact-session` IPC |

---

## 测试计划

| 测试文件 | 覆盖场景 |
|---------|---------|
| `conversationContinuationSummary.test.ts` | 分层边界（恰好 3/13/33 轮）、LLM 失败降级、超预算检测 |
| `sessionOrchestrator.test.ts` | `/compact` 拦截不进 pushMessage；90% 阈值触发；pendingCompact 清除后下次 startThread() |
| `slashItems.test.ts` | Codex compact nativeAction 标记存在；Claude compact 不受影响 |
| `contextDisplay.test.ts` | 90% 阈值计算（边界值：89.9% 不触发，90.0% 触发）|
| `managedSession.test.ts` | compactContinuationContext 字段读写；schema 兼容（旧数据 undefined）|

---

## 已知约束与风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| 自动压缩延迟 | LLM 摘要调用 2–10 秒，用户点发送后有等待 | UI 显示 loading 状态，明确告知用户 |
| Codex Layer 1 非真实历史 | Codex 新线程里 Layer 1 是 XML 格式化文本，非真实 messages | 已知限制，无法绕过 SDK |
| Layer 2 bot 摘要质量 | 确定性 150 字截断可能截断关键信息 | 可后续优化为 LLM 摘要 |
| 超预算失败无降级 | 如果压缩后仍超 60%，报错不压缩 | 明确错误信息，用户可手动清理后重试 |
