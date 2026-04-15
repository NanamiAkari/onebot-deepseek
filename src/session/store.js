function createSessionStore(config) {
  const pending = new Map()
  const pokeCooldown = new Map()
  const sessionHist = new Map()
  const roleCache = new Map()
  const mediaCache = new Map()

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

  return {
    pending,
    pokeCooldown,
    roleCache,
    mediaCache,
    getKey,
    pushHistory,
    getHistoryRaw,
    needContext,
    getContext
  }
}

module.exports = { createSessionStore }
