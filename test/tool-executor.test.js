const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { createToolExecutor } = require('../src/agent/tool-executor')
const { createDefaultToolRegistry } = require('../src/agent/tools')

const fileTools = ['read_file', 'write_file', 'edit_file', 'list_dir']
const trustedRuntime = { ws: {}, payload: { message_type: 'group', group_id: 10, user_id: 20 } }

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-tools-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspaceRoot = path.join(root, 'tool_workspace')
  const actions = []
  const executor = createToolExecutor({
    workspaceRoot,
    getHistoryRaw: () => [],
    sendAction: async (_ws, action, params) => {
      actions.push({ action, params })
      return { status: 'ok', retcode: 0, data: {} }
    },
    ...options
  })
  return { root, workspaceRoot, actions, executor }
}

function enabledFixture(t, options = {}) {
  return fixture(t, { fileToolsEnabled: true, fileToolAdminUserIds: ['20'], ...options })
}

test('file tools are absent and cannot execute by default, even for a trusted account', async (t) => {
  const { executor, workspaceRoot } = fixture(t, { fileToolAdminUserIds: ['20'] })
  const registry = createDefaultToolRegistry()
  for (const name of fileTools) {
    assert.equal(registry.get(name), undefined)
    assert.equal(executor.isAllowed(name, trustedRuntime), false)
    assert.equal((await executor.execute(name, { path: 'note.txt', content: 'hello' }, trustedRuntime)).ok, false)
  }
  assert.equal(fs.existsSync(workspaceRoot), false)
  assert.ok(createDefaultToolRegistry({ fileToolsEnabled: true }).get('read_file'))
})

test('enabling file tools requires the configured account, regardless of group role', async (t) => {
  const { executor, workspaceRoot } = enabledFixture(t)
  for (const role of ['member', 'admin', 'owner']) {
    const runtime = { payload: { message_type: 'group', group_id: 10, user_id: 21, sender: { role } } }
    assert.equal(executor.isAllowed('write_file', runtime), false)
    assert.equal((await executor.execute('write_file', { path: 'note.txt', content: 'hello' }, runtime)).ok, false)
  }
  assert.equal(executor.isAllowed('write_file', {}), false)
  assert.equal(fs.existsSync(workspaceRoot), false)
})

test('trusted accounts can read, write, edit and list inside the separate workspace', async (t) => {
  const { executor, workspaceRoot } = enabledFixture(t, { fileToolAdminUserIds: '20, 30' })
  assert.equal(executor.isAllowed('write_file', trustedRuntime), true)
  assert.equal((await executor.execute('write_file', { path: 'notes/greeting.txt', content: 'hello\nworld' }, trustedRuntime)).ok, true)
  assert.equal((await executor.execute('read_file', { path: 'notes/greeting.txt', limit: 1 }, trustedRuntime)).data.content, 'hello')
  assert.equal((await executor.execute('edit_file', { path: 'notes/greeting.txt', old_text: 'world', new_text: 'friend' }, trustedRuntime)).ok, true)
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'notes/greeting.txt'), 'utf8'), 'hello\nfriend')
  const listed = await executor.execute('list_dir', { path: 'notes' }, trustedRuntime)
  assert.deepEqual(listed.data.entries, [{ name: 'greeting.txt', type: 'file' }])
})

test('file tools reject traversal and absolute paths without exposing host paths', async (t) => {
  const { executor, root } = enabledFixture(t)
  const outside = path.join(root, 'outside.txt')
  fs.writeFileSync(outside, 'unchanged')
  for (const attempt of ['../outside.txt', 'nested/../../outside.txt', outside, '..\\outside.txt']) {
    for (const name of ['read_file', 'write_file', 'edit_file']) {
      const result = await executor.execute(name, { path: attempt, content: 'overwrite', old_text: 'unchanged', new_text: 'overwrite' }, trustedRuntime)
      assert.equal(result.ok, false)
      assert.equal(result.error.includes(root), false)
    }
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged')
})

test('file tools reject linked files and linked directory components', async (t) => {
  const { executor, root, workspaceRoot } = enabledFixture(t)
  const outsideDir = path.join(root, 'outside')
  fs.mkdirSync(outsideDir)
  fs.mkdirSync(workspaceRoot)
  const outsideFile = path.join(outsideDir, 'secret.txt')
  fs.writeFileSync(outsideFile, 'outside remains unchanged')
  fs.symlinkSync(outsideDir, path.join(workspaceRoot, 'linked-dir'), 'dir')
  fs.symlinkSync(outsideFile, path.join(workspaceRoot, 'linked-file'))
  fs.linkSync(outsideFile, path.join(workspaceRoot, 'hard-link'))
  for (const target of ['linked-file', 'linked-dir/secret.txt', 'hard-link']) {
    for (const name of ['read_file', 'write_file', 'edit_file']) {
      const result = await executor.execute(name, { path: target, content: 'overwrite', old_text: 'outside', new_text: 'overwrite' }, trustedRuntime)
      assert.equal(result.ok, false, `${name} ${target}`)
    }
  }
  assert.equal((await executor.execute('list_dir', { path: 'linked-dir' }, trustedRuntime)).ok, false)
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside remains unchanged')
})

test('a symlink at the workspace root is rejected', async (t) => {
  const { executor, root, workspaceRoot } = enabledFixture(t)
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, workspaceRoot, 'dir')
  assert.equal((await executor.execute('write_file', { path: 'note.txt', content: 'hello' }, trustedRuntime)).ok, false)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('file operations reject oversized content before overwriting existing data', async (t) => {
  const { executor, workspaceRoot } = enabledFixture(t)
  await executor.execute('write_file', { path: 'note.txt', content: 'hello' }, trustedRuntime)
  const largeText = '猫'.repeat(90000)
  assert.equal((await executor.execute('write_file', { path: 'note.txt', content: largeText }, trustedRuntime)).ok, false)
  assert.equal((await executor.execute('edit_file', { path: 'note.txt', old_text: 'hello', new_text: largeText }, trustedRuntime)).ok, false)
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'note.txt'), 'utf8'), 'hello')
  fs.writeFileSync(path.join(workspaceRoot, 'large.txt'), largeText)
  assert.equal((await executor.execute('read_file', { path: 'large.txt', limit: 1 }, trustedRuntime)).ok, false)
})

