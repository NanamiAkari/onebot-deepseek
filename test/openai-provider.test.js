const test = require('node:test')
const assert = require('node:assert/strict')
const { extractOpenAIText, extractOpenAIToolCalls, extractOpenAIUsage } = require('../src/providers/openai')

test('responses API: reasoning items are excluded from the reply text', () => {
  const data = {
    type: 'response.completed',
    output: [
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '我在想怎么回答' }],
        content: [{ type: 'reasoning_text', text: '先分析一下用户意图' }]
      },
      {
        type: 'message',
        content: [{ type: 'output_text', text: '这就是答案' }]
      }
    ]
  }
  assert.equal(extractOpenAIText(data), '这就是答案')
})

test('responses API: only output_text parts are collected', () => {
  const data = {
    output: [{
      type: 'message',
      content: [
        { type: 'reasoning_text', text: '内心戏' },
        { type: 'output_text', text: '正文一' },
        { type: 'summary_text', text: '摘要' },
        { type: 'output_text', text: '正文二' }
      ]
    }]
  }
  assert.equal(extractOpenAIText(data), '正文一\n正文二')
})

test('responses streaming: a reasoning item done event contributes no text', () => {
  const reasoningEvent = {
    type: 'response.output_item.done',
    item: { type: 'reasoning', content: [{ type: 'reasoning_text', text: '推理内容' }] }
  }
  const messageEvent = {
    type: 'response.output_item.done',
    item: { type: 'message', content: [{ type: 'output_text', text: '给用户的话' }] }
  }
  assert.equal(extractOpenAIText(reasoningEvent), '')
  assert.equal(extractOpenAIText(messageEvent), '给用户的话')
  // SSE 文本形态同样不能把 reasoning 事件拼进来
  const sse = [
    'data: {"type":"response.output_item.done","item":{"type":"reasoning","content":[{"type":"reasoning_text","text":"内心戏"}]}}',
    '',
    'data: {"type":"response.output_text.done","text":"最终答复"}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  assert.equal(extractOpenAIText(sse), '最终答复')
})

test('chat completions content and tool calls still parse normally', () => {
  const data = {
    choices: [{
      message: {
        content: '普通回复',
        reasoning_content: '不应出现的推理',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'history', arguments: '{"session_key":"k"}' }
        }]
      }
    }]
  }
  assert.equal(extractOpenAIText(data), '普通回复')
  assert.deepEqual(extractOpenAIToolCalls(data), [
    { id: 'call_1', name: 'history', arguments: { session_key: 'k' } }
  ])
})

test('usage is read from both chat completions and responses payloads', () => {
  assert.deepEqual(
    extractOpenAIUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }),
    { promptTokens: 120, completionTokens: 30, totalTokens: 150, reasoningTokens: 0 }
  )
  assert.deepEqual(
    extractOpenAIUsage({ usage: { input_tokens: 80, output_tokens: 20, output_tokens_details: { reasoning_tokens: 12 } } }),
    { promptTokens: 80, completionTokens: 20, totalTokens: 100, reasoningTokens: 12 }
  )
  assert.equal(extractOpenAIUsage({}), null)
  assert.equal(extractOpenAIUsage(null), null)
})

test('usage is read from the final streaming event', () => {
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"你好"}',
    '',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":40,"output_tokens":10,"total_tokens":50}}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  assert.deepEqual(extractOpenAIUsage(sse), {
    promptTokens: 40,
    completionTokens: 10,
    totalTokens: 50,
    reasoningTokens: 0
  })
})
