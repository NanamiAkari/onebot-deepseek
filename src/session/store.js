function createSessionStore(config) {
  const pending = new Map()
  const pokeCooldown = new Map()
  const sessionHist = new Map()
  const roleCache = new Map()
  const mediaCache = new Map()
  const customReplyDrafts = new Map()
  const scheduleTaskDrafts = new Map()

  function getKey(payload) {
    const isGroup = payload.message_type === 'group'
    return isGroup ? `g:${payload.group_id}` : `u:${payload.user_id}`
  }

  function pushHistory(payload, userText, aiText) {
    if (!config.AI_CONTEXT_ENABLE) return
    const k = getKey(payload)
    const arr = sessionHist.get(k) || []
    arr.push({ role: 'user', content: String(userText || '').slice(0, 2000), ts: Date.now() })
    arr.push({ role: 'assistant', content: String(aiText || '').slice(0, 2000), ts: Date.now() })
    while (arr.length > config.AI_CONTEXT_WINDOW * 2) arr.shift()
    sessionHist.set(k, arr)
  }

  function getHistoryRaw(payload) {
    const k = getKey(payload)
    const arr = sessionHist.get(k) || []
    const now = Date.now()
    return arr.filter((x) => now - x.ts <= config.AI_CONTEXT_TTL * 1000)
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
    return out.slice(-config.AI_CONTEXT_WINDOW * 2)
  }

  function clearHistory(payload) {
    const k = getKey(payload)
    sessionHist.delete(k)
  }

  function trimMap(map, max) {
    while (map.size > max) map.delete(map.keys().next().value)
  }

  function cleanup(now = Date.now()) {
    const historyTtl = Math.max(60, Number(config.AI_CONTEXT_TTL || 900)) * 1000
    for (const [key, entries] of sessionHist.entries()) {
      const active = (entries || []).filter((item) => item && now - item.ts <= historyTtl)
      if (active.length) sessionHist.set(key, active)
      else sessionHist.delete(key)
    }
    for (const [key, item] of mediaCache.entries()) {
      if (!item || now - item.ts > Math.max(60, Number(config.AI_IMAGE_CONTEXT_TTL || 60)) * 1000) mediaCache.delete(key)
    }
    for (const [key, timestamp] of pokeCooldown.entries()) {
      if (now - Number(timestamp || 0) > 3600000) pokeCooldown.delete(key)
    }
    const max = Math.max(100, Number(config.AI_RUNTIME_CACHE_MAX || 1000))
    trimMap(sessionHist, max)
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
    needContext,
    getContext,
    clearHistory,
    cleanup
  }
}

module.exports = { createSessionStore }
