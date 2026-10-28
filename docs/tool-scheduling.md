# 工具调度与去重

本文描述 agent loop 里「一次模型返回多个工具调用」时如何调度、互斥和去重。
所有并发相关的元数据集中在 `src/agent/tool-metadata.js`，调度在 `src/agent/tool-scheduler.js`，
去重在 `src/agent/runner.js`（调用级）和 `src/app/send-registry.js`（发送级）。

## 1. 工具分类：安全等级、预算、互斥资源域

每个工具在三张维度上登记，权限判定仍由 `tool-policy.js` 独立负责：

| 维度 | 取值 | 作用 |
| --- | --- | --- |
| `safety` | `read` / `send` / `write` / `admin` | 只有 `read` 可以和其他只读调用同波并行 |
| `budget` | 正整数 | 单次 agent run 内的调用次数上限，去重命中不计数 |
| `lockKey` | 字符串 | 副作用工具的资源域；同键串行，异键并行 |

当前分类（节选）：

| 工具 | safety | budget | lockKey |
| --- | --- | --- | --- |
| `web_search` / `web_fetch` / `list_stickers` | read | 3 | — |
| `get_msg` | read | 5 | — |
| `get_image` / `read_file` | read | 4 | — |
| `history` / `memory_query` / `get_recent_messages` / `group_member_directory` | read | 3 | — |
| `resolve_group_member` | read | 4 | — |
| `send_group_msg` / `send_private_msg` | send | 3 | `send:<chatKey>` |
| `send_sticker` | send | 2 | `send:<chatKey>` |
| `collect_sticker` / `annotate_sticker` | write | 2 | `sticker:store` |
| `memory_append` / `memory_remove` | write | 2 | `memory:impressions:<group>` |
| `write_file` / `edit_file` | write | 2 | `file:<path>` |
| `bot_feature`（读 action） | read | 4 | — |
| `bot_feature`（写 / 管理 action） | write / admin | 4 | `feature:<family>:<group>` |
| `bot_feature`（`send_poke`） | send | 4 | `send:<chatKey>` |

`group_member_directory` 会写成员缓存，但它对用户是只读查询，缓存写入又是同步的读改写，
不会出现撕裂读，因此按 `read` 处理，允许和同批查询并行。

超过预算的调用只跳过、不执行：结果照常回给模型以保证 `tool_calls` 协议完整，
但措辞是中性的「调用未执行」，并提示模型不要向用户提及工具次数或上限。
用户侧不会收到任何「已达上限」类兜底消息。

## 2. 波次调度

模型一次返回多个调用时，按顺序切成波次，而不是「全只读才并行、否则全串行」：

```
[read_a, read_b, send_x, read_c, read_d]
  → 波1(read_a, read_b) 并行
  → 波2(send_x)         独占
  → 波3(read_c, read_d) 并行
```

- 相邻只读调用合波，受 `AI_TOOL_PARALLEL_MAX` 限制（默认 4）；
- 发送/写入/删除/管理类调用各自独占一波，严格按模型返回顺序逐个执行；
- 结果按原始顺序回填，`batchId` 语义不变，回填到模型的消息仍是标准的
  `assistant.tool_calls` + 一条 `tool` 结果；
- `isReadOnly` 抛错时按副作用处理，不会让整批崩溃。

只读调用**不**与写操作跨波并行：`memory_append` 之后的 `memory_query`、`send` 之后的
`history` 都可能读到中间态，收益小、风险大。

## 3. 互斥锁

`tool-executor.js` 用 keyed mutex 取代了原来的全局 `mutationTail`：

- 只读调用直接执行，不取锁、不等待任何写操作；
- 副作用调用按 `lockKey` 排队，同键串行、异键并行；
- 进程内保留 `AI_TOOL_WRITE_LOCK` 开关做灰度：`keyed`（默认）、`global`（全局串行）、`none`。

会话级发送顺序（同一群/同一私聊的气泡顺序）由 `send:<chatKey>` 保证；
不同群的发送、不同文件的写入互不阻塞。

## 4. 去重

### 4.1 调用级（run 内）

