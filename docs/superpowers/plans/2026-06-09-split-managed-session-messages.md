# 拆分 Managed Session Messages 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `managed_sessions.messages` 从主表拆到 `managed_session_messages`，让列表查询只读会话元数据，详情查询再加载消息正文。

**架构：** 新增一张以 `session_id` 为主键并级联删除的消息正文表；主表通过迁移重建去掉 `messages` 列。Store 层把元数据 row 和消息 row 分开读写，但继续对外返回 `ManagedSessionInfo`，避免扩大 renderer 与 IPC 改动范围。

**技术栈：** Electron 主进程、TypeScript strict mode、Kysely、SQLite、Vitest。

---

## 参考资料和约束

- 规格文档：[`docs/superpowers/specs/2026-06-09-split-managed-session-messages-design.md`](../specs/2026-06-09-split-managed-session-messages-design.md)
- 现有主表创建：[`electron/database/migrations/003_create_managed_sessions.ts`](../../../electron/database/migrations/003_create_managed_sessions.ts)
- 现有表重建模式：[`electron/database/migrations/016_drop_session_issue_id.ts`](../../../electron/database/migrations/016_drop_session_issue_id.ts)
- Store 入口：[`electron/services/managedSessionStore.ts`](../../../electron/services/managedSessionStore.ts)
- Row mapper：[`electron/services/mappers/managedSessionRowMapper.ts`](../../../electron/services/mappers/managedSessionRowMapper.ts)
- Store 测试：[`tests/unit/electron/managedSessionStore.test.ts`](../../../tests/unit/electron/managedSessionStore.test.ts)
- GitHub code search 当前限制：本地 `gh` 可被找到，但尚未登录，`gh search code` 返回需要 `gh auth login` 或 `GH_TOKEN`。
- Kysely 文档确认：`createTable().addColumn().references().onDelete('cascade')`、`transaction().execute()`、`insertInto().onConflict().doUpdateSet()` 均是支持模式。

## 文件结构

- 创建：[`electron/database/migrations/054_split_managed_session_messages.ts`](../../../electron/database/migrations/054_split_managed_session_messages.ts)
  - 创建并回填 `managed_session_messages`。
  - 重建 `managed_sessions` 去掉 `messages`。
  - 重建主表索引。
  - 提供可用的 `down()` 将消息合回主表。
- 修改：[`electron/database/migrations/provider.ts`](../../../electron/database/migrations/provider.ts)
  - 静态导入并注册 `054_split_managed_session_messages`。
- 修改：[`electron/database/types.ts`](../../../electron/database/types.ts)
  - 从 `ManagedSessionTable` 删除 `messages`。
  - 新增 `ManagedSessionMessageTable`。
  - `Database` 增加 `managed_session_messages`。
- 修改：[`electron/services/mappers/managedSessionRowMapper.ts`](../../../electron/services/mappers/managedSessionRowMapper.ts)
  - `managedSessionRowToInfo(row, messagesJson)` 显式接收消息 JSON。
  - `managedSessionInfoToRow(session)` 只返回主表 row。
  - 新增 `managedSessionInfoToMessagesRow(session)`。
  - 增加安全消息 JSON 解析，解析失败时返回空数组。
- 修改：[`electron/services/managedSessionStore.ts`](../../../electron/services/managedSessionStore.ts)
  - `save()` 使用事务分别 upsert 主表和消息表。
  - `get()` / `findBySessionRefs()` 在定位元数据后读取消息正文。
  - `list()` 只读取主表元数据，返回空消息数组。
  - `remove()` 保持删除主表，依赖外键级联。
- 修改：[`tests/unit/electron/managedSessionStore.test.ts`](../../../tests/unit/electron/managedSessionStore.test.ts)
  - 增加红灯测试覆盖 list/get/upsert/remove/schema 行为。

---

### 任务 1：添加 Store 层失败测试

**文件：**
- 修改：[`tests/unit/electron/managedSessionStore.test.ts`](../../../tests/unit/electron/managedSessionStore.test.ts)

