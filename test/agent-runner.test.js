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
