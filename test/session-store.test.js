const test = require('node:test')
const assert = require('node:assert/strict')
const { createSessionStore } = require('../src/session/store')

function makeStore(overrides = {}) {
  return createSessionStore({
    AI_CONTEXT_ENABLE: true,
    AI_CONTEXT_WINDOW: 6,
    AI_CONTEXT_TTL: 900,
    AI_GROUP_CONTEXT_MESSAGES: 6,
    AI_GROUP_CONTEXT_MAX_CHARS: 3000,
    AI_GROUP_CONTEXT_TTL: 300,
    AI_RUNTIME_CACHE_MAX: 1000,
    ...overrides
  })
}

function message(id, userId = 2, groupId = 1, name = `成员${userId}`) {
  return { message_type: 'group', message_id: id, user_id: userId, group_id: groupId, self_id: 1000, sender: { card: name } }
}

function contents(store, payload, text = '') {
  return store.getRecentGroupContext(payload, text).map((item) => item.content)
}

test('excludes the current message by ID even after its AI prefix has been stripped', () => {
  const store = makeStore()
  store.recordGroupMessage(message(1), '前一条消息')
  const current = message(2)
  store.recordGroupMessage(current, '阿卡林 你觉得呢')
  const context = contents(store, { ...current }, '你觉得呢')
  assert.equal(context.length, 1)
  assert.match(context[0], /前一条消息$/)
})

test('retains identical text sent by other people and earlier messages from the same person', () => {
  const store = makeStore()
  store.recordGroupMessage(message(1, 2), '你觉得呢')
  store.recordGroupMessage(message(2, 3), '你觉得呢')
  const current = message(3, 2)
  store.recordGroupMessage(current, '你觉得呢')
  assert.deepEqual(contents(store, current, '你觉得呢'), [
    '成员2（QQ:2）：你觉得呢',
    '成员3（QQ:3）：你觉得呢'
  ])
})

test('uses the original event identity when there is no message ID', () => {
  const store = makeStore()
  store.recordGroupMessage(message(undefined, 3), '相同内容')
  const current = message(undefined, 2)
  store.recordGroupMessage(current, '相同内容')
  store.recordGroupMessage(message(undefined, 4), '后来的消息')
  assert.deepEqual(contents(store, current, '相同内容'), ['成员3（QQ:3）：相同内容'])
  // A copied event with no identity cannot safely identify a point in the stream.
  assert.deepEqual(contents(store, { ...current }, '相同内容'), [])
})

test('excludes messages received while the current event is waiting in a queue', () => {
  const store = makeStore()
  store.recordGroupMessage(message(1), '接收在前')
  const current = message(2)
  store.recordGroupMessage(current, '当前提问')
  store.recordGroupMessage(message(3), '接收在后')
  assert.deepEqual(contents(store, current), ['成员2（QQ:2）：接收在前'])
})

test('does not leak future messages after the current event has fallen out of the cache', () => {
  const store = makeStore({ AI_GROUP_CONTEXT_MESSAGES: 2 })
  const current = message(1)
  store.recordGroupMessage(current, '当前提问')
  for (let id = 2; id < 12; id += 1) store.recordGroupMessage(message(id), `未来消息${id}`)
  assert.deepEqual(contents(store, current), [])
  assert.deepEqual(contents(store, { ...current }), [])
})

test('bounds long messages individually and enforces the total output budget', () => {
  const store = makeStore({ AI_GROUP_CONTEXT_MAX_CHARS: 2300 })
  store.recordGroupMessage(message(1), '甲'.repeat(50000))
  store.recordGroupMessage(message(2), '乙'.repeat(50000))
  const current = message(3)
  store.recordGroupMessage(current, '现在')
  const context = contents(store, current)
  assert.equal(context.length, 2)
  assert.ok(context.every((text) => text.length <= 2000))
  assert.equal(context.reduce((total, text) => total + text.length, 0), 2300)
  assert.match(context[1], /^成员2（QQ:2）：乙+/)
})

