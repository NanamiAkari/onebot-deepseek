// 出站消息段白名单。
//
// 模型可以通过 send_group_msg / send_private_msg 传入任意消息段，而 OneBot 会忠实执行：
// 一个 {type:'at', data:{qq:'all'}} 就是一次 @全体成员。这里只放行聊天真正需要的段，
// 并校验 @ 目标、引用目标、图片地址，越权的一律丢弃；全被丢弃时由调用方报错。

const { escapeCqText } = require('./text')

const ALLOWED_TYPES = new Set(['text', 'image', 'at', 'reply', 'face'])
const MAX_SEGMENTS = 10
const MAX_AT_SEGMENTS = 3

function normalizeId(value) {
  return String(value ?? '').trim()
}

function isSafeImageSource(source) {
  if (!source) return false
  // 只允许内联数据、公网地址，或协议端自己的图片标识（不含路径分隔符）。
  if (/^base64:\/\//i.test(source)) return true
  if (/^https?:\/\//i.test(source)) return true
  return /^[A-Za-z0-9._-]{1,128}$/.test(source)
}

function sanitizeOutboundSegments(segments, options = {}) {
  const allowedReplyIds = options.allowedReplyIds instanceof Set
    ? options.allowedReplyIds
    : new Set(Array.isArray(options.allowedReplyIds) ? options.allowedReplyIds.map(normalizeId) : [])
  const list = Array.isArray(segments) ? segments : []
  const out = []
  let atCount = 0
  for (const raw of list) {
    if (out.length >= MAX_SEGMENTS) break
    if (!raw || typeof raw !== 'object') continue
    const type = String(raw.type || '')
    if (!ALLOWED_TYPES.has(type)) continue
    const data = raw.data && typeof raw.data === 'object' ? raw.data : {}

    if (type === 'text') {
      const text = escapeCqText(String(data.text ?? ''))
      if (text.trim()) out.push({ type: 'text', data: { text } })
      continue
    }

    if (type === 'at') {
      const qq = normalizeId(data.qq)
      // 只允许数字 QQ 号：'all' 就是全体成员，绝不能由模型决定。
      if (!/^\d{1,20}$/.test(qq)) continue
      if (atCount >= MAX_AT_SEGMENTS) continue
      atCount += 1
      out.push({ type: 'at', data: { qq } })
      continue
    }

    if (type === 'reply') {
      const id = normalizeId(data.id ?? data.message_id)
      if (!id) continue
      // 只允许引用当前消息或当前消息已经引用的那条，避免模型去引用任意历史消息。
      if (allowedReplyIds.size > 0 && !allowedReplyIds.has(id)) continue
      out.push({ type: 'reply', data: { id } })
      continue
    }

    if (type === 'image') {
      const file = normalizeId(data.file ?? data.file_id)
      const url = normalizeId(data.url ?? data.path)
      const source = file || url
      if (!isSafeImageSource(source)) continue
      out.push({ type: 'image', data: { file: source } })
      continue
    }

    if (type === 'face') {
      const id = normalizeId(data.id)
      if (!/^\d{1,6}$/.test(id)) continue
      out.push({ type: 'face', data: { id } })
    }
  }
  return out
}

module.exports = { sanitizeOutboundSegments, isSafeImageSource, MAX_SEGMENTS, MAX_AT_SEGMENTS }
