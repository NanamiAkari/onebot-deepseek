const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createMemberMemory, localDate } = require('../src/memory/member-memory')
const { createDefaultToolRegistry } = require('../src/agent/tools')
const { createToolExecutor } = require('../src/agent/tool-executor')

function temporaryMemory(options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-memory-'))
  const memory = createMemberMemory({ enabled: true, rootDir, ...options })
  return { rootDir, memory, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) }
}

test('records group text on disk without retaining a message collection', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  const timestamp = Date.now()
  assert.equal(fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99,
    message_id: 30, time: Math.floor(timestamp / 1000), sender: { card: '小明' }
  }, '今天在玩音游'), true)
  const members = await fixture.memory.collectDay(localDate(timestamp))
  assert.equal(members.get('10:20').messages[0], '今天在玩音游')
  assert.equal(fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99,
    message_id: 30, time: Math.floor(timestamp / 1000), sender: { card: '小明' }
  }, '重复事件'), false)
  const afterDuplicate = await fixture.memory.collectDay(localDate(timestamp))
  assert.equal(afterDuplicate.get('10:20').total, 1)
  assert.equal(fixture.memory.findMembersByAlias(10, '小明')[0].userId, '20')
})

test('archives media-only and forwarded messages as bounded observations', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  const timestamp = Date.now()
  const date = localDate(timestamp)
  assert.equal(fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99,
    message_id: 31, time: Math.floor(timestamp / 1000), sender: { card: '小明' }
  }, '', {
    media: [{ kind: 'image', file: 'image.jpg' }, { kind: 'video', file: 'video.mp4', duration: 12 }],
    forwarded: [{ userId: '21', nickname: '小红', text: '转发里的文字', mediaTypes: ['image'] }]
  }), true)
  const members = await fixture.memory.collectDay(date)
  const observation = members.get('10:20').messages[0]
  assert.match(observation, /图片（未解析画面）/)
  assert.match(observation, /视频（未解析内容），12秒/)
  assert.match(observation, /小红: 转发里的文字/)
})

test('maps current and historical nicknames to the same QQ member within a group', (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  const base = {
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99,
    time: Math.floor(Date.now() / 1000)
  }
  fixture.memory.recordMessage({ ...base, message_id: 1, sender: { card: '旧群名片', nickname: 'QQ昵称' } }, '第一条')
  fixture.memory.recordMessage({ ...base, message_id: 2, sender: { card: '新群名片', nickname: 'QQ昵称', title: '音游高手' } }, '第二条')
  assert.equal(fixture.memory.findMembersByAlias(10, '旧群名片')[0].userId, '20')
  assert.equal(fixture.memory.findMembersByAlias(10, '新群名片')[0].userId, '20')
  assert.equal(fixture.memory.findMembersByAlias(10, 'QQ昵称')[0].userId, '20')
  assert.equal(fixture.memory.findMembersByAlias(10, '音游高手')[0].userId, '20')
  assert.deepEqual(fixture.memory.findMembersByAlias(11, '新群名片'), [])
})

test('group summary infers conversational aliases from structured interaction evidence', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  const timestamp = Date.now()
  const date = localDate(timestamp)
  fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99, message_id: 100,
    time: Math.floor(timestamp / 1000), sender: { card: '正式群名片', title: '管理员' }
  }, '大家叫我牢明就好')
  fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 21, self_id: 99, message_id: 101,
    time: Math.floor(timestamp / 1000), sender: { card: '小红' }
  }, '牢明你说得对，顺便问一下潜水员', { mentionedUserIds: ['20', '22'], replyToUserId: '20' })
  let receivedPrompt = ''
  const result = await fixture.memory.summarizeGroupsDay(date, async (prompt) => {
    receivedPrompt = prompt
    return JSON.stringify({
      inferredAliases: [
        { alias: '牢明', targetUserId: '20', confidence: 0.92, evidenceMessageIds: ['100', '101'] },
        { alias: '潜水员', targetUserId: '22', confidence: 0.8, evidenceMessageIds: ['101'] }
      ],
      relations: [{ fromUserId: '21', toUserId: '20', description: '经常友好接话', confidence: 0.8 }],
      groupMemories: ['大家用牢明称呼成员20']
    })
  })
  assert.equal(result.processed, 1)
  assert.match(receivedPrompt, /replyToUserId/)
  assert.match(receivedPrompt, /管理员/)
  const alias = fixture.memory.findMembersByAlias(10, '牢明')[0]
  assert.equal(alias.userId, '20')
  assert.equal(alias.source, 'inferred')
  assert.equal(fixture.memory.findMembersByAlias(10, '潜水员')[0].userId, '22')
  const groupMaterial = fixture.memory.getGroupMemoryMaterial({ message_type: 'group', group_id: 10, user_id: 20 })
  assert.equal(groupMaterial.available, true)
  assert.match(groupMaterial.material, /友好接话/)
})