- [ ] **步骤 1：在 `save` 分组中添加 upsert 消息表测试**

```ts
it('updates split message storage when an existing session is upserted', async () => {
  await store.save(makeSession({
    id: 'ccb-msg-upsert-1',
    messages: [
      {
        id: 'msg-old',
        role: 'user',
        content: [{ type: 'text', text: 'old message' }],
        timestamp: 1,
      },
    ],
  }))

  await store.save(makeSession({
    id: 'ccb-msg-upsert-1',
    messages: [
      {
        id: 'msg-new',
        role: 'assistant',
        content: [{ type: 'text', text: 'new message' }],
        timestamp: 2,
      },
    ],
  }))

  const row = await db
    .selectFrom('managed_session_messages')
    .select(['session_id', 'messages'])
    .where('session_id', '=', 'ccb-msg-upsert-1')
    .executeTakeFirstOrThrow()

  expect(row.session_id).toBe('ccb-msg-upsert-1')
  expect(JSON.parse(row.messages)).toEqual([
    {
      id: 'msg-new',
      role: 'assistant',
      content: [{ type: 'text', text: 'new message' }],
      timestamp: 2,
    },
  ])
})
```

- [ ] **步骤 2：在 `list` 行为附近添加列表不读取消息正文测试**

```ts
it('omits message bodies from list results', async () => {
  await store.save(makeSession({
    id: 'ccb-list-metadata-only-1',
    messages: [
      {
        id: 'msg-heavy',
        role: 'user',
        content: [{ type: 'text', text: 'large body' }],
        timestamp: 1,
      },
    ],
  }))

  const [listed] = await store.list()

  expect(listed.id).toBe('ccb-list-metadata-only-1')
  expect(listed.messages).toEqual([])
})
```

- [ ] **步骤 3：在 `get` 分组中添加详情读取消息正文测试**

```ts
it('loads message bodies from split storage for session details', async () => {
  await store.save(makeSession({
    id: 'ccb-get-messages-1',
    messages: [
      {
        id: 'msg-detail',
        role: 'assistant',
        content: [{ type: 'text', text: 'detail body' }],
        timestamp: 1,
      },
    ],
  }))

  const loaded = await store.get('ccb-get-messages-1')

  expect(loaded?.messages).toEqual([
    {
      id: 'msg-detail',
      role: 'assistant',
      content: [{ type: 'text', text: 'detail body' }],
      timestamp: 1,
    },
  ])
})
```

- [ ] **步骤 4：在 `remove` 分组中添加级联删除测试**

```ts
it('cascades message storage removal when a session is deleted', async () => {
  await store.save(makeSession({
    id: 'ccb-del-messages-1',
    messages: [
      {
        id: 'msg-delete',
        role: 'user',
        content: [{ type: 'text', text: 'delete me' }],
        timestamp: 1,
      },
    ],
  }))

  await store.remove('ccb-del-messages-1')

  const row = await db
    .selectFrom('managed_session_messages')
    .select('session_id')
    .where('session_id', '=', 'ccb-del-messages-1')
    .executeTakeFirst()

  expect(row).toBeUndefined()
})
```

- [ ] **步骤 5：添加 schema 迁移测试**

```ts
it('migrates messages out of the managed_sessions table', async () => {
  const columns = await db
    .selectFrom('pragma_table_info("managed_sessions")')
    .select(['name'])
    .execute()

  expect(columns.map((column) => column.name)).not.toContain('messages')

  const messageColumns = await db
    .selectFrom('pragma_table_info("managed_session_messages")')
    .select(['name'])
    .execute()

  expect(messageColumns.map((column) => column.name)).toEqual(['session_id', 'messages'])
})
```

如果 Kysely 类型不接受 `pragma_table_info`，改用 `sql<{ name: string }>`：

```ts
const columns = await sql<{ name: string }>`PRAGMA table_info(managed_sessions)`.execute(db)
expect(columns.rows.map((column) => column.name)).not.toContain('messages')
```

- [ ] **步骤 6：运行测试验证红灯**

运行：

