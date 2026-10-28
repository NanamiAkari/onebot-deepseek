const test = require('node:test')
const assert = require('node:assert/strict')
const {
  chatKeyFromPayload,
  isReadOnlyTool,
  toolBudget,
  toolLockKey,
  toolSafety
} = require('../src/agent/tool-metadata')

const groupRuntime = (groupId = 10, userId = 20) => ({ payload: { message_type: 'group', group_id: groupId, user_id: userId } })

test('query tools are read-only and carry per-tool call budgets', () => {
  for (const name of ['web_search', 'web_fetch', 'get_msg', 'get_image', 'history', 'memory_query', 'get_recent_messages', 'read_file', 'list_dir']) {
    assert.equal(isReadOnlyTool(name), true, `${name} should be read-only`)
    assert.ok(toolBudget(name) >= 2, `${name} should allow at least two calls per run`)
  }
  assert.equal(isReadOnlyTool('send_group_msg'), false)
  assert.equal(isReadOnlyTool('write_file'), false)
  assert.equal(isReadOnlyTool('memory_append'), false)
  assert.equal(isReadOnlyTool('collect_sticker'), false)
})

test('bot_feature safety follows the requested action', () => {
  assert.equal(isReadOnlyTool('bot_feature', { action: 'list_custom_replies' }), true)
  assert.equal(isReadOnlyTool('bot_feature', { action: 'get_custom_reply' }), true)
  assert.equal(isReadOnlyTool('bot_feature', { action: 'add_custom_reply' }), false)
  assert.equal(isReadOnlyTool('bot_feature', { action: 'clear_scheduled_tasks' }), false)
  assert.equal(toolSafety('bot_feature', { action: 'remove_poke_reply' }), 'admin')
  assert.equal(toolSafety('bot_feature', { action: 'send_poke' }), 'send')
  // 未知 action 按最保守的写操作处理，并且仍然要求独占执行。
  assert.equal(isReadOnlyTool('bot_feature', { action: 'nope' }), false)
})

test('reads never take a lock; sends lock per conversation and files per path', () => {
  assert.equal(toolLockKey('get_msg', {}, groupRuntime()), '')
  assert.equal(toolLockKey('send_group_msg', {}, groupRuntime(10)), 'send:group:10')
  assert.equal(toolLockKey('send_group_msg', {}, groupRuntime(11)), 'send:group:11')
  assert.notEqual(toolLockKey('send_group_msg', {}, groupRuntime(10)), toolLockKey('send_group_msg', {}, groupRuntime(11)))
  assert.equal(toolLockKey('write_file', { path: 'notes/a.txt' }), 'file:notes/a.txt')
  assert.notEqual(toolLockKey('write_file', { path: 'notes/a.txt' }), toolLockKey('write_file', { path: 'notes/b.txt' }))
  // 同一资源域的同名动作互相串行，不同群互不阻塞。
  assert.equal(toolLockKey('bot_feature', { action: 'add_custom_reply' }, groupRuntime(10)), 'feature:custom-replies:10')
  assert.equal(toolLockKey('memory_append', {}, groupRuntime(10)), 'memory:impressions:10')
})

test('unknown tools stay conservative', () => {
  assert.equal(isReadOnlyTool('not_a_real_tool'), false)
  assert.equal(toolBudget('not_a_real_tool'), 2)
  assert.equal(toolLockKey('not_a_real_tool', {}, groupRuntime()), 'tool:unknown')
})

test('chat keys distinguish groups from private chats', () => {
  assert.equal(chatKeyFromPayload({ message_type: 'group', group_id: 10 }), 'group:10')
  assert.equal(chatKeyFromPayload({ message_type: 'private', user_id: 20 }), 'private:20')
  assert.equal(chatKeyFromPayload(null), 'chat:unknown')
})
