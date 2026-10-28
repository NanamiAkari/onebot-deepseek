const test = require('node:test')
const assert = require('node:assert/strict')
const { createAgentRunner } = require('../src/agent/runner')

test('filters unavailable tools and passes bounded structured results to the next model turn', async () => {
  const seen = []
  let calls = 0
  const runner = createAgentRunner({
    toolRegistry: {
      list: () => [
        { name: 'allowed', description: 'allowed', inputSchema: { type: 'object' } },
        { name: 'blocked', description: 'blocked', inputSchema: { type: 'object' } }
      ]
    },
    toolExecutor: {
      isAllowed: (name) => name === 'allowed',
      execute: async () => ({ ok: true, data: { messages: Array.from({ length: 100 }, (_, index) => ({ index, text: 'x'.repeat(300) })), scan_truncated: true } })
    },
    invokeModel: async (input) => {
      seen.push(input)
      calls += 1
      if (calls === 1) {
        assert.deepEqual(input.tools.map((tool) => tool.name), ['allowed'])
        return { text: '', toolCalls: [{ id: 'call-1', name: 'allowed', arguments: {} }] }
      }
      return { text: '完成', toolCalls: [] }
    },
    invokeModelWithToolResult: async (input) => {
      seen.push(input)
      assert.equal(input.toolResults.length, 1)
      assert.equal(input.toolResults[0].data.scan_truncated, true)
      assert.equal(JSON.stringify(input.toolResults[0].data).length <= 12000, true)
      return { text: '完成', toolCalls: [] }
    },
    maxSteps: 3
  })
  const result = await runner.run({ message: '测试', runtime: { payload: { message_type: 'group', group_id: '1', user_id: '2' } } })
  assert.equal(result.text, '完成')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(seen.length, 2)
})

test('runs independent read-only tool calls in parallel', async () => {
  let active = 0
  let maxActive = 0
  let calls = 0
  const runner = createAgentRunner({
    toolRegistry: {
      list: () => [
        { name: 'read_a', description: 'read', inputSchema: { type: 'object' } },
        { name: 'read_b', description: 'read', inputSchema: { type: 'object' } }
      ]
    },
    toolExecutor: {
      isAllowed: () => true,
      isReadOnly: () => true,
      execute: async (name) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        active -= 1
        return { ok: true, data: { name } }
      }
    },
    invokeModel: async () => {
      calls += 1
      return calls === 1
        ? { toolCalls: [{ id: 'a', name: 'read_a', arguments: {} }, { id: 'b', name: 'read_b', arguments: {} }] }
        : { text: '完成', toolCalls: [] }
    },
    invokeModelWithToolResult: async (input) => {
      assert.equal(input.toolResults.length, 2)
      return { text: '完成', toolCalls: [] }
    },
    maxSteps: 3
  })
  const result = await runner.run({ message: '查询', runtime: {} })
  assert.equal(result.text, '完成')
  assert.equal(result.toolCalls.length, 2)
  assert.equal(maxActive, 2)
})

test('serializes side-effect calls and skips exact duplicate calls', async () => {
  const calls = []
  let active = 0
  let maxActive = 0
  let modelCalls = 0
  const runner = createAgentRunner({
    toolRegistry: {
      list: () => [
        { name: 'mutate', description: 'mutate', inputSchema: { type: 'object' } },
        { name: 'read', description: 'read', inputSchema: { type: 'object' } }
      ]
    },
    toolExecutor: {
      isAllowed: () => true,
      isReadOnly: (name) => name === 'read',
      execute: async (name) => {
        calls.push(name)
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 8))
        active -= 1
        return { ok: true, data: { name } }
      }
    },
    invokeModel: async () => {
      modelCalls += 1
      return modelCalls === 1
        ? { toolCalls: [
            { id: 'm1', name: 'mutate', arguments: { value: 1 } },
            { id: 'm2', name: 'mutate', arguments: { value: 1 } },
            { id: 'r1', name: 'read', arguments: {} }
          ] }
        : { text: '完成', toolCalls: [] }
    },
    invokeModelWithToolResult: async () => ({ text: '完成', toolCalls: [] }),
    maxSteps: 3
  })
  const result = await runner.run({ message: '修改', runtime: {} })
  assert.equal(result.text, '完成')
  assert.deepEqual(calls, ['mutate', 'read'])
  assert.equal(maxActive, 1)
  assert.equal(result.toolCalls.length, 3)
  assert.equal(result.toolCalls[1].deduplicated, true)
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readOnlyRegistry(names) {
  return { list: () => names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) }
}