```bash
pnpm exec vitest run tests/unit/electron/managedSessionStore.test.ts
```

预期：FAIL。失败原因应包含 `managed_session_messages` 表或类型/列不存在；如果测试编译失败，也应是因为新表类型尚未实现。

---

### 任务 2：实现迁移和数据库类型

**文件：**
- 创建：[`electron/database/migrations/054_split_managed_session_messages.ts`](../../../electron/database/migrations/054_split_managed_session_messages.ts)
- 修改：[`electron/database/migrations/provider.ts`](../../../electron/database/migrations/provider.ts)
- 修改：[`electron/database/types.ts`](../../../electron/database/types.ts)

- [ ] **步骤 1：创建迁移文件**

核心 `up()` 结构：

```ts
// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db)

  try {
    await sql`
      CREATE TABLE managed_session_messages (
        session_id TEXT PRIMARY KEY REFERENCES managed_sessions(id) ON DELETE CASCADE,
        messages   TEXT NOT NULL DEFAULT '[]'
      )
    `.execute(db)

    await sql`
      INSERT INTO managed_session_messages (session_id, messages)
      SELECT id, messages
      FROM managed_sessions
    `.execute(db)

    await sql`
      CREATE TABLE managed_sessions_new (
        id                  TEXT    PRIMARY KEY NOT NULL,
        sdk_session_id      TEXT,
        engine_kind         TEXT    NOT NULL DEFAULT 'claude',
        engine_state_json   TEXT,
        state               TEXT    NOT NULL,
        stop_reason         TEXT,
        origin_source       TEXT    NOT NULL DEFAULT 'agent',
        origin_id           TEXT,
        origin_extra        TEXT,
        project_path        TEXT,
        project_id          TEXT,
        desired_engine_kind TEXT,
        desired_model       TEXT,
        model               TEXT,
        created_at          INTEGER NOT NULL,
        last_activity       INTEGER NOT NULL,
        active_duration_ms  REAL    NOT NULL DEFAULT 0,
        active_started_at   REAL,
        total_cost_usd      REAL    NOT NULL DEFAULT 0,
        input_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens       INTEGER NOT NULL DEFAULT 0,
        last_input_tokens   INTEGER NOT NULL DEFAULT 0,
        activity            TEXT,
        error               TEXT,
        execution_context   TEXT
      )
    `.execute(db)

    await sql`
      INSERT INTO managed_sessions_new (
        id, sdk_session_id, engine_kind, engine_state_json,
        state, stop_reason, origin_source, origin_id, origin_extra,
        project_path, project_id, desired_engine_kind, desired_model, model,
        created_at, last_activity, active_duration_ms, active_started_at,
        total_cost_usd, input_tokens, output_tokens, last_input_tokens,
        activity, error, execution_context
      )
      SELECT
        id, sdk_session_id, engine_kind, engine_state_json,
        state, stop_reason, origin_source, origin_id, origin_extra,
        project_path, project_id, desired_engine_kind, desired_model, model,
        created_at, last_activity, active_duration_ms, active_started_at,
        total_cost_usd, input_tokens, output_tokens, last_input_tokens,
        activity, error, execution_context
      FROM managed_sessions
    `.execute(db)

    await sql`DROP TABLE managed_sessions`.execute(db)
    await sql`ALTER TABLE managed_sessions_new RENAME TO managed_sessions`.execute(db)

    await recreateManagedSessionIndexes(db)
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db)
  }
}
```

`down()` 反向创建带 `messages` 的 `managed_sessions_new`，使用：

```sql
COALESCE(msm.messages, '[]') AS messages
```

复制完成后删除旧主表、重命名新表、重建索引、删除 `managed_session_messages`。

- [ ] **步骤 2：在 provider 注册迁移**

```ts
import * as m054 from './054_split_managed_session_messages'
```

并在 record 末尾添加：

```ts
'054_split_managed_session_messages': m054,
```

- [ ] **步骤 3：更新数据库类型**

从 `ManagedSessionTable` 删除：

```ts
messages: string // JSON array: ManagedSessionMessage[]
```

