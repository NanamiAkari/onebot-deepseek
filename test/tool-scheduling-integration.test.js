const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createAgentRunner } = require('../src/agent/runner')
const { createToolExecutor } = require('../src/agent/tool-executor')
const { createDefaultToolRegistry } = require('../src/agent/tools')
const { createSendRegistry } = require('../src/app/send-registry')

// 用真实的注册表 + 执行器 + 调度器走一遍，确认三者的接线是通的。
function createWiring(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-scheduling-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const timeline = []
  const sendRegistry = createSendRegistry({ ttlMs: 9000 })
  const registry = createDefaultToolRegistry({ botFeatures: true, memberMemory: false })
  const executor = createToolExecutor({
    workspaceRoot: path.join(root, 'tool_workspace'),
    getHistoryRaw: () => [{ role: 'user', content: '上一句' }],
    sendRegistry,
    sendAction: async (_ws, action, params) => {
      timeline.push({ action, params, at: Date.now() })
      return { status: 'ok', retcode: 0, data: { message_id: timeline.length } }
    }
  })
  const runtime = { ws: {}, payload: { message_type: 'group', group_id: 10, user_id: 20 } }
  return { registry, executor, runtime, timeline, sendRegistry, options }
}

test('real registry, executor and scheduler cooperate on a mixed batch', async (t) => {
  const wiring = createWiring(t)
  let modelCalls = 0
  const runner = createAgentRunner({
    toolRegistry: wiring.registry,
    toolExecutor: wiring.executor,
    invokeModel: async () => {
      modelCalls += 1
      if (modelCalls > 1) return { text: '完成', toolCalls: [] }
      return {
        toolCalls: [
          { id: 'h1', name: 'history', arguments: { session_key: 'k1' } },
          { id: 'i1', name: 'get_image', arguments: { file: 'a.jpg' } },
          { id: 's1', name: 'send_group_msg', arguments: { group_id: 10, message: [{ type: 'text', data: { text: '来了' } }] } },
          { id: 'h2', name: 'history', arguments: { session_key: 'k2' } }
        ]
      }
    },
    maxSteps: 3
  })
  const result = await runner.run({ message: '混合', runtime: wiring.runtime })
  assert.equal(result.text, '完成')
  assert.equal(result.toolCalls.length, 4)
  assert.equal(result.toolCalls.map((entry) => entry.ok).every(Boolean), true)
  // 只有一次真实发送，且落在两个唯一次序写操作之间。
  assert.equal(wiring.timeline.filter((item) => item.action === 'send_group_msg').length, 1)
  assert.equal(result.metrics.parallelWaves, 1)
})

test('duplicate sends inside one batch are collapsed before reaching OneBot', async (t) => {
  const wiring = createWiring(t)
  let modelCalls = 0
  const message = [{ type: 'text', data: { text: '重复' } }]
  const runner = createAgentRunner({
    toolRegistry: wiring.registry,
    toolExecutor: wiring.executor,
    invokeModel: async () => {
      modelCalls += 1
      if (modelCalls > 1) return { text: '完成', toolCalls: [] }
      return {
        toolCalls: [
          { id: 's1', name: 'send_group_msg', arguments: { group_id: 10, message } },
          { id: 's2', name: 'send_group_msg', arguments: { group_id: 10, message } }
        ]
      }
    },
    maxSteps: 3
  })
  const result = await runner.run({ message: '重复', runtime: wiring.runtime })
  assert.equal(wiring.timeline.filter((item) => item.action === 'send_group_msg').length, 1)
  assert.equal(result.toolCalls.length, 2)
  assert.equal(result.toolCalls[1].deduplicated, true)
  assert.equal(result.metrics.deduplicated, 1)
})

test('a reused send after a real failure is not deduplicated away', async (t) => {
  const wiring = createWiring(t)
  let attempts = 0
  let modelCalls = 0
  const originalSend = wiring.executor.execute.bind(wiring.executor)
  // 第一次发送失败（可重试），第二次成功：去重不能把合法的重试吞掉。
  wiring.executor.execute = async (name, args, runtime) => {
    if (name === 'send_group_msg') {
      attempts += 1
      if (attempts === 1) return { ok: false, error: 'OneBot action failed', kind: 'retryable' }
    }
    return originalSend(name, args, runtime)
  }
  const message = [{ type: 'text', data: { text: '重试发送' } }]
  const runner = createAgentRunner({
    toolRegistry: wiring.registry,
    toolExecutor: wiring.executor,
    invokeModel: async () => {
      modelCalls += 1
      if (modelCalls > 2) return { text: '完成', toolCalls: [] }
      return { toolCalls: [{ id: `s${modelCalls}`, name: 'send_group_msg', arguments: { group_id: 10, message } }] }
    },
    maxSteps: 4
  })
  const result = await runner.run({ message: '重试', runtime: wiring.runtime })
  assert.equal(attempts, 2)
  assert.equal(wiring.timeline.filter((item) => item.action === 'send_group_msg').length, 1)
  assert.equal(result.toolCalls[1].ok, true)
})
