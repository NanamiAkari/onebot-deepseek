const fs = require('fs')
const path = require('path')
const readline = require('readline')

function safeId(value) {
  return String(value || '').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 80)
}

function localDate(timestamp = Date.now()) {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function previousLocalDate() {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  return localDate(date.getTime())
}

function confidenceWithDecay(confidence, lastConfirmedDate, dailyRetention = 0.985) {
  const base = Math.max(0, Math.min(1, Number(confidence || 0)))
  const timestamp = new Date(`${String(lastConfirmedDate || '')}T00:00:00`).getTime()
  if (!Number.isFinite(timestamp)) return base
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86400000)
  return base * Math.pow(dailyRetention, ageDays)
}

function parseJsonObject(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    const start = value.indexOf('{')
    const end = value.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      const parsed = JSON.parse(value.slice(start, end + 1))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
}

function normalizeStringList(value, maxItems = 8) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim().slice(0, 120)).filter(Boolean).slice(0, maxItems)
}

function normalizeProfile(value, fallback = {}) {
  const profile = value && typeof value === 'object' ? value : {}
  return {
    groupId: String(profile.groupId || fallback.groupId || ''),
    userId: String(profile.userId || fallback.userId || ''),
    nickname: String(profile.nickname || fallback.nickname || '').slice(0, 80),
    summary: String(profile.summary || '').trim().slice(0, 500),
    interests: normalizeStringList(profile.interests),
    communicationStyle: normalizeStringList(profile.communicationStyle, 5),
    stableFacts: normalizeStringList(profile.stableFacts),
    uncertainInferences: normalizeStringList(profile.uncertainInferences, 5),
    recentEvents: normalizeRecentEvents(profile.recentEvents),
    dailyHistory: normalizeDailyHistory(profile.dailyHistory),
    version: Math.max(0, Number(profile.version || fallback.version || 0)),
    messageCount: Math.max(0, Number(profile.messageCount || fallback.messageCount || 0)),
    lastSummaryDate: String(profile.lastSummaryDate || fallback.lastSummaryDate || ''),
    updatedAt: Number(profile.updatedAt || Date.now())
  }
}

function normalizeDailyHistory(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => ({
    date: String(item && item.date || '').slice(0, 10),
    summary: String(item && item.summary || '').trim().slice(0, 500),
    messageCount: Math.max(0, Number(item && item.messageCount || 0)),
    interactionCount: Math.max(0, Number(item && item.interactionCount || 0))
  })).filter((item) => item.date && item.summary).slice(-30)
}

function normalizeRecentEvents(value) {
  if (!Array.isArray(value)) return []
  const now = Date.now()
  return value.map((item) => ({
    content: String(typeof item === 'string' ? item : item && item.content || '').trim().slice(0, 160),
    occurredAt: String(item && item.occurredAt || '').slice(0, 10),
    expiresAt: Number(item && item.expiresAt || now + 30 * 86400000)
  })).filter((item) => item.content && item.expiresAt > now).slice(0, 10)
}

function normalizeGroupMemory(value, groupId, date, allowedUserIds = null) {
  const data = value && typeof value === 'object' ? value : {}
  const inferredAliases = (Array.isArray(data.inferredAliases) ? data.inferredAliases : []).map((item) => ({
    alias: String(item && item.alias || '').trim().slice(0, 80),
    targetUserId: String(item && item.targetUserId || ''),
    confidence: Math.max(0, Math.min(1, Number(item && item.confidence || 0))),
    evidenceMessageIds: normalizeStringList(item && item.evidenceMessageIds, 8),
    lastConfirmedDate: date
  })).filter((item) => item.alias && item.targetUserId && (!allowedUserIds || allowedUserIds.has(item.targetUserId))).slice(0, 100)
  const relations = (Array.isArray(data.relations) ? data.relations : []).map((item) => ({
    fromUserId: String(item && item.fromUserId || ''),
    toUserId: String(item && item.toUserId || ''),
    description: String(item && item.description || '').trim().slice(0, 160),
    confidence: Math.max(0, Math.min(1, Number(item && item.confidence || 0)))
  })).filter((item) => item.fromUserId && item.toUserId && item.description
    && (!allowedUserIds || (allowedUserIds.has(item.fromUserId) && allowedUserIds.has(item.toUserId)))).slice(0, 60)
  return {
    groupId: String(groupId || data.groupId || ''),
    inferredAliases,
    relations,
    groupMemories: normalizeStringList(data.groupMemories, 20),
    lastSummaryDate: date,
    updatedAt: Date.now()
  }
}