新增：

```ts
export interface ManagedSessionMessageTable {
  session_id: string
  messages: string // JSON array: ManagedSessionMessage[]
}
```

`Database` 增加：

```ts
managed_session_messages: ManagedSessionMessageTable
```

- [ ] **步骤 4：运行测试确认仍然红灯但迁移问题减少**

运行：

```bash
pnpm exec vitest run tests/unit/electron/managedSessionStore.test.ts
```

预期：仍 FAIL，因为 mapper/store 还在访问主表 `messages` 或未写消息表。

---

### 任务 3：实现 mapper 拆分

**文件：**
- 修改：[`electron/services/mappers/managedSessionRowMapper.ts`](../../../electron/services/mappers/managedSessionRowMapper.ts)

- [ ] **步骤 1：调整 import 类型**

```ts
import type { ManagedSessionMessageTable, ManagedSessionTable } from '../../database/types'
```

- [ ] **步骤 2：新增消息解析 helper**

```ts
function parseMessages(raw: string): ManagedSessionMessage[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ManagedSessionMessage[]) : []
  } catch {
    return []
  }
}
```

- [ ] **步骤 3：修改 row 到 info 签名**

```ts
export function managedSessionRowToInfo(
  row: ManagedSessionTable,
  messagesJson: string,
): ManagedSessionInfo {
  // ...
  messages: parseMessages(messagesJson),
  // ...
}
```

- [ ] **步骤 4：保留主表 row 映射但不返回 messages**

`managedSessionInfoToRow(session)` 返回对象中删除：

```ts
messages: JSON.stringify(session.messages),
```

- [ ] **步骤 5：新增消息表 row 映射**

```ts
export function managedSessionInfoToMessagesRow(
  session: ManagedSessionInfo,
): ManagedSessionMessageTable {
  return {
    session_id: session.id,
    messages: JSON.stringify(session.messages),
  }
}
```

- [ ] **步骤 6：运行测试确认 store 仍红灯**

运行：

```bash
pnpm exec vitest run tests/unit/electron/managedSessionStore.test.ts
```

预期：FAIL。失败点应集中到 store 调用签名和消息表读写。

---

### 任务 4：实现 ManagedSessionStore 拆表读写

**文件：**
- 修改：[`electron/services/managedSessionStore.ts`](../../../electron/services/managedSessionStore.ts)

- [ ] **步骤 1：更新 mapper import**

```ts
import {
  managedSessionInfoToMessagesRow,
  managedSessionInfoToRow,
  managedSessionRowToInfo,
} from './mappers/managedSessionRowMapper'
```

- [ ] **步骤 2：添加主表列清单和消息读取 helper**

```ts
const MANAGED_SESSION_COLUMNS = [
  'id',
  'sdk_session_id',
  'engine_kind',
  'engine_state_json',
  'state',
  'stop_reason',
  'origin_source',
  'origin_id',
  'origin_extra',
  'project_path',
  'project_id',
  'desired_engine_kind',
  'desired_model',
  'model',
  'created_at',
  'last_activity',
  'active_duration_ms',
  'active_started_at',
  'total_cost_usd',
  'input_tokens',
  'output_tokens',
  'last_input_tokens',
  'activity',
  'error',
  'execution_context',
] as const
```

```ts
private async getMessagesJson(sessionId: string): Promise<string> {
  const row = await this.db
    .selectFrom('managed_session_messages')
    .select('messages')
    .where('session_id', '=', sessionId)
    .executeTakeFirst()

  return row?.messages ?? '[]'
}
```

- [ ] **步骤 3：让 save 使用事务写两张表**

