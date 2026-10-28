// 入站消息段解析：把 OneBot 的消息段数组（或 CQ 字符串）拆成文本、媒体和引用。
//
// 这里同时覆盖 `mface`（QQ 商城表情/表情包）：它和普通 `image` 一样带 url/file，
// 但类型不同。以前只处理 image，表情包会被整段丢弃——模型既看不到图，
// 连“对方发了个表情”都不知道。

function parseCQMedia(str) {
  const out = []
  const re = /\[CQ:(image|mface|record|audio|video|emoji|face)(?:,([^\]]*))?\]/g
  let match
  while ((match = re.exec(str)) !== null) {
    const type = match[1]
    if (type === 'emoji' || type === 'face') continue
    const params = {}
    if (match[2]) {
      for (const pair of match[2].split(',')) {
        const index = pair.indexOf('=')
        if (index > 0) params[pair.slice(0, index)] = pair.slice(index + 1)
      }
    }
    const source = params.url || params.file
    if (!source) continue
    const kind = type === 'record' ? 'audio' : type === 'mface' ? 'image' : type
    out.push({ kind, url: source, file: params.file || '' })
  }
  return out
}

function extractContent(message) {
  let text = ''
  const media = []
  let replyId = ''
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (!segment || typeof segment !== 'object') continue
      if (segment.type === 'text') {
        text += (segment.data && segment.data.text) || ''
      } else if (segment.type === 'image' && segment.data) {
        const url = segment.data.url || ''
        const file = segment.data.file || ''
        if (url || file) media.push({ kind: 'image', url, file })
      } else if (segment.type === 'mface' && segment.data) {
        // 表情包：留一个占位让模型知道有人发表情，并把图片当普通图片交给视觉链路。
        text += '[表情包]'
        const url = segment.data.url || ''
        const file = segment.data.file || ''
        if (url || file) media.push({ kind: 'image', url, file })
      } else if ((segment.type === 'record' || segment.type === 'audio') && segment.data) {
        const url = segment.data.url || segment.data.file
        if (url) media.push({ kind: 'audio', url, file: segment.data.file || '', duration: Number(segment.data.duration || 0) })
      } else if (segment.type === 'video' && segment.data) {
        const url = segment.data.url || segment.data.file
        if (url) media.push({ kind: 'video', url, file: segment.data.file || '', duration: Number(segment.data.duration || 0) })
      } else if (segment.type === 'face') {
        text += '[表情]'
      } else if (segment.type === 'emoji' && segment.data && segment.data.id) {
        text += `[emoji:${segment.data.id}]`
      } else if (segment.type === 'reply' && segment.data) {
        replyId = String(segment.data.id || segment.data.message_id || '')
      } else if (segment.type === 'at') {
        text += ' '
      }
    }
    text = text.trim()
    text = text.replace(/\s*\[CQ:at,qq=\d+\]\s*/g, '')
    const forwardIds = message
      .filter((segment) => segment && segment.type === 'forward' && segment.data && (segment.data.id || segment.data.resid))
      .map((segment) => String(segment.data.id || segment.data.resid))
      .slice(0, 3)
    return { text, media, replyId, forwardIds }
  }
  if (typeof message === 'string') {
    const t = message
      .replace(/\[CQ:at,qq=\d+\]/g, '')
      .replace(/\[CQ:face,[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:mface[^\]]*\]/g, '[表情包]')
      .replace(/\[CQ:(?:image|record|audio|video|reply|forward),[^\]]*\]/g, '')
      .trim()
    const cqMedia = parseCQMedia(message)
    const forwardIds = Array.from(message.matchAll(/\[CQ:forward,(?:id|resid)=([^,\]]+)/g)).map((match) => match[1]).slice(0, 3)
    return { text: t, media: cqMedia, replyId, forwardIds }
  }
  return { text: '', media, replyId, forwardIds: [] }
}

module.exports = { extractContent, parseCQMedia }
