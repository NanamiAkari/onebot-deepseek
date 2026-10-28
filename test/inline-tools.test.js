const test = require('node:test')
const assert = require('node:assert/strict')
const { parseInlineToolCalls } = require('../src/agent/inline-tools')

const known = new Set(['send_group_msg', 'history'])

test('a tagged tool call is parsed and removed from the reply text', () => {
  const text = '我先查一下<tool_call>{"name":"history","arguments":{"session_key":"k"}}</tool_call>再回答'
  const result = parseInlineToolCalls(text, known)
  assert.deepEqual(result.calls, [{ name: 'history', arguments: { session_key: 'k' } }])
  assert.equal(result.cleanedText.includes('tool_call'), false)
  assert.match(result.cleanedText, /我先查一下/)
  assert.match(result.cleanedText, /再回答/)
})

test('function_call shape with nested function and string arguments is supported', () => {
  const text = '<function_call>{"function":{"name":"send_group_msg","arguments":"{\\"group_id\\":10}"}}</function_call>'
  const result = parseInlineToolCalls(text, known)
  assert.deepEqual(result.calls, [{ name: 'send_group_msg', arguments: { group_id: 10 } }])
  assert.equal(result.cleanedText.trim(), '')
})

test('unknown tool names are never executed, only stripped', () => {
  const text = '说明 <tool_call>{"name":"delete_everything","arguments":{}}</tool_call> 结束'
  const result = parseInlineToolCalls(text, known)
  assert.deepEqual(result.calls, [])
  assert.equal(result.cleanedText.includes('delete_everything'), false)
  assert.equal(result.cleanedText.includes('tool_call'), false)
})

test('unclosed protocol tags are removed to the end of the text', () => {
  const result = parseInlineToolCalls('正常内容<tool_call>{"name":"history"', known)
  assert.deepEqual(result.calls, [])
  assert.equal(result.cleanedText, '正常内容')
})

test('a bare JSON object is treated as a call only when it is the whole reply and the name is known', () => {
  const bare = '{"name":"history","arguments":{"session_key":"k"}}'
  const knownResult = parseInlineToolCalls(bare, known)
  assert.deepEqual(knownResult.calls, [{ name: 'history', arguments: { session_key: 'k' } }])
  assert.equal(knownResult.cleanedText, '')

  const unknownBare = '{"name":"whatever","arguments":{}}'
  const unknownResult = parseInlineToolCalls(unknownBare, known)
  assert.deepEqual(unknownResult.calls, [])
  // 用户明确要的 JSON 原样保留，不能被当成协议残片删掉。
  assert.equal(unknownResult.cleanedText, unknownBare)
})

test('JSON embedded in a sentence is left alone even if it looks like a call', () => {
  const text = '示例：{"name":"history","arguments":{}} 这样写'
  const result = parseInlineToolCalls(text, known)
  assert.deepEqual(result.calls, [])
  assert.equal(result.cleanedText, text)
})

test('multiple inline calls are parsed in order', () => {
  const text = '<tool_call>{"name":"history","arguments":{"session_key":"a"}}</tool_call>'
    + '<tool_call>{"name":"send_group_msg","arguments":{"group_id":10}}</tool_call>'
  const result = parseInlineToolCalls(text, known)
  assert.equal(result.calls.length, 2)
  assert.deepEqual(result.calls.map((call) => call.name), ['history', 'send_group_msg'])
})

test('empty or plain text is returned untouched', () => {
  assert.deepEqual(parseInlineToolCalls('', known), { calls: [], cleanedText: '' })
  assert.deepEqual(parseInlineToolCalls('普通回复', known), { calls: [], cleanedText: '普通回复' })
})