test('group summary rejects aliases that target unknown QQ members', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  const timestamp = Date.now()
  const date = localDate(timestamp)
  fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99,
    message_id: 1, time: Math.floor(timestamp / 1000), sender: { card: '成员20' }
  }, '普通消息')
  await fixture.memory.summarizeGroupsDay(date, async () => JSON.stringify({
    inferredAliases: [{ alias: '不存在的人', targetUserId: '999', confidence: 1 }],
    relations: [], groupMemories: []
  }))
  assert.deepEqual(fixture.memory.findMembersByAlias(10, '不存在的人'), [])
})

test('one failed member does not block others and successful members are not summarized twice', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  const timestamp = Date.now()
  const date = localDate(timestamp)
  for (const userId of [20, 21]) {
    fixture.memory.recordMessage({
      message_type: 'group', group_id: 10, user_id: userId, self_id: 99,
      message_id: userId, time: Math.floor(timestamp / 1000), sender: { nickname: `成员${userId}` }
    }, `我是成员${userId}`)
  }
  const calls = new Map()
  const summarize = async (_prompt, member) => {
    calls.set(member.userId, (calls.get(member.userId) || 0) + 1)
    if (member.userId === '20' && calls.get(member.userId) === 1) throw new Error('临时失败')
    return JSON.stringify({ summary: `画像${member.userId}`, interests: [], communicationStyle: [], stableFacts: [], uncertainInferences: [] })
  }
  const first = await fixture.memory.summarizeDay(date, summarize)
  assert.equal(first.processed, 1)
  assert.equal(first.failed, 1)
  const second = await fixture.memory.summarizeDay(date, summarize)
  assert.equal(second.processed, 1)
  assert.equal(second.failed, 0)
  assert.equal(calls.get('20'), 2)
  assert.equal(calls.get('21'), 1)
})

test('profile cache is bounded and can expire', (t) => {
  const fixture = temporaryMemory({ cacheMax: 10, cacheTtlSeconds: 60 })
  t.after(fixture.cleanup)
  for (let userId = 1; userId <= 15; userId += 1) {
    fixture.memory.saveProfile({ groupId: '1', userId: String(userId), summary: `成员${userId}` })
  }
  assert.equal(fixture.memory.cacheSize(), 10)
  fixture.memory.cleanupCache(Date.now() + 61000)
  assert.equal(fixture.memory.cacheSize(), 0)
})

test('daily summary writes a reusable profile and completion marker', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  const timestamp = Date.now()
  const date = localDate(timestamp)
  fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99,
    message_id: 30, time: Math.floor(timestamp / 1000), sender: { nickname: '小明' }
  }, '我很喜欢音游')
  const first = await fixture.memory.summarizeDay(date, async () => JSON.stringify({
    dailySummary: '今天聊了音游新曲', summary: '喜欢讨论音游', interests: ['音游'], communicationStyle: ['轻松'], stableFacts: [], uncertainInferences: [], recentEvents: ['最近在练习新曲']
  }))
  assert.equal(first.processed, 1)
  const payload = { message_type: 'group', group_id: 10, user_id: 20 }
  assert.match(fixture.memory.buildStyleContext(payload), /轻松/)
  assert.doesNotMatch(fixture.memory.buildStyleContext(payload), /音游/)
  assert.match(fixture.memory.getReplyMaterial(payload).material, /音游/)
  assert.match(fixture.memory.getReplyMaterial(payload).material, /练习新曲/)
  const profile = fixture.memory.getProfile(10, 20)
  assert.equal(profile.version, 1)
  assert.equal(profile.dailyHistory[0].summary, '今天聊了音游新曲')
  const second = await fixture.memory.summarizeDay(date, async () => { throw new Error('不应重复执行') })
  assert.equal(second.skipped, true)
})