```ts
async save(session: ManagedSessionInfo): Promise<void> {
  const row = managedSessionInfoToRow(session)
  const messagesRow = managedSessionInfoToMessagesRow(session)

  await this.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('managed_sessions')
      .values(row)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          sdk_session_id: row.sdk_session_id,
          engine_kind: row.engine_kind,
          engine_state_json: row.engine_state_json,
          state: row.state,
          stop_reason: row.stop_reason,
          origin_source: row.origin_source,
          origin_id: row.origin_id,
          origin_extra: row.origin_extra,
          project_path: row.project_path,
          project_id: row.project_id,
          desired_engine_kind: row.desired_engine_kind,
          desired_model: row.desired_model,
          model: row.model,
          created_at: row.created_at,
          last_activity: row.last_activity,
          active_duration_ms: row.active_duration_ms,
          active_started_at: row.active_started_at,
          total_cost_usd: row.total_cost_usd,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          last_input_tokens: row.last_input_tokens,
          activity: row.activity,
          error: row.error,
          execution_context: row.execution_context,
        })
      )
      .execute()

    await trx
      .insertInto('managed_session_messages')
      .values(messagesRow)
      .onConflict((oc) =>
        oc.column('session_id').doUpdateSet({
          messages: messagesRow.messages,
        })
      )
      .execute()
  })
}
```

- [ ] **步骤 4：更新 get 和 findBySessionRefs**

`get()`：

```ts
const row = await this.db
  .selectFrom('managed_sessions')
  .select(MANAGED_SESSION_COLUMNS)
  .where('id', '=', sessionId)
  .executeTakeFirst()

if (!row) return null
return managedSessionRowToInfo(row, await this.getMessagesJson(row.id))
```

`findBySessionRefs()` 中两个匹配分支都用 `select(MANAGED_SESSION_COLUMNS)`，返回前读取消息正文。

- [ ] **步骤 5：更新 list**

```ts
let query = this.db
  .selectFrom('managed_sessions')
  .select(MANAGED_SESSION_COLUMNS)
  .orderBy('last_activity', 'desc')
```

最后：

```ts
return rows.map((row) => managedSessionRowToInfo(row, '[]'))
```

- [ ] **步骤 6：运行测试验证绿灯**

运行：

```bash
pnpm exec vitest run tests/unit/electron/managedSessionStore.test.ts
```

预期：PASS。

---

### 任务 5：全量验证和审查

**文件：**
- 修改后的所有文件。

- [ ] **步骤 1：运行目标测试**

```bash
pnpm exec vitest run tests/unit/electron/managedSessionStore.test.ts
```

预期：PASS。

- [ ] **步骤 2：运行类型检查**

```bash
pnpm typecheck
```

预期：0 errors。

- [ ] **步骤 3：运行 lint**

```bash
pnpm lint
```

预期：0 warnings / 0 errors。

- [ ] **步骤 4：审查 diff**

```bash
git diff -- electron/database/migrations/054_split_managed_session_messages.ts electron/database/migrations/provider.ts electron/database/types.ts electron/services/mappers/managedSessionRowMapper.ts electron/services/managedSessionStore.ts tests/unit/electron/managedSessionStore.test.ts
```

检查：

- `list()` 没有读取 `managed_session_messages`。
- `get()` 和 `findBySessionRefs()` 会读取消息正文。
- `save()` 使用事务。
- `remove()` 没有手动删除消息表，依赖 cascade。
- 迁移覆盖当前主表所有列。

- [ ] **步骤 5：Commit**

```bash
git add docs/superpowers/specs/2026-06-09-split-managed-session-messages-design.md docs/superpowers/plans/2026-06-09-split-managed-session-messages.md electron/database/migrations/054_split_managed_session_messages.ts electron/database/migrations/provider.ts electron/database/types.ts electron/services/mappers/managedSessionRowMapper.ts electron/services/managedSessionStore.ts tests/unit/electron/managedSessionStore.test.ts
git commit -m "perf: split managed session messages storage"
```

---

## 自检结果

- 规格覆盖度：列表元数据读取、详情按需读取、消息表迁移、级联删除、upsert 同步和测试验证均有对应任务。
- 占位符扫描：未保留 `TODO`、`待定`、`后续实现` 作为执行步骤。
- 类型一致性：新表统一命名为 `managed_session_messages`，TypeScript 类型统一命名为 `ManagedSessionMessageTable`，mapper 函数统一使用 `managedSessionInfoToMessagesRow`。