test('mixed batches parallelize adjacent reads while side effects stay ordered', async () => {
  const events = []
  let active = 0
  let maxActive = 0
  let modelCalls = 0
  const names = ['read_a', 'read_b', 'mutate', 'read_c', 'read_d']
  const runner = createAgentRunner({
    toolRegistry: readOnlyRegistry(names),
    toolExecutor: {
      isAllowed: () => true,
      isReadOnly: (name) => name.startsWith('read'),
      execute: async (name) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        events.push(`start:${name}`)
        await sleep(6)
        events.push(`end:${name}`)
        active -= 1
        return { ok: true, data: { name } }
      }
    },
    invokeModel: async () => {
      modelCalls += 1
      return modelCalls === 1
        ? { toolCalls: names.map((name, index) => ({ id: `c${index}`, name, arguments: {} })) }
        : { text: '完成', toolCalls: [] }
    },
    maxSteps: 3
  })
  const result = await runner.run({ message: '混合', runtime: {} })
  assert.equal(result.text, '完成')
  assert.equal(result.toolCalls.length, 5)
  assert.equal(maxActive, 2)
  assert.equal(result.metrics.parallelWaves, 2)
  const mutateIndex = events.indexOf('start:mutate')
  assert.ok(events.indexOf('end:read_a') < mutateIndex)
  assert.ok(events.indexOf('end:read_b') < mutateIndex)
  assert.ok(mutateIndex < events.indexOf('start:read_c'))
  assert.ok(mutateIndex < events.indexOf('start:read_d'))
})

test('a retryable failure is retried once and then reused', async () => {
  let attempts = 0
  let modelCalls = 0
  const runner = createAgentRunner({
    toolRegistry: readOnlyRegistry(['flaky']),
    toolExecutor: {
      isAllowed: () => true,
      isReadOnly: () => false,
      execute: async () => {
        attempts += 1
        return attempts === 1
          ? { ok: false, error: '网络抖动', kind: 'retryable' }
          : { ok: true, data: { attempts } }
      }
    },
    invokeModel: async () => {
      modelCalls += 1
      return modelCalls <= 2 ? { toolCalls: [{ id: `c${modelCalls}`, name: 'flaky', arguments: {} }] } : { text: '完成', toolCalls: [] }
    },
    maxSteps: 4
  })
  const result = await runner.run({ message: '重试', runtime: {} })
  assert.equal(attempts, 2)
  assert.equal(result.toolCalls.length, 2)
  assert.equal(result.toolCalls[0].ok, false)
  assert.equal(result.toolCalls[1].ok, true)
  assert.equal(result.metrics.retried, 1)
})

test('an uncertain side effect is never retried', async () => {
  let attempts = 0
  let modelCalls = 0
  const runner = createAgentRunner({
    toolRegistry: readOnlyRegistry(['send_thing']),
    toolExecutor: {
      isAllowed: () => true,
      isReadOnly: () => false,
      execute: async () => {
        attempts += 1
        return { ok: false, error: 'OneBot 响应超时，操作状态未知', kind: 'uncertain' }
      }
    },
    invokeModel: async () => {
      modelCalls += 1
      return modelCalls <= 2 ? { toolCalls: [{ id: `c${modelCalls}`, name: 'send_thing', arguments: {} }] } : { text: '完成', toolCalls: [] }
    },
    maxSteps: 4
  })
  const result = await runner.run({ message: '发送', runtime: {} })
  assert.equal(attempts, 1)
  assert.equal(result.toolCalls.length, 2)
  assert.equal(result.toolCalls[1].deduplicated, true)
  assert.match(result.toolCalls[1].note, /禁止重试/)
})