test('daily iteration retains old profile fields when the model omits them', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  fixture.memory.saveProfile({
    groupId: '10', userId: '20', summary: '旧的累计概括', interests: ['音游'],
    communicationStyle: ['轻松'], stableFacts: ['喜欢短回复'], version: 3
  })
  const timestamp = Date.now()
  const date = localDate(timestamp)
  fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99,
    message_id: 300, time: Math.floor(timestamp / 1000), sender: { card: '小明' }
  }, '今天有点忙')
  await fixture.memory.summarizeDay(date, async () => JSON.stringify({
    dailySummary: '今天提到比较忙', summary: '最近比较忙，但仍喜欢音游'
  }))
  const profile = fixture.memory.getProfile(10, 20)
  assert.deepEqual(profile.interests, ['音游'])
  assert.deepEqual(profile.communicationStyle, ['轻松'])
  assert.deepEqual(profile.stableFacts, ['喜欢短回复'])
  assert.equal(profile.version, 4)
  assert.equal(profile.dailyHistory.length, 1)
})

test('summarizes only speakers while including interactions directed at them', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  const timestamp = Date.now()
  const date = localDate(timestamp)
  fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99,
    message_id: 400, time: Math.floor(timestamp / 1000), sender: { card: '成员20' }
  }, '我今天上线了')
  fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 21, self_id: 99,
    message_id: 401, time: Math.floor(timestamp / 1000), sender: { card: '成员21' }
  }, '成员20说得对，顺便@潜水成员', { mentionedUserIds: ['20', '22'], replyToUserId: '20' })
  const prompts = new Map()
  await fixture.memory.summarizeDay(date, async (prompt, member) => {
    prompts.set(member.userId, prompt)
    return JSON.stringify({ dailySummary: '当天观察', summary: `成员${member.userId}`, interests: [], communicationStyle: [], stableFacts: [], uncertainInferences: [], recentEvents: [] })
  })
  assert.deepEqual(Array.from(prompts.keys()).sort(), ['20', '21'])
  assert.match(prompts.get('20'), /成员20说得对/)
  assert.match(prompts.get('20'), /"fromUserId":"21"/)
  assert.equal(prompts.has('22'), false)
})

test('member memory is optional and missing material remains an internal tool result', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  const registry = createDefaultToolRegistry({ memberMemory: true })
  assert.ok(registry.get('member_memory'))
  assert.ok(registry.get('resolve_group_member'))
  assert.ok(registry.get('group_memory'))
  assert.equal(createDefaultToolRegistry().get('member_memory'), undefined)
  const executor = createToolExecutor({
    sendAction: async () => null,
    getHistoryRaw: () => [],
    workspaceRoot: fixture.rootDir,
    memberMemory: fixture.memory
  })
  const result = await executor.execute('member_memory', {}, {
    payload: { message_type: 'group', group_id: 10, user_id: 999 }
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.available, false)
  assert.equal(result.data.instruction, '忽略本工具结果，仅依据当前消息正常回答。')
})

test('member alias tool resolves only members from the current group', async (t) => {
  const fixture = temporaryMemory()
  t.after(fixture.cleanup)
  fixture.memory.recordMessage({
    message_type: 'group', group_id: 10, user_id: 20, self_id: 99,
    message_id: 1, sender: { card: '灯里' }
  }, '大家好')
  const executor = createToolExecutor({
    sendAction: async () => null,
    getHistoryRaw: () => [],
    workspaceRoot: fixture.rootDir,
    memberMemory: fixture.memory
  })
  const found = await executor.execute('resolve_group_member', { alias: '灯里' }, {
    payload: { message_type: 'group', group_id: 10, user_id: 30 }
  })
  assert.equal(found.data.matches[0].userId, '20')
  const otherGroup = await executor.execute('resolve_group_member', { alias: '灯里' }, {
    payload: { message_type: 'group', group_id: 11, user_id: 30 }
  })
  assert.deepEqual(otherGroup.data.matches, [])
})