test('keeps groups isolated and expires adjacent context consistently on reads and cleanup', (t) => {
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  const store = makeStore({ AI_GROUP_CONTEXT_TTL: 2 })
  store.recordGroupMessage(message(1, 2, 1), '第一群')
  store.recordGroupMessage(message(1, 2, 2), '第二群')
  now += 1000
  const current = message(2, 2, 1)
  store.recordGroupMessage(current, '当前')
  assert.deepEqual(contents(store, current), ['成员2（QQ:2）：第一群'])
  now += 1001
  assert.deepEqual(contents(store, current), [])
  store.cleanup(now)
  assert.deepEqual(contents(store, current), [])
})

test('ignores the bot own inbound messages and deduplicates protocol message IDs', () => {
  const store = makeStore()
  store.recordGroupMessage(message(1, 1000), '机器人自己的回声')
  store.recordGroupMessage(message(2, 2), '用户消息')
  store.recordGroupMessage(message(2, 2), '用户消息重复事件')
  const current = message(3, 3)
  store.recordGroupMessage(current, '当前')
  assert.deepEqual(contents(store, current), ['成员2（QQ:2）：用户消息'])
  assert.deepEqual(contents(store, message(4, 1000)), [])
})

test('group conversation history records speaker identity, length and turn limits', () => {
  const store = makeStore({ AI_CONTEXT_WINDOW: 2 })
  store.pushHistory(message(1, 2, 1, '小明'), '第一人'.repeat(3000), '回复'.repeat(3000))
  store.pushHistory(message(2, 3, 1, '小明'), '同名第二人', '第二个回复')
  const history = store.getContext(message(3), '继续')
  assert.equal(history.length, 4)
  assert.match(history[0].content, /^小明（QQ:2）：/)
  assert.match(history[2].content, /^小明（QQ:3）：同名第二人$/)
  assert.ok(history.every((item) => item.content.length <= 2000))
  store.pushHistory(message(3, 4), '第三人', '第三个回复')
  assert.equal(store.getHistoryRaw(message(4)).length, 4)
  assert.match(store.getHistoryRaw(message(4))[0].content, /QQ:3/)
  assert.deepEqual(store.getHistoryRaw(message(4, 2, 2)), [])
})

test('history excludes later received turns and honors its TTL', (t) => {
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  const store = makeStore({ AI_CONTEXT_TTL: 2 })
  const previous = message(1)
  store.recordGroupMessage(previous, '之前')
  store.pushHistory(previous, '之前', '之前的回复')
  const current = message(2)
  store.recordGroupMessage(current, '现在')
  const later = message(3)
  store.recordGroupMessage(later, '后来')
  store.pushHistory(later, '后来', '后来的回复')
  assert.equal(store.getContext(current, '继续').length, 2)
  assert.match(store.getContext(current, '继续')[0].content, /之前$/)
  now += 2001
  assert.deepEqual(store.getHistoryRaw(current), [])
})

test('clearHistory clears both model history and adjacent messages for only that chat', () => {
  const store = makeStore()
  store.recordGroupMessage(message(1), '旧群聊')
  store.pushHistory(message(1), '旧问题', '旧回复')
  store.recordGroupMessage(message(1, 2, 2), '其他群')
  store.clearHistory(message(2))
  const current = message(3)
  store.recordGroupMessage(current, '新问题')
  assert.deepEqual(contents(store, current), [])
  assert.deepEqual(store.getHistoryRaw(current), [])
  const otherCurrent = message(2, 2, 2)
  store.recordGroupMessage(otherCurrent, '其他群的新问题')
  assert.deepEqual(contents(store, otherCurrent), ['成员2（QQ:2）：其他群'])
})

test('respects adjacent message counts and a disabled history window', () => {
  const store = makeStore({ AI_GROUP_CONTEXT_MESSAGES: 2, AI_CONTEXT_WINDOW: 0 })
  for (let id = 1; id <= 6; id += 1) store.recordGroupMessage(message(id), `消息${id}`)
  const current = message(7)
  store.recordGroupMessage(current, '当前')
  assert.deepEqual(contents(store, current), ['成员2（QQ:2）：消息5', '成员2（QQ:2）：消息6'])
  store.pushHistory(message(8), '不保存', '回复')
  assert.deepEqual(store.getHistoryRaw(message(9)), [])
})