test('per-tool budgets come from the shared metadata table and skips stay silent', async () => {
  let executed = 0
  let modelCalls = 0
  const runner = createAgentRunner({
    toolRegistry: readOnlyRegistry(['send_group_msg']),
    toolExecutor: {
      isAllowed: () => true,
      isReadOnly: () => false,
      execute: async () => {
        executed += 1
        return { ok: true, data: { executed } }
      }
    },
    invokeModel: async () => {
      modelCalls += 1
      return modelCalls === 1
        ? { toolCalls: [
            { id: 'a', name: 'send_group_msg', arguments: { text: '一' } },
            { id: 'b', name: 'send_group_msg', arguments: { text: '二' } },
            { id: 'c', name: 'send_group_msg', arguments: { text: '三' } },
            { id: 'd', name: 'send_group_msg', arguments: { text: '四' } }
          ] }
        : { text: '完成', toolCalls: [] }
    },
    maxSteps: 3
  })
  const result = await runner.run({ message: '四条', runtime: {} })
  assert.equal(executed, 3)
  assert.equal(result.toolCalls.length, 4)
  assert.equal(result.toolCalls[3].skipped, true)
  // 超限只是不执行：不出现“超限/上限”这类会漏给用户的措辞。
  assert.equal(/超限|上限/.test(result.toolCalls[3].error), false)
  assert.match(result.toolCalls[3].note, /不要向用户提及/)
})

test('hitting the step limit does not inject a canned reply', async () => {
  let modelCalls = 0
  const runner = createAgentRunner({
    toolRegistry: readOnlyRegistry(['read_a']),
    toolExecutor: {
      isAllowed: () => true,
      isReadOnly: () => true,
      execute: async () => ({ ok: true, data: {} })
    },
    invokeModel: async () => {
      modelCalls += 1
      // 每步换一个参数，绕过去重和预算，单纯把步数耗尽。
      return { toolCalls: [{ id: `c${modelCalls}`, name: 'read_a', arguments: { n: modelCalls } }] }
    },
    maxSteps: 2
  })
  const result = await runner.run({ message: '步数', runtime: {} })
  assert.equal(result.stoppedReason, 'max_steps')
  assert.equal(result.text, '')
})

test('a model stuck on the same batch stops instead of burning every step', async () => {
  let modelCalls = 0
  let executed = 0
  const runner = createAgentRunner({
    toolRegistry: readOnlyRegistry(['loop']),
    toolExecutor: {
      isAllowed: () => true,
      isReadOnly: () => false,
      execute: async () => {
        executed += 1
        return { ok: true, data: {} }
      }
    },
    invokeModel: async () => {
      modelCalls += 1
      return { toolCalls: [{ id: `c${modelCalls}`, name: 'loop', arguments: {} }] }
    },
    maxSteps: 10
  })
  const result = await runner.run({ message: '循环', runtime: {} })
  assert.equal(executed, 1)
  assert.equal(modelCalls, 3)
  assert.equal(result.stoppedReason, 'stalled')
})

test('the run deadline stops the loop before another model request', async () => {
  let modelCalls = 0
  const runner = createAgentRunner({
    toolRegistry: readOnlyRegistry(['read_a']),
    toolExecutor: {
      isAllowed: () => true,
      isReadOnly: () => true,
      execute: async () => ({ ok: true, data: {} })
    },
    invokeModel: async () => {
      modelCalls += 1
      await sleep(15)
      return { text: '先说到这里', toolCalls: [{ id: 'c1', name: 'read_a', arguments: {} }] }
    },
    deadlineMs: 10,
    maxSteps: 5
  })
  const result = await runner.run({ message: '超时', runtime: {} })
  assert.equal(modelCalls, 1)
  assert.equal(result.stoppedReason, 'deadline')
  assert.equal(result.text, '先说到这里')
  assert.equal(result.toolCalls[0].skipped, true)
})