function describeJournalEntry(entry) {
  const parts = []
  const text = String(entry && entry.text || '').trim()
  if (text) parts.push(text)
  const mediaLabels = { image: '图片（未解析画面）', video: '视频（未解析内容）', audio: '语音（未转写）' }
  for (const media of Array.isArray(entry && entry.media) ? entry.media : []) {
    const label = mediaLabels[media.kind] || `媒体:${media.kind}`
    parts.push(`[${label}${media.duration ? `，${media.duration}秒` : ''}]`)
  }
  const forwarded = Array.isArray(entry && entry.forwarded) ? entry.forwarded : []
  if (forwarded.length) {
    const lines = forwarded.map((item) => {
      const author = item.nickname || item.userId || '未知成员'
      const media = (item.mediaTypes || []).length ? ` [媒体:${item.mediaTypes.join(',')}]` : ''
      return `${author}: ${item.text || ''}${media}`.trim()
    })
    parts.push(`[合并转发]\n${lines.join('\n')}`)
  }
  return parts.join('\n').trim()
}

function createMemberMemory(options = {}) {
  const enabled = Boolean(options.enabled)
  const rootDir = path.resolve(options.rootDir || 'memory_data')
  const journalDir = path.join(rootDir, 'journal')
  const profileDir = path.join(rootDir, 'profiles')
  const memberDir = path.join(rootDir, 'members')
  const groupDir = path.join(rootDir, 'groups')
  const interactionDir = path.join(rootDir, 'interactions')
  const cacheTtlMs = Math.max(60, Number(options.cacheTtlSeconds || 1800)) * 1000
  const cacheMax = Math.max(10, Number(options.cacheMax || 500))
  const maxMessageChars = Math.max(20, Number(options.maxMessageChars || 1000))
  const dailyMaxMessages = Math.max(10, Number(options.dailyMaxMessages || 300))
  const dailyMaxChars = Math.max(1000, Number(options.dailyMaxChars || 30000))
  const groupDailyMaxMessages = Math.max(20, Number(options.groupDailyMaxMessages || 500))
  const groupDailyMaxChars = Math.max(2000, Number(options.groupDailyMaxChars || 50000))
  const retentionDays = Math.max(1, Number(options.retentionDays || 14))
  const contextMaxChars = Math.max(200, Number(options.contextMaxChars || 1200))
  const dedupeTtlMs = Math.max(60, Number(options.dedupeTtlSeconds || 3600)) * 1000
  const dedupeMax = Math.max(100, Number(options.dedupeMax || 5000))
  const profileCache = new Map()
  const recentMessageIds = new Map()
  const memberCache = new Map()
  let dailyJobRunning = false

  if (enabled) {
    fs.mkdirSync(journalDir, { recursive: true })
    fs.mkdirSync(profileDir, { recursive: true })
    fs.mkdirSync(memberDir, { recursive: true })
    fs.mkdirSync(groupDir, { recursive: true })
    fs.mkdirSync(interactionDir, { recursive: true })
  }

  function profilePath(groupId, userId) {
    return path.join(profileDir, safeId(groupId), `${safeId(userId)}.json`)
  }

  function memberPath(groupId, userId) {
    return path.join(memberDir, safeId(groupId), `${safeId(userId)}.json`)
  }

  function groupMemoryPath(groupId) {
    return path.join(groupDir, `${safeId(groupId)}.json`)
  }

  function cacheKey(groupId, userId) {
    return `${groupId}:${userId}`
  }

  function setCached(groupId, userId, profile) {
    const key = cacheKey(groupId, userId)
    profileCache.delete(key)
    profileCache.set(key, { profile, expiresAt: Date.now() + cacheTtlMs })
    while (profileCache.size > cacheMax) profileCache.delete(profileCache.keys().next().value)
  }

  function cleanupCache(now = Date.now()) {
    for (const [key, item] of profileCache.entries()) {
      if (!item || item.expiresAt <= now) profileCache.delete(key)
    }
    for (const [key, expiresAt] of recentMessageIds.entries()) {
      if (expiresAt <= now) recentMessageIds.delete(key)
    }
    for (const [key, item] of memberCache.entries()) {
      if (!item || item.expiresAt <= now) memberCache.delete(key)
    }
  }

  function readMember(groupId, userId) {
    const key = cacheKey(groupId, userId)
    const cached = memberCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    try {
      const value = JSON.parse(fs.readFileSync(memberPath(groupId, userId), 'utf8'))
      memberCache.set(key, { value, expiresAt: Date.now() + cacheTtlMs })
      while (memberCache.size > cacheMax) memberCache.delete(memberCache.keys().next().value)
      return value
    } catch {
      return null
    }
  }

  function recordMember(payload, timestamp) {
    const groupId = String(payload.group_id || '')
    const userId = String(payload.user_id || '')
    if (!groupId || !userId) return
    const sender = payload.sender && typeof payload.sender === 'object' ? payload.sender : {}
    const names = [sender.card, sender.nickname].map((value) => String(value || '').trim().slice(0, 80)).filter(Boolean)
    const title = String(sender.title || '').trim().slice(0, 80)
    const previous = readMember(groupId, userId) || {}
    const aliases = Array.from(new Set([...(Array.isArray(previous.aliases) ? previous.aliases : []), ...names])).slice(-12)
    const currentName = String(sender.card || sender.nickname || previous.currentName || '').trim().slice(0, 80)
    const now = Number(timestamp || Date.now())
    const titles = Array.from(new Set([...(Array.isArray(previous.titles) ? previous.titles : []), ...(title ? [title] : [])])).slice(-8)
    const identityChanged = currentName !== String(previous.currentName || '') || names.some((name) => !(previous.aliases || []).includes(name)) || title !== String(previous.currentTitle || '')
    if (!identityChanged && now - Number(previous.persistedAt || 0) < 3600000) return
    const value = {
      groupId,
      userId,
      currentName,
      aliases,
      currentTitle: title || String(previous.currentTitle || ''),
      titles,
      firstSeenAt: Number(previous.firstSeenAt || now),
      lastSeenAt: now,
      persistedAt: now
    }
    const filePath = memberPath(groupId, userId)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tempPath, filePath)
    const key = cacheKey(groupId, userId)
    memberCache.set(key, { value, expiresAt: Date.now() + cacheTtlMs })
    while (memberCache.size > cacheMax) memberCache.delete(memberCache.keys().next().value)
  }

  function getProfile(groupId, userId) {
    if (!enabled || !groupId || !userId) return null
    const key = cacheKey(groupId, userId)
    const cached = profileCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      profileCache.delete(key)
      profileCache.set(key, cached)
      return cached.profile
    }
    if (cached) profileCache.delete(key)
    try {
      const profile = normalizeProfile(JSON.parse(fs.readFileSync(profilePath(groupId, userId), 'utf8')), { groupId, userId })
      setCached(groupId, userId, profile)
      return profile
    } catch {
      return null
    }
  }

  function saveProfile(profile) {
    const normalized = normalizeProfile(profile)
    if (!normalized.groupId || !normalized.userId) return false
    const filePath = profilePath(normalized.groupId, normalized.userId)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    fs.renameSync(tempPath, filePath)
    setCached(normalized.groupId, normalized.userId, normalized)
    return true
  }

  function mergeProfile(previousValue, updateValue, fallback, date, interactionCount) {
    const previous = normalizeProfile(previousValue || {}, fallback)
    const update = updateValue && typeof updateValue === 'object' ? updateValue : {}
    const has = (key) => Object.prototype.hasOwnProperty.call(update, key)
    const next = normalizeProfile({
      ...previous,
      nickname: fallback.nickname || previous.nickname,
      summary: String(update.summary || '').trim() || previous.summary,
      interests: has('interests') ? update.interests : previous.interests,
      communicationStyle: has('communicationStyle') ? update.communicationStyle : previous.communicationStyle,
      stableFacts: has('stableFacts') ? update.stableFacts : previous.stableFacts,
      uncertainInferences: has('uncertainInferences') ? update.uncertainInferences : previous.uncertainInferences,
      recentEvents: [...previous.recentEvents, ...(Array.isArray(update.recentEvents) ? update.recentEvents : [])],
      messageCount: fallback.messageCount,
      lastSummaryDate: date,
      version: previous.version + 1,
      updatedAt: Date.now()
    }, fallback)
    const eventByContent = new Map()
    for (const event of next.recentEvents) eventByContent.set(event.content, event)
    next.recentEvents = Array.from(eventByContent.values()).slice(-10)
    const dailySummary = String(update.dailySummary || '').trim().slice(0, 500)
    next.dailyHistory = previous.dailyHistory.filter((item) => item.date !== date)
    if (dailySummary) {
      next.dailyHistory.push({
        date,
        summary: dailySummary,
        messageCount: Math.max(0, Number(fallback.dailyMessageCount || 0)),
        interactionCount: Math.max(0, Number(interactionCount || 0))
      })
    }
    next.dailyHistory = next.dailyHistory.slice(-30)
    return next
  }

  function appendInteraction(date, groupId, targetUserId, entry) {
    if (!targetUserId || String(targetUserId) === String(entry.userId || '')) return
    const filePath = path.join(interactionDir, date, safeId(groupId), `${safeId(targetUserId)}.jsonl`)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  function recordMessage(payload, text, relations = {}) {
    if (!enabled || !payload || payload.message_type !== 'group') return false
    if (String(payload.user_id || '') === String(payload.self_id || '')) return false
    const cleanText = String(text || '').replace(/\r/g, '').trim().slice(0, maxMessageChars)
    const media = (Array.isArray(relations.media) ? relations.media : []).map((item) => ({
      kind: String(item && item.kind || '').slice(0, 20),
      file: String(item && item.file || '').slice(0, 200),
      duration: Math.max(0, Number(item && item.duration || 0))
    })).filter((item) => item.kind).slice(0, 20)
    const forwarded = (Array.isArray(relations.forwarded) ? relations.forwarded : []).map((item) => ({
      userId: String(item && item.userId || ''),
      nickname: String(item && item.nickname || '').slice(0, 80),
      text: String(item && item.text || '').slice(0, 1000),
      mediaTypes: normalizeStringList(item && item.mediaTypes, 10)
    })).filter((item) => item.text || item.mediaTypes.length).slice(0, 50)
    if (!cleanText && media.length === 0 && forwarded.length === 0) return false
    const timestamp = Number(payload.time) > 0 ? Number(payload.time) * 1000 : Date.now()
    const entry = {
      messageId: String(payload.message_id || ''),
      groupId: String(payload.group_id || ''),
      userId: String(payload.user_id || ''),
      nickname: String(payload.sender && (payload.sender.card || payload.sender.nickname) || '').slice(0, 80),
      title: String(payload.sender && payload.sender.title || '').slice(0, 80),
      mentionedUserIds: Array.isArray(relations.mentionedUserIds) ? relations.mentionedUserIds.map(String).slice(0, 20) : [],
      replyToUserId: String(relations.replyToUserId || ''),
      text: cleanText,
      media,
      forwarded,
      timestamp
    }
    if (!entry.groupId || !entry.userId) return false
    if (entry.messageId) {
      const messageKey = `${entry.groupId}:${entry.messageId}`
      const duplicateUntil = recentMessageIds.get(messageKey)
      if (duplicateUntil && duplicateUntil > Date.now()) return false
      recentMessageIds.set(messageKey, Date.now() + dedupeTtlMs)
      while (recentMessageIds.size > dedupeMax) recentMessageIds.delete(recentMessageIds.keys().next().value)
    }
    const filePath = path.join(journalDir, localDate(timestamp), safeId(entry.groupId), `${safeId(entry.userId)}.jsonl`)
    recordMember(payload, timestamp)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    const targets = new Set([...entry.mentionedUserIds, entry.replyToUserId].filter(Boolean))
    for (const targetUserId of targets) appendInteraction(localDate(timestamp), entry.groupId, targetUserId, entry)
    return true
  }

  async function loadMemberInteractions(date, groupId, userId) {
    const filePath = path.join(interactionDir, date, safeId(groupId), `${safeId(userId)}.jsonl`)
    const interactions = []
    let chars = 0
    if (!fs.existsSync(filePath)) return interactions
    const input = fs.createReadStream(filePath, { encoding: 'utf8' })
    const lines = readline.createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        let entry
        try { entry = JSON.parse(line) } catch { continue }
        if (!entry) continue
        const observation = describeJournalEntry(entry)
        if (!observation) continue
        if (interactions.length >= dailyMaxMessages || chars >= dailyMaxChars) continue
        const text = observation.slice(0, dailyMaxChars - chars)
        interactions.push({
          messageId: entry.messageId,
          fromUserId: entry.userId,
          nickname: entry.nickname,
          text,
          mentioned: (entry.mentionedUserIds || []).includes(String(userId)),
          replied: String(entry.replyToUserId || '') === String(userId)
        })
        chars += text.length
      }
    } catch {}
    return interactions
  }

  async function *iterateDayMembers(date) {
    const dir = path.join(journalDir, date)
    let groups
    try {
      groups = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      return
    }
    for (const group of groups) {
      const groupDir = path.join(dir, group.name)
      const files = fs.readdirSync(groupDir).filter((name) => name.endsWith('.jsonl'))
      for (const name of files) {
        const item = { groupId: '', userId: '', nickname: '', messages: [], chars: 0, total: 0 }
        const input = fs.createReadStream(path.join(groupDir, name), { encoding: 'utf8' })
        const lines = readline.createInterface({ input, crlfDelay: Infinity })
        for await (const line of lines) {
          let entry
          try { entry = JSON.parse(line) } catch { continue }
          if (!entry || !entry.groupId || !entry.userId) continue
          const observation = describeJournalEntry(entry)
          if (!observation) continue
          item.groupId = entry.groupId
          item.userId = entry.userId
          item.total += 1
          if (entry.nickname) item.nickname = entry.nickname
          if (item.messages.length >= dailyMaxMessages || item.chars >= dailyMaxChars) continue
          const remaining = dailyMaxChars - item.chars
          const message = observation.slice(0, remaining)
          if (message) {
            item.messages.push(message)
            item.chars += message.length
          }
        }
        if (item.groupId && item.userId) {
          item.interactions = await loadMemberInteractions(date, item.groupId, item.userId)
          yield item
        }
      }
    }
  }

  async function collectDay(date) {
    const members = new Map()
    for await (const member of iterateDayMembers(date)) members.set(cacheKey(member.groupId, member.userId), member)
    return members
  }

  function buildSummaryPrompt(member, previous) {
    return [
      '根据一名 QQ 群成员当天的发言更新其长期画像。只输出 JSON，不要 Markdown。',
      '不得推断或保存政治、宗教、健康、性取向、真实身份、住址、联系方式等敏感信息。',
      '玩笑、反讽和一次性情绪不能写成稳定事实。不确定内容放 uncertainInferences。',
      '这是累计画像的每日迭代，不是用当天内容覆盖旧画像。保留仍然有效的旧认识，只有新证据支持时才修改、增加或移除。',
      '字段：dailySummary(string，当天增量观察), summary(string，更新后的累计概括), interests(string[]，更新后的完整列表), communicationStyle(string[]，更新后的完整列表), stableFacts(string[]，更新后的完整列表), uncertainInferences(string[]), recentEvents(string[])。',
      `旧画像：${JSON.stringify(previous || {})}`,
      `当日本人发言（最多 ${dailyMaxMessages} 条）：\n${member.messages.map((text, index) => `${index + 1}. ${text}`).join('\n')}`,
      `当天其他成员对他的@、引用和回复：\n${(member.interactions || []).map((item) => JSON.stringify(item)).join('\n') || '无'}`
    ].join('\n')
  }

  async function collectGroupDay(date, groupName) {
    const dir = path.join(journalDir, date, groupName)
    const messages = []
    let chars = 0
    let files
    try { files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')) } catch { return messages }
    for (const file of files) {
      const input = fs.createReadStream(path.join(dir, file), { encoding: 'utf8' })
      const lines = readline.createInterface({ input, crlfDelay: Infinity })
      for await (const line of lines) {
        let entry
        try { entry = JSON.parse(line) } catch { continue }
        if (!entry) continue
        const observation = describeJournalEntry(entry)
        if (!observation) continue
        if (messages.length >= groupDailyMaxMessages || chars >= groupDailyMaxChars) continue
        const text = observation.slice(0, groupDailyMaxChars - chars)
        messages.push({ ...entry, text })
        chars += text.length
      }
    }
    return messages.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
  }

  function readGroupMemory(groupId) {
    try { return JSON.parse(fs.readFileSync(groupMemoryPath(groupId), 'utf8')) } catch { return null }
  }

  function saveGroupMemory(value) {
    if (!value || !value.groupId) return false
    const filePath = groupMemoryPath(value.groupId)
    const tempPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tempPath, filePath)
    return true
  }

  function buildGroupSummaryPrompt(groupId, messages, previous) {
    const members = new Map()
    for (const message of messages) {
      if (!members.has(message.userId)) {
        const member = readMember(groupId, message.userId) || {}
        members.set(message.userId, {
          userId: message.userId,
          currentName: member.currentName || message.nickname || '',
          aliases: member.aliases || [],
          titles: member.titles || []
        })
      }
    }
    const transcript = messages.map((item) => JSON.stringify({
      messageId: item.messageId,
      userId: item.userId,
      text: item.text,
      mentionedUserIds: item.mentionedUserIds || [],
      replyToUserId: item.replyToUserId || ''
    })).join('\n')
    return [
      '根据 QQ 群一天的结构化消息更新群级记忆，只输出 JSON，不要 Markdown。',
      '重点归纳：自然形成的成员称呼映射、稳定互动关系、群内角色和群梗。昵称映射必须指向成员列表中真实存在的 userId。',
      '单条玩笑不能建立高可信映射；明确自称、多人反复称呼、@或引用关系可提高可信度。',
      '字段：inferredAliases([{alias,targetUserId,confidence,evidenceMessageIds}]), relations([{fromUserId,toUserId,description,confidence}]), groupMemories(string[])。',
      `群成员目录：${JSON.stringify(Array.from(members.values()))}`,
      `旧群记忆：${JSON.stringify(previous || {})}`,
      `当日消息(JSONL)：\n${transcript}`
    ].join('\n')
  }

  async function summarizeGroupsDay(date = previousLocalDate(), summarize) {
    if (!enabled || typeof summarize !== 'function') return { skipped: true, processed: 0, failed: 0 }
    const dayDir = path.join(journalDir, date)
    let groups
    try { groups = fs.readdirSync(dayDir, { withFileTypes: true }).filter((item) => item.isDirectory()) } catch { return { skipped: false, processed: 0, failed: 0 } }
    let processed = 0
    let failed = 0
    for (const group of groups) {
      const markerPath = path.join(rootDir, 'jobs', date, `group_${group.name}.done`)
      if (fs.existsSync(markerPath)) continue
      try {
        const messages = await collectGroupDay(date, group.name)
        if (!messages.length) continue
        const groupId = String(messages[0].groupId || group.name)
        const output = await summarize(buildGroupSummaryPrompt(groupId, messages, readGroupMemory(groupId)), { groupId })
        const parsed = parseJsonObject(output)
        if (!parsed) throw new Error('群级总结未返回有效 JSON')
        const allowedUserIds = new Set()
        for (const item of messages) {
          if (item.userId) allowedUserIds.add(String(item.userId))
          if (item.replyToUserId) allowedUserIds.add(String(item.replyToUserId))
          for (const mentioned of Array.isArray(item.mentionedUserIds) ? item.mentionedUserIds : []) {
            if (mentioned) allowedUserIds.add(String(mentioned))
          }
        }
        saveGroupMemory(normalizeGroupMemory(parsed, groupId, date, allowedUserIds))
        fs.mkdirSync(path.dirname(markerPath), { recursive: true })
        fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf8')
        processed += 1
      } catch {
        failed += 1
      }
    }
    return { skipped: false, processed, failed }
  }

  async function summarizeDay(date = previousLocalDate(), summarize) {
    if (!enabled || dailyJobRunning || typeof summarize !== 'function') return { skipped: true, processed: 0 }
    const markerPath = path.join(rootDir, 'jobs', `${date}.done`)
    if (fs.existsSync(markerPath)) return { skipped: true, processed: 0 }
    dailyJobRunning = true
    let processed = 0
    let failed = 0
    try {
      for await (const member of iterateDayMembers(date)) {
        if (member.messages.length === 0) continue
        const memberMarker = path.join(rootDir, 'jobs', date, `${safeId(member.groupId)}_${safeId(member.userId)}.done`)
        if (fs.existsSync(memberMarker)) continue
        try {
          const previous = getProfile(member.groupId, member.userId)
          const output = await summarize(buildSummaryPrompt(member, previous), member)
          const parsed = parseJsonObject(output)
          if (!parsed) throw new Error('模型未返回有效 JSON')
          const fallback = {
            groupId: member.groupId,
            userId: member.userId,
            nickname: member.nickname,
            messageCount: previous && previous.lastSummaryDate === date
              ? Number(previous.messageCount || 0)
              : Number(previous && previous.messageCount || 0) + member.total,
            dailyMessageCount: member.total,
            lastSummaryDate: date
          }
          saveProfile(mergeProfile(previous, parsed, fallback, date, (member.interactions || []).length))
          fs.mkdirSync(path.dirname(memberMarker), { recursive: true })
          fs.writeFileSync(memberMarker, `${new Date().toISOString()}\n`, 'utf8')
          processed += 1
        } catch (error) {
          failed += 1
        }
      }
      if (failed === 0) {
        fs.mkdirSync(path.dirname(markerPath), { recursive: true })
        fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf8')
      }
      return { skipped: false, processed, failed }
    } finally {
      dailyJobRunning = false
    }
  }

  function cleanupJournals(now = Date.now()) {
    let names
    try { names = fs.readdirSync(journalDir) } catch { return 0 }
    const cutoff = now - retentionDays * 86400000
    let removed = 0
    for (const name of names) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue
      const timestamp = new Date(`${name}T00:00:00`).getTime()
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        fs.rmSync(path.join(journalDir, name), { recursive: true, force: true })
        fs.rmSync(path.join(interactionDir, name), { recursive: true, force: true })
        removed += 1
      }
    }
    return removed
  }

  function buildStyleContext(payload) {
    if (!enabled || !payload || payload.message_type !== 'group') return ''
    const profile = getProfile(payload.group_id, payload.user_id)
    if (!profile || !profile.communicationStyle.length) return ''
    return `当前发言者的交流风格参考（只用于自然调整本次回复方式，不要提及该参考；当前消息优先）：\n${profile.communicationStyle.join('、')}`.slice(0, Math.min(contextMaxChars, 500))
  }

  function getReplyMaterial(payload) {
    if (!enabled || !payload || payload.message_type !== 'group') {
      return { available: false, material: '' }
    }
    const profile = getProfile(payload.group_id, payload.user_id)
    if (!profile) return { available: false, material: '' }
    const lines = []
    if (profile.nickname) lines.push(`群内称呼：${profile.nickname}`)
    if (profile.summary) lines.push(`长期概括：${profile.summary}`)
    if (profile.interests.length) lines.push(`兴趣和关注：${profile.interests.join('、')}`)
    if (profile.stableFacts.length) lines.push(`已知信息：${profile.stableFacts.join('；')}`)
    if (profile.uncertainInferences.length) lines.push(`可能但不确定：${profile.uncertainInferences.join('；')}`)
    if (profile.recentEvents.length) lines.push(`近期事情：${profile.recentEvents.map((item) => item.content).join('；')}`)
    if (!lines.length) return { available: false, material: '' }
    return { available: true, material: lines.join('\n').slice(0, contextMaxChars) }
  }

  function findMembersByAlias(groupId, alias, limit = 5) {
    if (!enabled || !groupId) return []
    const query = String(alias || '').trim().toLowerCase()
    if (!query) return []
    const dir = path.join(memberDir, safeId(groupId))
    let files
    try { files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')) } catch { return [] }
    const matches = []
    for (const file of files) {
      let member
      try { member = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) } catch { continue }
      const aliases = Array.isArray(member.aliases) ? member.aliases.map((name) => String(name || '').trim()).filter(Boolean) : []
      const titles = Array.isArray(member.titles) ? member.titles.map((name) => String(name || '').trim()).filter(Boolean) : []
      const officialNames = [...aliases, ...titles]
      const exact = officialNames.some((name) => name.toLowerCase() === query)
      const partial = !exact && officialNames.some((name) => name.toLowerCase().includes(query) || query.includes(name.toLowerCase()))
      if (!exact && !partial) continue
      matches.push({
        userId: String(member.userId || ''),
        currentName: String(member.currentName || ''),
        aliases: aliases.slice(-5),
        titles: titles.slice(-3),
        match: exact ? 'exact' : 'partial',
        source: titles.some((title) => title.toLowerCase() === query) ? 'title' : 'profile',
        confidence: exact ? 1 : 0.8
      })
    }
    const groupMemory = readGroupMemory(groupId)
    for (const item of groupMemory && Array.isArray(groupMemory.inferredAliases) ? groupMemory.inferredAliases : []) {
      const inferred = String(item.alias || '').trim()
      const confidence = confidenceWithDecay(item.confidence, item.lastConfirmedDate)
      if (!inferred || confidence < 0.6) continue
      const exact = inferred.toLowerCase() === query
      const partial = !exact && (inferred.toLowerCase().includes(query) || query.includes(inferred.toLowerCase()))
      if (!exact && !partial) continue
      const existing = matches.find((match) => match.userId === String(item.targetUserId || ''))
      if (existing) {
        existing.inferredAliases = Array.from(new Set([...(existing.inferredAliases || []), inferred]))
        existing.confidence = Math.max(existing.confidence, confidence)
      } else {
        const member = readMember(groupId, item.targetUserId) || {}
        matches.push({
          userId: String(item.targetUserId || ''),
          currentName: String(member.currentName || ''),
          aliases: Array.isArray(member.aliases) ? member.aliases.slice(-5) : [],
          titles: Array.isArray(member.titles) ? member.titles.slice(-3) : [],
          inferredAliases: [inferred],
          match: exact ? 'exact' : 'partial',
          source: 'inferred',
          confidence
        })
      }
    }
    return matches.sort((a, b) => b.confidence - a.confidence || (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1)).slice(0, Math.max(1, limit))
  }

  function getGroupMemoryMaterial(payload) {
    if (!enabled || !payload || payload.message_type !== 'group') return { available: false, material: '' }
    const memory = readGroupMemory(payload.group_id)
    if (!memory) return { available: false, material: '' }
    const userId = String(payload.user_id || '')
    const relations = (memory.relations || []).filter((item) => (item.fromUserId === userId || item.toUserId === userId)
      && confidenceWithDecay(item.confidence, memory.lastSummaryDate, 0.99) >= 0.5).slice(0, 8)
    const lines = []
    if (relations.length) lines.push(`与当前发言者相关的互动：${relations.map((item) => `${item.fromUserId}->${item.toUserId} ${item.description}`).join('；')}`)
    if (memory.groupMemories && memory.groupMemories.length) lines.push(`群内共同记忆：${memory.groupMemories.join('；')}`)
    if (!lines.length) return { available: false, material: '' }
    return { available: true, material: lines.join('\n').slice(0, contextMaxChars) }
  }

  return { recordMessage, getProfile, saveProfile, buildStyleContext, getReplyMaterial, getGroupMemoryMaterial, findMembersByAlias, summarizeDay, summarizeGroupsDay, cleanupCache, cleanupJournals, collectDay, cacheSize: () => profileCache.size + memberCache.size }
}

module.exports = { createMemberMemory, localDate, previousLocalDate, normalizeProfile }
