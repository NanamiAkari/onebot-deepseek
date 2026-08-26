const test = require('node:test')
const assert = require('node:assert/strict')
const { createMessageHandler } = require('../src/app/message-handler')

function createHarness(message, options = {}) {
  const calls = { custom: 0, ai: 0, archived: [], modelMessages: [] }
  const prefix = '阿卡林'
  const handler = createMessageHandler({
    pending: new Map(),
    pokeCooldown: new Map(),
    mediaCache: new Map(),
    getKey: () => 'g:1',
    pushHistory: () => {},
    sendAction: async (_ws, action) => {
      if (action === 'get_msg' && options.quotedMessage) return { status: 'ok', data: options.quotedMessage }
      if (action === 'get_forward_msg' && options.forwardedMessages) return { status: 'ok', data: { messages: options.forwardedMessages } }
      return { status: 'ok' }
    },
    extractContent: (segments) => ({
      text: segments.filter((item) => item.type === 'text').map((item) => item.data.text).join('').trim(),
      media: segments.filter((item) => ['image', 'video', 'record', 'audio'].includes(item.type)).map((item) => ({
        kind: item.type === 'record' ? 'audio' : item.type,
        file: item.data && item.data.file || '',
        duration: item.data && item.data.duration || 0
      })),
      replyId: String((segments.find((item) => item.type === 'reply') || { data: {} }).data.id || ''),
      forwardIds: segments.filter((item) => item.type === 'forward').map((item) => String(item.data.id))
    }),
    resolveMediaSources: async (_ws, media) => media,
    checkMention: (segments) => segments.some((item) => item.type === 'at' && String(item.data.qq) === '1000'),
    checkModeration: async () => false,
    handleCommands: async () => false,
    handleScheduleTaskDraftInput: async () => false,
    handleCustomReplyDraftInput: async () => false,
    handleCustomReplyMatch: async () => {
      calls.custom += 1
      return true
    },
    hasCustomReplyTrigger: () => true,
    shouldIgnoreText: () => false,
    GROUP_REQUIRE_MENTION: false,
    shouldRespond: (text) => String(text || '').trim().startsWith(prefix),
    stripPrefix: (text) => {
      const value = String(text || '').trim()
      return value.startsWith(prefix) ? value.slice(prefix.length).trim() : value
    },
    getContext: () => [],
    memberMemory: {
      recordMessage: (payload, text, relations) => calls.archived.push({ payload, text, relations }),
      buildStyleContext: () => ''
    },
    agentRunner: {
      run: async (input) => {
        calls.ai += 1
        calls.modelMessages.push(input.message)
        return { text: 'AI回复' }
      }
    },
    buildReplySegments: (_messageId, text) => [[{ type: 'text', data: { text } }]],
    AI_POKE_ENABLE: false,
    AI_POKE_COOLDOWN: 0,
    AI_POKE_REPLY_TEXT: '',
    AI_POKE_REPLY_TEXTS: [],
    AI_POKE_ONLY_SELF: true,
    AI_REPLY_CHUNK_CHARS: 750,
    AI_IMAGE_CONTEXT_TTL: 0,
    AI_IMAGE_CONTEXT_REQUIRE_HINTS: false,
    AI_IMAGE_HINT_REGEX: /图片/,
    AI_IMAGE_CONTEXT_MODE: 'keyword',
    AI_IMAGE_CONTEXT_REQUIRE_SAME_USER: false,
    AI_IMAGE_CONTEXT_MAX: 1,
    AI_IMAGE_ONLY_NO_CALL: false
  })
  const payload = {
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: 2,
    self_id: 1000,
    message_id: 3,
    message
  }
  return { calls, run: () => handler({}, Buffer.from(JSON.stringify(payload))) }
}

test('AI prefix takes priority when the message contains a custom reply keyword', async () => {
  const harness = createHarness([{ type: 'text', data: { text: '阿卡林 测试关键词是什么意思' } }])
  await harness.run()
  assert.equal(harness.calls.custom, 0)
  assert.equal(harness.calls.ai, 1)
  assert.equal(harness.calls.modelMessages[0], '阿卡林 测试关键词是什么意思')
})

test('keeps the AI trigger name as part of quoted conversation input', async () => {
  const harness = createHarness([
    { type: 'reply', data: { id: '88' } },
    { type: 'text', data: { text: '阿卡林 你觉得呢' } }
  ], {
    quotedMessage: { user_id: 20, message: [{ type: 'text', data: { text: '前面的内容' } }] }
  })
  await harness.run()
  assert.match(harness.calls.modelMessages[0], /当前消息：\n阿卡林 你觉得呢/)
})

test('plain custom reply keyword still uses the custom reply', async () => {
  const harness = createHarness([{ type: 'text', data: { text: '测试关键词' } }])
  await harness.run()
  assert.equal(harness.calls.custom, 1)
  assert.equal(harness.calls.ai, 0)
})

test('mention takes priority over a custom reply keyword', async () => {
  const harness = createHarness([
    { type: 'at', data: { qq: '1000' } },
    { type: 'text', data: { text: '测试关键词是什么意思' } }
  ])
  await harness.run()
  assert.equal(harness.calls.custom, 0)
  assert.equal(harness.calls.ai, 1)
})

test('archives mentions and quoted author as structured memory evidence', async () => {
  const harness = createHarness([
    { type: 'reply', data: { id: '88' } },
    { type: 'at', data: { qq: '20' } },
    { type: 'text', data: { text: '牢明说得对' } }
  ], {
    quotedMessage: {
      user_id: 20,
      sender: { user_id: 20 },
      message: [{ type: 'text', data: { text: '之前的话' } }]
    }
  })
  await harness.run()
  assert.deepEqual(harness.calls.archived[0].relations.mentionedUserIds, ['20'])
  assert.equal(harness.calls.archived[0].relations.replyToUserId, '20')
})

test('archives multimedia metadata and expanded forwarded text', async () => {
  const harness = createHarness([
    { type: 'video', data: { file: 'clip.mp4', duration: 8 } },
    { type: 'forward', data: { id: 'forward-1' } }
  ], {
    forwardedMessages: [{
      user_id: 20,
      nickname: '小明',
      content: [
        { type: 'text', data: { text: '转发内容' } },
        { type: 'image', data: { file: 'inside.jpg' } }
      ]
    }]
  })
  await harness.run()
  const archived = harness.calls.archived[0].relations
  assert.equal(archived.media[0].kind, 'video')
  assert.equal(archived.forwarded[0].text, '转发内容')
  assert.deepEqual(archived.forwarded[0].mediaTypes, ['image'])
})
