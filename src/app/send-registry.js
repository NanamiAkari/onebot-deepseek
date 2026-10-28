// 会话级发送指纹：防止同一段内容在短时间内被发两次。
//
// 两个真实来源：
//   1. 模型既用 send_group_msg 工具发了一遍，又把同样的话作为最终文本交给上层发送；
//   2. OneBot 超时看似失败、实际已经发出，上层重试再发一遍。
//
// 关键约束（照抄参考项目 sender.js 的经验）：只有真正发送成功后才记账。
// 发送前记账会把合法重试误判成重复，导致消息被静默吞掉。

const DEFAULT_TTL_MS = 9000
const DEFAULT_MAX_ENTRIES = 2000

function createSendRegistry(options = {}) {
  const rawTtl = options.ttlMs
  const parsedTtl = Number.isFinite(Number(rawTtl)) ? Number(rawTtl) : DEFAULT_TTL_MS
  const ttlMs = Math.max(0, Math.min(60000, parsedTtl))
  const maxEntries = Math.max(100, Math.min(10000, Math.floor(Number(options.maxEntries) || DEFAULT_MAX_ENTRIES)))
  const recent = new Map()
  let hits = 0

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
  }

  function segmentKey(segment) {
    if (!segment || typeof segment !== 'object') return ''
    const type = String(segment.type || '')
    const data = segment.data && typeof segment.data === 'object' ? segment.data : {}
    if (type === 'text') return normalizeText(data.text)
    if (type === 'image') {
      const file = String(data.file || data.file_id || '').trim()
      const url = String(data.url || data.path || '').trim()
      if (file) {
        // base64 内联太长，用长度 + 尾部做指纹，避免把整张图塞进 Map 键。
        if (/^base64:\/\//i.test(file)) return `image:base64:${file.length}:${file.slice(-48)}`
        return `image:${file}`
      }
      return url ? `image:${url}` : 'image:'
    }
    return ''
  }

  function contentKey(content) {
    if (typeof content === 'string') {
      const text = normalizeText(content)
      return text ? `text:${text}` : ''
    }
    if (Array.isArray(content)) {
      const texts = []
      const others = []
      for (const segment of content) {
        if (!segment || typeof segment !== 'object') continue
        const type = String(segment.type || '')
        // 引用和 @ 不参与内容判断：带引用的工具发送要和最终纯文本命中同一个指纹。
        if (type === 'reply' || type === 'at' || type === 'face') continue
        if (type === 'text') {
          texts.push(String((segment.data && segment.data.text) || ''))
          continue
        }
        const key = segmentKey(segment)
        if (key) others.push(key)
      }
      const text = normalizeText(texts.join(''))
      const parts = []
      if (text) parts.push(`text:${text}`)
      parts.push(...others)
      return parts.join('|')
    }
    if (content && typeof content === 'object') {
      if (content.sticker != null) return `sticker:${String(content.sticker)}`
      if (content.text != null) {
        const text = normalizeText(content.text)
        return text ? `text:${text}` : ''
      }
    }
    return ''
  }

  function fingerprint(chatKey, content) {
    const key = contentKey(content)
    if (!key) return ''
    return `${String(chatKey || 'chat:unknown')}::${key}`
  }

  function sweep(now) {
    if (recent.size <= maxEntries) {
      for (const [key, at] of recent) {
        if (now - at >= ttlMs) recent.delete(key)
      }
      return
    }
    for (const [key, at] of recent) {
      if (now - at >= ttlMs) recent.delete(key)
    }
    while (recent.size > maxEntries) recent.delete(recent.keys().next().value)
  }

  function isDuplicate(print) {
    if (!ttlMs || !print) return false
    const at = recent.get(print)
    if (!at) return false
    if (Date.now() - at >= ttlMs) {
      recent.delete(print)
      return false
    }
    hits += 1
    return true
  }

  function markSent(print) {
    if (!ttlMs || !print) return
    const now = Date.now()
    recent.set(print, now)
    sweep(now)
  }

  function reset() {
    recent.clear()
    hits = 0
  }

  return {
    ttlMs,
    fingerprint,
    isDuplicate,
    markSent,
    reset,
    stats: () => ({ entries: recent.size, hits })
  }
}

module.exports = { createSendRegistry }
