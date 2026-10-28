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