test('file tools reject FIFOs without opening or blocking on them', { skip: process.platform === 'win32' }, async (t) => {
  const { executor, workspaceRoot } = enabledFixture(t)
  fs.mkdirSync(workspaceRoot)
  const fifo = path.join(workspaceRoot, 'pipe')
  const result = spawnSync('/usr/bin/mkfifo', [fifo])
  assert.equal(result.status, 0)
  for (const name of ['read_file', 'write_file', 'edit_file']) {
    assert.equal((await executor.execute(name, { path: 'pipe', content: 'x', old_text: 'x', new_text: 'y' }, trustedRuntime)).ok, false)
  }
})

test('directory listing has a hard entry limit', async (t) => {
  const { executor, workspaceRoot } = enabledFixture(t)
  fs.mkdirSync(workspaceRoot)
  for (let index = 0; index < 501; index += 1) fs.writeFileSync(path.join(workspaceRoot, `${index}.txt`), '')
  const result = await executor.execute('list_dir', {}, trustedRuntime)
  assert.equal(result.data.entries.length, 500)
  assert.equal(result.data.truncated, true)
})

test('send tools only target the active conversation, including for trusted admins', async (t) => {
  const { executor, actions } = enabledFixture(t)
  const message = [{ type: 'text', data: { text: 'test message' } }]
  const privateRuntime = { ws: {}, payload: { message_type: 'private', user_id: 20 } }
  assert.equal(executor.isAllowed('send_private_msg', trustedRuntime), false)
  assert.equal(executor.isAllowed('send_group_msg', privateRuntime), false)
  assert.equal((await executor.execute('send_group_msg', { group_id: 11, message }, trustedRuntime)).ok, false)
  assert.equal((await executor.execute('send_private_msg', { user_id: 20, message }, trustedRuntime)).ok, false)
  assert.equal((await executor.execute('send_private_msg', { user_id: 21, message }, privateRuntime)).ok, false)
  assert.equal((await executor.execute('send_group_msg', { group_id: 10, message }, privateRuntime)).ok, false)
  assert.equal(actions.length, 0)
  assert.equal((await executor.execute('send_group_msg', { group_id: '10', message }, trustedRuntime)).ok, true)
  assert.equal((await executor.execute('send_private_msg', { user_id: '20', message }, privateRuntime)).ok, true)
  assert.deepEqual(actions.map((entry) => entry.params), [{ group_id: 10, message }, { user_id: 20, message }])
})

test('OneBot failures and internal errors are not reported as successful or exposed', async (t) => {
  for (const response of [{ status: 'failed', retcode: 100 }, { status: 'ok', retcode: 100 }, null]) {
    const { executor } = fixture(t, { sendAction: async () => response })
    const result = await executor.execute('get_msg', { message_id: 1 }, trustedRuntime)
    assert.deepEqual(result, { ok: false, error: 'OneBot action failed' })
  }
  const { executor, root } = enabledFixture(t, { sendAction: async () => { throw new Error('/private/server/secret-value') } })
  assert.deepEqual(await executor.execute('get_image', { file: 'image' }, trustedRuntime), { ok: false, error: 'Tool operation failed' })
  const missing = await executor.execute('read_file', { path: 'missing.txt' }, trustedRuntime)
  assert.equal(missing.ok, false)
  assert.equal(missing.error.includes(root), false)
  assert.equal((await executor.execute('toString', {}, trustedRuntime)).ok, false)
})

test('recent-message tool awaits storage and reports incomplete scan coverage', async (t) => {
  const messages = [{ text: 'recent observation' }]
  Object.defineProperty(messages, 'scanTruncated', { value: true })
  const { executor } = fixture(t, { memberMemory: { getRecentGroupMessages: async () => messages } })
  const result = await executor.execute('get_recent_messages', {}, trustedRuntime)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data.messages, messages)
  assert.equal(result.data.scan_truncated, true)
  assert.match(result.data.instruction, /未扫描完整历史/)
})

test('web search tool passes bounded arguments and returns structured sources', async (t) => {
  const calls = []
  const webSearch = {
    available: () => true,
    search: async (query, options) => {
      calls.push({ query, options })
      return { query, provider: 'test', answer: '实时答案', results: [{ title: '来源', url: 'https://example.com', snippet: '摘要' }] }
    }
  }
  const { executor } = fixture(t, { webSearch })
  assert.equal(executor.isAllowed('web_search', trustedRuntime), true)
  const result = await executor.execute('web_search', { query: '最新消息', max_results: 3 }, trustedRuntime)
  assert.equal(result.ok, true)
  assert.equal(result.data.answer, '实时答案')
  assert.deepEqual(calls, [{ query: '最新消息', options: { maxResults: 3 } }])
})
