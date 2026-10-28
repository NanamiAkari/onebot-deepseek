const test = require('node:test')
const assert = require('node:assert/strict')
const { createMessageHandler } = require('../src/app/message-handler')
const { createSendRegistry } = require('../src/app/send-registry')

function createHarness(message, options = {}) {
  const calls = { custom: 0, ai: 0, archived: [], modelMessages: [], media: [], replyBuildOptions: [], actions: [], history: [] }
  const prefix = '阿卡林'
  const mediaCache = options.mediaCache || new Map()
  const handler = createMessageHandler({
    pending: new Map(),
    pokeCooldown: new Map(),
    mediaCache,
    sendRegistry: options.sendRegistry,
    getKey: () => 'g:1',
    pushHistory: (_payload, userText, botText) => calls.history.push({ userText, botText }),
    sendAction: async (_ws, action, params) => {
      calls.actions.push({ action, params })
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
    classifyAddressing: options.classifyAddressing,
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
    REQUIRE_PREFIX: true,
    PREFIXES: [prefix],
    AI_NAME_INTENT_ENABLE: true,
    AI_NAME_INTENT_THRESHOLD: 0.65,
    shouldRespond: (text) => String(text || '').trim().startsWith(prefix),
    stripPrefix: (text) => {
      const value = String(text || '').trim()
      return value.startsWith(prefix) ? value.slice(prefix.length).trim() : value
    },
    getContext: () => [],
    getHistoryRaw: () => options.recentConversation || [],
    getRecentGroupContext: () => options.recentGroupMessages || [],
    memberMemory: {
      recordMessage: (payload, text, relations) => calls.archived.push({ payload, text, relations }),
      buildStyleContext: () => '',
      buildIdentityContext: (_payload, text) => text.includes('灯灯') ? '确定身份：“灯灯”就是当前群成员（内部QQ标识：20）。' : ''
    },
    agentRunner: {
      run: async (input) => {
        calls.ai += 1
        calls.modelMessages.push(input.message)
        calls.media.push(Array.isArray(input.media) ? input.media.slice() : [])
        return { text: 'AI回复' }
      }
    },
    buildReplySegments: (_messageId, text, buildOptions = {}) => {
      calls.replyBuildOptions.push(buildOptions)
      return [[{ type: 'text', data: { text } }]]
    },
    AI_POKE_ENABLE: false,
    AI_POKE_COOLDOWN: 0,
    AI_POKE_REPLY_TEXT: '',
    AI_POKE_REPLY_TEXTS: [],
    AI_POKE_ONLY_SELF: true,
    AI_REPLY_CHUNK_CHARS: 750,
    AI_IMAGE_CONTEXT_TTL: options.imageContextTtl ?? 0,
    AI_IMAGE_CONTEXT_REQUIRE_HINTS: options.requireHints ?? false,
    AI_IMAGE_HINT_REGEX: options.imageHintRegex || /图片/,
    AI_IMAGE_CONTEXT_MODE: options.imageContextMode || 'keyword',
    AI_IMAGE_CONTEXT_REQUIRE_SAME_USER: options.requireSameUser ?? false,
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
  assert.match(harness.calls.modelMessages[0], /用户原话：阿卡林 测试关键词是什么意思/)
  assert.match(harness.calls.modelMessages[0], /实际话题：测试关键词是什么意思/)
})

test('keeps the AI trigger name as part of quoted conversation input', async () => {
  const harness = createHarness([
    { type: 'reply', data: { id: '88' } },
    { type: 'text', data: { text: '阿卡林 你觉得呢' } }
  ], {
    quotedMessage: { user_id: 20, message: [{ type: 'text', data: { text: '前面的内容' } }] }
  })
  await harness.run()
  assert.match(harness.calls.modelMessages[0], /【当前消息】\n用户原话：阿卡林 你觉得呢/)
  assert.match(harness.calls.modelMessages[0], /实际话题：你觉得呢/)
})

test('separates the AI trigger name from a following member nickname', async () => {
  const harness = createHarness([{ type: 'text', data: { text: '阿卡林灯灯今天怎么了' } }])
  await harness.run()
  assert.match(harness.calls.modelMessages[0], /用户原话：阿卡林灯灯今天怎么了/)
  assert.match(harness.calls.modelMessages[0], /句首“阿卡林”是用户对你的称呼/)
  assert.match(harness.calls.modelMessages[0], /实际话题：灯灯今天怎么了/)
})

test('injects deterministic member identity into the model message', async () => {
  const harness = createHarness([{ type: 'text', data: { text: '阿卡林灯灯今天怎么了' } }])
  await harness.run()
  assert.match(harness.calls.modelMessages[0], /确定身份：“灯灯”就是当前群成员/)
  assert.match(harness.calls.modelMessages[0], /实际话题：灯灯今天怎么了/)
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

test('uses model intent for an in-message bot name mention', async () => {
  let classifications = 0
  const harness = createHarness([{ type: 'text', data: { text: '有人知道阿卡林在吗' } }], {
    classifyAddressing: async () => {
      classifications += 1
      return { addressed: true, confidence: 0.96 }
    }
  })
  await harness.run()
  assert.equal(classifications, 1)
  assert.equal(harness.calls.ai, 1)
  assert.match(harness.calls.modelMessages[0], /有人知道阿卡林在吗/)
})

test('does not run a second intent request for an explicit prefix at the start', async () => {
  let classifications = 0
  const harness = createHarness([{ type: 'text', data: { text: '阿卡林 你好' } }], {
    classifyAddressing: async () => {
      classifications += 1
      return { addressed: true, confidence: 1 }
    }
  })
  await harness.run()
  assert.equal(classifications, 0)
  assert.equal(harness.calls.ai, 1)
})

test('passes recent group and bot conversation context to the name classifier', async () => {
  let capturedContext = null
  const harness = createHarness([{ type: 'text', data: { text: '这个功能你会吗，阿卡林' } }], {
    recentGroupMessages: [{ role: 'user', content: '小明：刚才那个队列问题还没解决' }],
    recentConversation: [
      { role: 'user', content: '阿卡林帮我看看队列' },
      { role: 'assistant', content: '可以，先检查超时配置。' }
    ],
    classifyAddressing: async (_text, _payload, context) => {
      capturedContext = context
      return { addressed: true, confidence: 0.93 }
    }
  })
  await harness.run()
  assert.deepEqual(capturedContext.recentGroupMessages, ['小明：刚才那个队列问题还没解决'])
  assert.deepEqual(capturedContext.recentConversation, [
    '用户：阿卡林帮我看看队列',
    '机器人：可以，先检查超时配置。'
  ])
  assert.equal(harness.calls.ai, 1)
})

test('does not quote the triggering message for a normal AI reply', async () => {
  const harness = createHarness([{ type: 'text', data: { text: '阿卡林你好' } }])
  await harness.run()
  assert.equal(harness.calls.ai, 1)
  assert.equal(harness.calls.replyBuildOptions[0].includeReply, false)
})

test('quotes the original message only when the user explicitly replied to it', async () => {
  const harness = createHarness([
    { type: 'reply', data: { id: '88' } },
    { type: 'text', data: { text: '阿卡林你怎么看' } }
  ], {
    quotedMessage: { user_id: 20, message: [{ type: 'text', data: { text: '前面的内容' } }] }
  })
  await harness.run()
  assert.equal(harness.calls.ai, 1)
  assert.equal(harness.calls.replyBuildOptions[0].includeReply, true)
})

test('a quoted image without text still tells the model something was quoted', async () => {
  const harness = createHarness([
    { type: 'reply', data: { id: '88' } },
    { type: 'text', data: { text: '阿卡林你看看这个' } }
  ], {
    quotedMessage: {
      user_id: 20,
      message: [{ type: 'image', data: { file: 'a.image', url: 'https://gchat.qpic.cn/a.gif' } }]
    }
  })
  await harness.run()
  assert.equal(harness.calls.ai, 1)
  assert.match(harness.calls.modelMessages[0], /【引用消息】\n\[图片\]/)
})

test('a recent image is attached when the follow-up mentions it', async () => {
  const mediaCache = new Map()
  const sticker = createHarness([{ type: 'image', data: { file: 'a.image', url: 'https://gchat.qpic.cn/a.gif' } }], { mediaCache })
  await sticker.run()
  // 纯图片没被 @，不触发回复，但要进缓存。
  assert.equal(sticker.calls.ai, 0)
  assert.equal(mediaCache.size, 1)

  const followUp = createHarness([{ type: 'text', data: { text: '阿卡林你看看这个表情包' } }], {
    mediaCache,
    imageContextTtl: 60,
    requireHints: true,
    imageHintRegex: /表情包/
  })
  await followUp.run()
  assert.equal(followUp.calls.ai, 1)
  assert.equal(followUp.calls.media[0].length, 1)
})

test('an unrelated follow-up does not attach a stale image', async () => {
  const mediaCache = new Map()
  await createHarness([{ type: 'image', data: { file: 'a.image', url: 'https://gchat.qpic.cn/a.gif' } }], { mediaCache }).run()
  const followUp = createHarness([{ type: 'text', data: { text: '阿卡林今天天气怎么样' } }], {
    mediaCache,
    imageContextTtl: 60,
    requireHints: true,
    imageHintRegex: /表情包/
  })
  await followUp.run()
  assert.equal(followUp.calls.ai, 1)
  assert.equal(followUp.calls.media[0].length, 0)
})

test('does not reply when the model classifies the name as a character discussion', async () => {
  const harness = createHarness([{ type: 'text', data: { text: '我喜欢阿卡林这个角色' } }], {
    classifyAddressing: async () => ({ addressed: false, confidence: 0.98 })
  })
  await harness.run()
  assert.equal(harness.calls.ai, 0)
  assert.equal(harness.calls.custom, 1)
})

test('fails closed when the ambiguous name intent classifier errors', async () => {
  const harness = createHarness([{ type: 'text', data: { text: '你在吗，阿卡林' } }], {
    classifyAddressing: async () => { throw new Error('classifier unavailable') }
  })
  await harness.run()
  assert.equal(harness.calls.ai, 0)
})

test('does not call the name intent classifier for messages without the name', async () => {
  let classifications = 0
  const harness = createHarness([{ type: 'text', data: { text: '普通群聊内容' } }], {
    classifyAddressing: async () => {
      classifications += 1
      return { addressed: true, confidence: 1 }
    }
  })
  await harness.run()
  assert.equal(classifications, 0)
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

test('does not process the same inbound message twice', async () => {
  const harness = createHarness([{ type: 'text', data: { text: '阿卡林重复测试' } }])
  await harness.run()
  await harness.run()
  assert.equal(harness.calls.ai, 1)
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

test('does not resend a reply that a tool already sent in the same conversation', async () => {
  const sendRegistry = createSendRegistry({ ttlMs: 9000 })
  sendRegistry.markSent(sendRegistry.fingerprint('group:1', 'AI回复'))
  const harness = createHarness([{ type: 'text', data: { text: '阿卡林你好' } }], { sendRegistry })
  await harness.run()
  assert.equal(harness.calls.ai, 1)
  assert.equal(harness.calls.actions.filter((item) => item.action === 'send_group_msg').length, 0)
  // 即使跳过真实发送，历史仍记录已经交付的文本。
  assert.equal(harness.calls.history[0].botText, 'AI回复')
})

test('remembers a delivered reply and skips the identical text inside the window', async () => {
  const sendRegistry = createSendRegistry({ ttlMs: 9000 })
  const first = createHarness([{ type: 'text', data: { text: '阿卡林你好' } }], { sendRegistry })
  await first.run()
  assert.equal(first.calls.actions.filter((item) => item.action === 'send_group_msg').length, 1)
  assert.equal(sendRegistry.stats().entries, 1)

  const second = createHarness([{ type: 'text', data: { text: '阿卡林再问一次' } }], { sendRegistry })
  await second.run()
  assert.equal(second.calls.actions.filter((item) => item.action === 'send_group_msg').length, 0)
})