指纹 = 工具名 + 参数稳定序列化；同一轮 run 内完全相同的调用复用第一次结果，
并在回填结果的 `note` 里告诉模型「已执行过，不要重复调用」。

失败结果按语义区分：

| kind | 含义 | 是否缓存 | 是否重试 |
| --- | --- | --- | --- |
| `ok` | 成功 | 是 | — |
| `fatal` | 确定性失败（参数错误、权限、业务拒绝） | 是 | 否 |
| `retryable` | 瞬时失败（网络、OneBot 返回失败） | 否 | 最多重试 1 次 |
| `uncertain` | 状态未知（OneBot 超时，可能已执行） | 否 | **永不重试** |

`uncertain` 是防重复发送的关键：`sendAction` 超时后请求可能已经到了协议端，
重试会造成用户看到两条一样的消息，所以工具层直接给出「状态未知、不要重复发送」。

### 4.2 发送级（会话 + 时间窗）

`send-registry.js` 维护 `会话键 + 内容指纹 → 最近成功时间`：

- 内容指纹会归一化文本空白、合并多个文本段、忽略引用/@/表情修饰段，
  图片按 `file/url`、表情按 `sticker_id` 取指纹；
- **只有发送成功后才记账**，失败和超时的条目允许正常重试；
- 工具发送（`send_group_msg` / `send_private_msg` / `send_sticker`）和最终文本发送
  （`sendReplyBatches`）共用同一份指纹，所以「模型用工具发一遍 + 最终文本再发一遍」
  只会真正发出一条；
- 窗口由 `AI_SEND_DEDUPE_MS` 控制（默认 9000ms，`0` 关闭）。

已知取舍：9 秒内对同一会话两次完全相同的回复会被合并成一条。这是为了换取
「不重复刷屏」，与参考项目发送层的策略一致。

## 5. 时间预算与停滞保护

- `AI_TURN_DEADLINE_MS`（默认 60000）限制单轮 run 的总耗时；步与步之间检查，
  波次开始前也会检查，超时后用已有文本收尾（`stoppedReason: 'deadline'`）；
- 连续两轮的工具调用全部被去重或超限跳过时提前结束（`stoppedReason: 'stalled'`），
  不再为原地打转的模型多付请求；
- 每次 run 结束打印一行结构化摘要：
  `steps / 工具 / 执行 / 重试 / 去重 / 超限 / 并行波次 / 耗时`，用于调参和线上对比。

## 6. 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AI_TOOL_PARALLEL_MAX` | 4 | 同一波只读调用的最大并行数 |
| `AI_TURN_DEADLINE_MS` | 60000 | 单轮 run 的总时间预算 |
| `AI_TOOL_WRITE_LOCK` | keyed | 副作用互斥粒度：`keyed` / `global` / `none` |
| `AI_SEND_DEDUPE_MS` | 9000 | 会话级发送指纹窗口，`0` 关闭 |

## 7. 测试

| 文件 | 覆盖内容 |
| --- | --- |
| `test/tool-metadata.test.js` | 分类表、预算、锁键（会话/文件/回复池/成员印象）、未知工具兜底 |
| `test/tool-scheduler.test.js` | 波次切分、并发上限、顺序保持、超时跳过、异常兜底 |
| `test/agent-runner.test.js` | 混合批次、可重试失败重试一次、`uncertain` 不重试、预算、停滞、deadline |
| `test/send-registry.test.js` | 工具/文本指纹互通、引用忽略、跨会话隔离、窗口过期、关闭开关 |
| `test/tool-executor.test.js` | 资源域锁、只读不被写阻塞、重复发送只落一次、失败与超时可重试性 |

## 8. 后续（待测量后再做）

以下两项先不动，等线上摘要日志积累出「每轮工具调用数 / 并行波次占比」再决定：

1. 编排层前置 IO 并行：`message-handler` 里的 `resolveMediaSources`、
   `resolveForwardedRecords`、引用消息读取可以并行（`classifyAddressing` 依赖引用文本，需要分两批）；
2. AI 请求队列是否按「模型步」让出并发槽，而不是整轮 run 独占一个槽。
