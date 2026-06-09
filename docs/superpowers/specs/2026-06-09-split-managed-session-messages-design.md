# 拆分 managed_sessions 消息正文设计

## 摘要

将 `managed_sessions.messages` 从主表拆分到 `managed_session_messages`，让会话列表查询只读取元数据，打开单个会话详情时再按 `session_id` 读取消息正文。本次采用单独 JSON 表方案，保留现有 `ManagedSessionInfo.messages` API，不在本次实现逐条消息存储。

## 背景

当前 `managed_sessions` 表在 `messages` 大字段后面还包含 `created_at`、`last_activity` 等列表排序和展示常用元数据。`ManagedSessionStore.list()` 使用 `selectAll()` 读取主表，因此会话列表加载会把消息正文一并读出。随着会话历史增长，列表读取会被大 JSON 字段拖慢。

## 目标

- `managed_sessions` 主表只保存会话元数据。
- `managed_session_messages` 保存每个会话的完整消息 JSON。
- 列表加载不读取消息正文。
- 单会话详情、按引用查找会话时再读取消息正文。
- 现有 renderer / IPC 仍使用 `ManagedSessionInfo`，避免扩大前端改动范围。

## 非目标

- 本次不实现逐条消息行存储。
- 本次不实现详情消息分页。
- 本次不改变 `ManagedSessionInfo.messages` 的共享类型。

## 数据库设计

新增表：

```sql
CREATE TABLE managed_session_messages (
  session_id TEXT PRIMARY KEY REFERENCES managed_sessions(id) ON DELETE CASCADE,
  messages TEXT NOT NULL DEFAULT '[]'
);
```

新增迁移 `054_split_managed_session_messages`：

1. 创建 `managed_session_messages`。
2. 从旧 `managed_sessions.messages` 回填消息 JSON。
3. 通过 SQLite 表重建模式创建不含 `messages` 的 `managed_sessions_new`。
4. 复制主表元数据。
5. 删除旧主表并重命名新主表。
6. 重建主表索引。

回滚时反向执行：重建带 `messages` 的主表，从消息表合回 JSON，再删除消息表。

## Store 设计

`ManagedSessionStore.save(session)` 使用事务写入：

- `managed_sessions` upsert 元数据。
- `managed_session_messages` upsert 消息 JSON。

`ManagedSessionStore.list(limit)`：

- 只选择主表元数据列。
- 映射为 `ManagedSessionInfo` 时传入 `'[]'`，列表项不携带正文。

`ManagedSessionStore.get(sessionId)`：

- 查主表元数据。
- 查 `managed_session_messages.messages`。
- 合成完整 `ManagedSessionInfo`。

`ManagedSessionStore.findBySessionRefs(sessionRefs)`：

- 先只查主表元数据定位目标会话。
- 再按目标 `id` 读取消息正文。

`ManagedSessionStore.remove(sessionId)`：

- 删除主表行。
- 依赖 `ON DELETE CASCADE` 删除消息表行。

## 类型和映射设计

- `ManagedSessionTable` 删除 `messages` 字段。
- 新增 `ManagedSessionMessageTable`。
- `Database` 增加 `managed_session_messages`。
- `managedSessionRowToInfo(row, messagesJson)` 显式接收消息 JSON。
- `managedSessionInfoToRow(session)` 只返回主表 row。
- 新增 `managedSessionInfoToMessagesRow(session)` 返回消息表 row。

## 测试设计

- `get()` 能读取拆分消息表中的完整消息。
- `list()` 不读取消息正文，返回 `messages: []`。
- `save()` upsert 时同步更新消息表。
- `remove()` 删除主表后消息表记录被级联删除。
- 测试数据库迁移后，`managed_sessions` 不再包含 `messages` 列，并存在 `managed_session_messages` 表。

## 风险和约束

- SQLite 表重建会删除并重建索引，迁移必须覆盖当前主表所有列。
- 回滚需要合回消息 JSON，缺失消息行时使用 `'[]'`。
- 本次仍保留整段 JSON 存储，超大详情页的一次性读取问题留到后续逐条消息表方案解决。
