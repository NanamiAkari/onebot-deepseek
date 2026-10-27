function createSessionStore(config) {
  const pending = new Map()
  const pokeCooldown = new Map()
  const sessionHist = new Map()
  const groupMessageHist = new Map()
  const roleCache = new Map()
  const mediaCache = new Map()
  const customReplyDrafts = new Map()
  const scheduleTaskDrafts = new Map()
  // Keep the receipt even when its message falls out of the bounded chat cache.
  // Object identity also provides an unambiguous boundary for events without IDs.
  const groupReceipts = new WeakMap()
  let receivedSequence = 0

  function limit(value, fallback, max, min = 1) {
    const number = Number(value)
    return Number.isFinite(number) && number >= min
      ? Math.min(max, Math.floor(number))
      : fallback
  }

  const historyWindow = () => limit(config.AI_CONTEXT_WINDOW, 6, 100, 0)
  const historyTtl = () => limit(config.AI_CONTEXT_TTL, 900, Number.MAX_SAFE_INTEGER) * 1000
  const groupCount = () => limit(config.AI_GROUP_CONTEXT_MESSAGES, 6, 100, 0)
  const groupMaxChars = () => limit(config.AI_GROUP_CONTEXT_MAX_CHARS, 3000, 20000)
  const groupTtl = () => limit(config.AI_GROUP_CONTEXT_TTL, 300, Number.MAX_SAFE_INTEGER) * 1000
  const cacheMax = () => limit(config.AI_RUNTIME_CACHE_MAX, 1000, 10000)

  function isSelfMessage(payload) {
    return payload && payload.self_id != null && payload.user_id != null
      && String(payload.self_id) === String(payload.user_id)
  }

  function messageId(payload) {
    return String(payload.message_id ?? payload.messageId ?? '')
  }

  function groupContent(payload, text, maxChars) {
    const sender = payload.sender && (payload.sender.card || payload.sender.nickname)
    const label = String(sender || '群成员').replace(/[\r\n]/g, ' ').trim().slice(0, 80)
    const userId = String(payload.user_id ?? '').replace(/[\r\n]/g, '').slice(0, 64)
    const prefix = `${label}（QQ:${userId || '未知'}）：`
    const content = String(text || '').replace(/\r/g, '').trim().slice(0, 2000)
    return `${prefix}${content}`.slice(0, maxChars)
  }

  function activeEntries(map, key, now, ttl, max) {
    if (max <= 0) {
      map.delete(key)
      return []
    }
    const entries = (map.get(key) || []).filter((item) => item && now - item.ts <= ttl).slice(-max)
    if (entries.length) map.set(key, entries)
    else map.delete(key)
    return entries
  }

  function receiptFor(payload, entries) {
    const receipt = groupReceipts.get(payload)
    if (receipt && receipt.key === getKey(payload)) return receipt.sequence
    const id = messageId(payload)
    const current = id && entries.find((item) => item.messageId === id)
    return current ? current.sequence : null
  }

  function getKey(payload) {
    const isGroup = payload.message_type === 'group'
    return isGroup ? `g:${payload.group_id}` : `u:${payload.user_id}`
  }

  function pushHistory(payload, userText, aiText) {
    if (!config.AI_CONTEXT_ENABLE || isSelfMessage(payload) || historyWindow() === 0) return
    const k = getKey(payload)
    const now = Date.now()
    const arr = activeEntries(sessionHist, k, now, historyTtl(), historyWindow() * 2)
    const sequence = groupReceipts.get(payload)?.sequence
    const content = payload.message_type === 'group'
      ? groupContent(payload, userText, 2000)
      : String(userText || '').slice(0, 2000)
    arr.push({ role: 'user', content, ts: now, sequence })
    arr.push({ role: 'assistant', content: String(aiText || '').slice(0, 2000), ts: now, sequence })
    while (arr.length > historyWindow() * 2) arr.shift()
    sessionHist.set(k, arr)
    trimMap(sessionHist, cacheMax())
  }

  function getHistoryRaw(payload) {
    const k = getKey(payload)
    const arr = activeEntries(sessionHist, k, Date.now(), historyTtl(), historyWindow() * 2)
    const sequence = groupReceipts.get(payload)?.sequence
    return arr.filter((item) => sequence == null || item.sequence == null || item.sequence < sequence)
      .map((item) => ({ role: item.role, content: item.content.slice(0, 2000), ts: item.ts }))
  }

  function recordGroupMessage(payload, text) {
    if (!config.AI_CONTEXT_ENABLE || !payload || payload.message_type !== 'group' || isSelfMessage(payload)) return
    const key = `g:${payload.group_id}`
    if (groupReceipts.has(payload)) return
    const now = Date.now()
    const count = groupCount()
    const arr = activeEntries(groupMessageHist, key, now, groupTtl(), count * 2)
    const id = messageId(payload)
    const duplicate = id && arr.find((item) => item.messageId === id)
    const sequence = duplicate ? duplicate.sequence : ++receivedSequence
    groupReceipts.set(payload, { key, sequence })
    if (duplicate || !count || !String(text || '').trim()) return
    arr.push({ content: groupContent(payload, text, Math.min(2000, groupMaxChars())), ts: now, messageId: id, sequence })
    while (arr.length > count * 2) arr.shift()
    groupMessageHist.set(key, arr)
    trimMap(groupMessageHist, cacheMax())
  }

  function getRecentGroupContext(payload, _currentText) {
    if (!config.AI_CONTEXT_ENABLE || !payload || payload.message_type !== 'group' || isSelfMessage(payload)) return []
    const key = `g:${payload.group_id}`
    const maxChars = groupMaxChars()
    const count = groupCount()
    if (!count) return []
    const items = activeEntries(groupMessageHist, key, Date.now(), groupTtl(), count * 2)
    const sequence = receiptFor(payload, items)
    // Unknown receipt: do not guess by text or wall time and accidentally include
    // a later message (or remove a different person's identical message).
    if (sequence == null) return []
    const out = []
    let chars = 0
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.sequence >= sequence) continue
      const content = item.content.slice(0, Math.min(2000, maxChars - chars))
      if (!content) break
      out.unshift({ role: 'user', content })
      chars += content.length
      if (out.length >= count || chars >= maxChars) break
    }
    return out
  }

  function needContext(text) {
    const t = String(text || '').trim()
    if (!config.AI_CONTEXT_ENABLE) return false
    if (t.length <= 12) return true
    if (/继续|上文|刚才|前面|同样|还是|上述|之前/i.test(t)) return true
    return false
  }

  function getContext(payload, userText) {
    if (!needContext(userText)) return []
    const raw = getHistoryRaw(payload)
    const out = []
    for (const h of raw) out.push({ role: h.role, content: h.content })
    return historyWindow() ? out.slice(-historyWindow() * 2) : []
  }

  function clearHistory(payload) {
    const k = getKey(payload)
    sessionHist.delete(k)
    groupMessageHist.delete(k)
  }

  function trimMap(map, max) {
    while (map.size > max) map.delete(map.keys().next().value)
  }

  function cleanup(now = Date.now()) {
    for (const key of sessionHist.keys()) activeEntries(sessionHist, key, now, historyTtl(), historyWindow() * 2)
    for (const key of groupMessageHist.keys()) activeEntries(groupMessageHist, key, now, groupTtl(), groupCount() * 2)
    for (const [key, item] of mediaCache.entries()) {
      if (!item || now - item.ts > Math.max(60, Number(config.AI_IMAGE_CONTEXT_TTL || 60)) * 1000) mediaCache.delete(key)
    }
    for (const [key, timestamp] of pokeCooldown.entries()) {
      if (now - Number(timestamp || 0) > 3600000) pokeCooldown.delete(key)
    }
    const max = cacheMax()
    trimMap(sessionHist, max)
    trimMap(groupMessageHist, max)
    trimMap(mediaCache, max)
    trimMap(roleCache, max)
    trimMap(pokeCooldown, max)
  }

  return {
    pending,
    pokeCooldown,
    roleCache,
    mediaCache,
    customReplyDrafts,
    scheduleTaskDrafts,
    getKey,
    pushHistory,
    getHistoryRaw,
    recordGroupMessage,
    getRecentGroupContext,
    needContext,
    getContext,
    clearHistory,
    cleanup
  }
}

module.exports = { createSessionStore }
