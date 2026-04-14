const { WebSocketServer } = require('ws')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const { HttpsProxyAgent } = require('https-proxy-agent')
require('dotenv').config()

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5000
const PATH = process.env.ONEBOT_PATH || '/onebot/v11/ws'
const PROVIDER = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase()
const MODEL = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || (PROVIDER === 'gemini' ? 'gemini-1.5-flash' : PROVIDER === 'openai' ? 'gpt-3.5-turbo' : 'deepseek-chat')
const API_KEY = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || ''
const API_URL = process.env.LLM_API_URL || process.env.DEEPSEEK_API_URL || (PROVIDER === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.deepseek.com/v1/chat/completions')
const SYSTEM_PROMPT = (() => {
  const f = process.env.PROMPT_FILE
  if (f) {
    const p = path.isAbsolute(f) ? f : path.join(__dirname, f)
    try {
      const s = fs.readFileSync(p, 'utf8').trim()
      if (s) return s
    } catch {}
  }
  return process.env.SYSTEM_PROMPT || '你是一个QQ群内的AI助手，回答简洁且有帮助。'
})()
const GEMINI_KEY = (process.env.LLM_PROVIDER === 'gemini' ? process.env.LLM_API_KEY : process.env.GEMINI_API_KEY) || ''
const GEMINI_MODEL = (process.env.LLM_PROVIDER === 'gemini' ? process.env.LLM_MODEL : process.env.GEMINI_MODEL) || 'gemini-1.5-flash-latest'
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || ''
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
const HTTPS_AGENT = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined
const REQUIRE_PREFIX = String(process.env.AI_REQUIRE_PREFIX || 'true').toLowerCase() === 'true'
const PREFIXES = (process.env.AI_PREFIXES || '/ai').split(',').map((s) => s.trim()).filter(Boolean)
const IGNORE_REGEX = process.env.AI_IGNORE_REGEX ? new RegExp(process.env.AI_IGNORE_REGEX, 'i') : null
const MAX_MEDIA_BYTES = parseInt(process.env.AI_MAX_MEDIA_BYTES || '5242880', 10)
const MEDIA_REFERER = process.env.AI_MEDIA_REFERER || ''
const OPENAI_KEY = process.env.OPENAI_API_KEY || ''
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || process.env.LLM_API_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
const OPENAI_WIRE_API = (process.env.OPENAI_WIRE_API || '').toLowerCase()
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || ''
const OPENAI_NETWORK_ACCESS = process.env.OPENAI_NETWORK_ACCESS || ''
const AI_SIMPLE_MODE = String(process.env.AI_SIMPLE_MODE || 'false').toLowerCase() === 'true'
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '12000', 10)
const AI_POKE_ENABLE = String(process.env.AI_POKE_ENABLE || 'true').toLowerCase() === 'true'
const AI_POKE_COOLDOWN = parseInt(process.env.AI_POKE_COOLDOWN || '10', 10)
const AI_POKE_REPLY_TEXT = process.env.AI_POKE_REPLY_TEXT || '拍了拍'
const AI_CONTEXT_ENABLE = String(process.env.AI_CONTEXT_ENABLE || 'true').toLowerCase() === 'true'
const AI_CONTEXT_WINDOW = parseInt(process.env.AI_CONTEXT_WINDOW || '6', 10)
const AI_CONTEXT_TTL = parseInt(process.env.AI_CONTEXT_TTL || '900', 10)
const AI_BAN_DURATION = parseInt(process.env.AI_BAN_DURATION || '600', 10)
const AI_MOD_ENABLE = String(process.env.AI_MOD_ENABLE || 'true').toLowerCase() === 'true'
const AI_IMAGE_CONTEXT_TTL = parseInt(process.env.AI_IMAGE_CONTEXT_TTL || '60', 10)
const AI_IMAGE_CONTEXT_MODE = (process.env.AI_IMAGE_CONTEXT_MODE || 'rule').toLowerCase()
const AI_IMAGE_CONTEXT_REQUIRE_HINTS = String(process.env.AI_IMAGE_CONTEXT_REQUIRE_HINTS || 'true').toLowerCase() === 'true'
const AI_IMAGE_CONTEXT_REQUIRE_SAME_USER = String(process.env.AI_IMAGE_CONTEXT_REQUIRE_SAME_USER || 'true').toLowerCase() === 'true'
const AI_IMAGE_HINT_REGEX = process.env.AI_IMAGE_HINT_REGEX ? new RegExp(process.env.AI_IMAGE_HINT_REGEX, 'i') : /(上图|这张图|图中|这幅图|图片里)/i
const AI_IMAGE_CONTEXT_MAX = parseInt(process.env.AI_IMAGE_CONTEXT_MAX || '3', 10)
const AI_IMAGE_ONLY_NO_CALL = String(process.env.AI_IMAGE_ONLY_NO_CALL || 'true').toLowerCase() === 'true'
const BANNED_PATH = path.join(__dirname, 'banned.json')

const wss = new WebSocketServer({ port: PORT, path: PATH })

wss.on('listening', () => {
  try {
    if (!fs.existsSync(BANNED_PATH)) fs.writeFileSync(BANNED_PATH, JSON.stringify({}), 'utf8')
  } catch {}
})

const pending = new Map()
const pokeCooldown = new Map()
const sessionHist = new Map()
const roleCache = new Map()
const mediaCache = new Map()

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    let payload
    try {
      payload = JSON.parse(data.toString())
    } catch {
      return
    }
    if (payload && payload.echo && pending.has(payload.echo)) {
      const r = pending.get(payload.echo)
      pending.delete(payload.echo)
      r(payload)
      return
    }
    if (payload.post_type === 'notice' && payload.notice_type === 'notify' && payload.sub_type === 'poke') {
      if (!AI_POKE_ENABLE) return
      const ONLY_SELF = String(process.env.AI_POKE_ONLY_SELF || 'true').toLowerCase() === 'true'
      if (ONLY_SELF) {
        const tgt = payload.target_id || payload.target || payload.receiver_id || payload.to_id
        if (tgt && String(tgt) !== String(payload.self_id)) return
      }
      const gid = payload.group_id
      const uid = payload.user_id
      const key = `${gid || 'priv'}:${uid}`
      const now = Date.now()
      const last = pokeCooldown.get(key) || 0
      if (now - last < AI_POKE_COOLDOWN * 1000) return
      pokeCooldown.set(key, now)
      if (gid) {
        try {
          const r = await sendAction(ws, 'send_group_poke', { group_id: gid, user_id: uid }).catch(() => null)
          if (!(r && r.status === 'ok')) {
            const msg = [{ type: 'text', data: { text: AI_POKE_REPLY_TEXT } }]
            await sendAction(ws, 'send_group_msg', { group_id: gid, message: msg })
          }
        } catch {}
      } else {
        try {
          const msg = [{ type: 'text', data: { text: AI_POKE_REPLY_TEXT } }]
          await sendAction(ws, 'send_private_msg', { user_id: uid, message: msg })
        } catch {}
      }
      return
    }
    if (payload.post_type !== 'message') return
    const isGroup = payload.message_type === 'group'
    const raw = extractContent(payload.message)
    const key = getKey(payload)
    let ctxImgUsed = false
    if (raw.media && raw.media.length > 0) {
      mediaCache.set(key, { media: raw.media.slice(0, AI_IMAGE_CONTEXT_MAX), ts: Date.now(), userId: payload.user_id })
    } else {
      const cached = mediaCache.get(key)
      if (cached && Date.now() - cached.ts <= AI_IMAGE_CONTEXT_TTL * 1000) {
        const textNow = String(raw.text || '')
        let hintsOk = !AI_IMAGE_CONTEXT_REQUIRE_HINTS || AI_IMAGE_HINT_REGEX.test(textNow)
        if (AI_IMAGE_CONTEXT_MODE === 'ai') hintsOk = true
        const userOk = !AI_IMAGE_CONTEXT_REQUIRE_SAME_USER || String(payload.user_id) === String(cached.userId)
        if (hintsOk && userOk) {
          raw.media = (raw.media || []).concat(cached.media).slice(0, AI_IMAGE_CONTEXT_MAX)
          ctxImgUsed = true
        }
      }
    }
    const mentioned = checkMention(payload.message, payload.self_id)
    if (!mentioned) return
    const content = raw
    if ((!content.media || content.media.length === 0) && content.replyId) {
      const resp = await sendAction(ws, 'get_msg', { message_id: content.replyId }).catch(() => null)
      if (resp && resp.status === 'ok' && resp.data && resp.data.message) {
        const q = extractContent(resp.data.message)
        const merged = content.media ? content.media.slice() : []
        if (q.media && q.media.length) {
          for (const m of q.media) {
            merged.push(m)
            if (merged.length >= AI_IMAGE_CONTEXT_MAX) break
          }
          content.media = merged
        }
        if (!content.text && q.text) content.text = q.text
      }
    }
    if (isGroup) {
      const ban = await checkModeration(ws, payload.group_id, payload.user_id, payload.self_id, content.text).catch(() => false)
      if (ban) return
    }
    const cmdHandled = await handleCommands(ws, payload, content.text).catch(() => false)
    if (cmdHandled) return
    if (!shouldRespond(content.text)) {
      if (AI_IMAGE_ONLY_NO_CALL && content.media && content.media.length > 0) return
      return
    }
    const stripped = stripPrefix(content.text || '')
    const hist = getContext(payload, stripped)
    const aiText = await callLLM(stripped, content.media, hist, { contextImage: ctxImgUsed })
    if (!aiText) return
    const messageSegments = buildReplySegments(payload.message_id, aiText)
    const action = isGroup ? 'send_group_msg' : 'send_private_msg'
    const params = isGroup
      ? { group_id: payload.group_id, message: messageSegments }
      : { user_id: payload.user_id, message: messageSegments }
    const frame = { action, params, echo: String(Date.now()) }
    try {
      ws.send(JSON.stringify(frame))
    } catch {}
    pushHistory(payload, stripped, aiText)
  })
})

function extractContent(message) {
  let text = ''
  const media = []
  let replyId = ''
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === 'text') {
        text += (seg.data && seg.data.text) || ''
      } else if (seg.type === 'image' && seg.data) {
        const url = seg.data.url || seg.data.file
        if (url) media.push({ kind: 'image', url })
      } else if ((seg.type === 'record' || seg.type === 'audio') && seg.data) {
        const url = seg.data.url || seg.data.file
        if (url) media.push({ kind: 'audio', url })
      } else if (seg.type === 'video' && seg.data) {
        const url = seg.data.url || seg.data.file
        if (url) media.push({ kind: 'video', url })
      } else if (seg.type === 'face') {
        text += '[表情]'
      } else if (seg.type === 'emoji' && seg.data && seg.data.id) {
        text += `[emoji:${seg.data.id}]`
      } else if (seg.type === 'reply' && seg.data) {
        replyId = String(seg.data.id || seg.data.message_id || '')
      }
    }
    text = text.trim()
    text = text.replace(/\s*\[CQ:at,qq=\d+\]\s*/g, '')
    return { text, media, replyId }
  }
  if (typeof message === 'string') {
    const t = message.replace(/\[CQ:at,qq=\d+\]/g, '').trim()
    const cqMedia = parseCQMedia(message)
    return { text: t, media: cqMedia.length ? cqMedia : media, replyId }
  }
  return { text: '', media, replyId }
}

function checkMention(message, selfId) {
  if (Array.isArray(message)) {
    return message.some((seg) => seg.type === 'at' && String(seg.data && seg.data.qq) === String(selfId))
  }
  if (typeof message === 'string') {
    const m = message.match(/\[CQ:at,qq=(\d+)\]/)
    return Boolean(m && String(m[1]) === String(selfId))
  }
  return false
}

function shouldRespond(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (IGNORE_REGEX && IGNORE_REGEX.test(t)) return false
  if (!REQUIRE_PREFIX) return true
  return PREFIXES.some((p) => t.startsWith(p))
}

function stripPrefix(text) {
  const t = String(text || '').trim()
  for (const p of PREFIXES) {
    if (t.startsWith(p)) return t.slice(p.length).trim()
  }
  return t
}

async function callLLM(text, media, hist, opts) {
  const b = await callOpenAI(text, media, hist, opts)
  if (b) return sanitizeText(b)
  return '上游模型暂时不可用，请稍后再试'
}

function sanitizeText(s) {
  let t = String(s || '')
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/`+/g, '')
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s*([-*+]|(\d+[\.\)]))\s+/gm, '')
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2')
  t = t.replace(/(\*|_)(.*?)\1/g, '$2')
  t = t.replace(/\$\$[\s\S]*?\$\$/g, ' ')
  t = t.replace(/\\\[[\s\S]*?\\\]/g, ' ')
  t = t.replace(/\\\([\s\S]*?\\\)/g, ' ')
  t = t.replace(/\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/g, ' ')
  t = t.replace(/<[^>]+>/g, ' ')
  t = t.replace(/[ \t]+\n/g, '\n')
  t = t.replace(/\n{3,}/g, '\n\n')
  t = t.trim()
  return t.slice(0, 2000)
}
async function callGemini(text, media, opts) {
  if (!GEMINI_KEY) return null
  try {
    console.log('调用Gemini')
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`
    const prefix = opts && opts.contextImage ? '若下方图片与问题无关，请忽略图片，仅回答文本问题。\n' : ''
    const parts = [{ text: `${SYSTEM_PROMPT}\n\n${prefix}${text || '你好'}` }]
    if (Array.isArray(media) && media.length > 0) {
      const limited = media.slice(0, AI_IMAGE_CONTEXT_MAX)
      for (const m of limited) {
        const file = await sourceToBase64(m.url)
        if (file && file.data && file.mime && Buffer.byteLength(file.data, 'base64') <= MAX_MEDIA_BYTES) {
          parts.push({ inline_data: { data: file.data, mime_type: file.mime } })
        }
      }
      console.log(`媒体数量: ${limited.length}`)
    }
    const res = await axios.post(
      url,
      {
        contents: [
          {
            role: 'user',
            parts
          }
        ]
      },
      { timeout: 30000, httpsAgent: HTTPS_AGENT, proxy: false }
    )
    const content = res.data && res.data.candidates && res.data.candidates[0] && res.data.candidates[0].content && res.data.candidates[0].content.parts && res.data.candidates[0].content.parts[0] && res.data.candidates[0].content.parts[0].text
    if (!content) return null
    console.log('Gemini成功')
    return String(content).slice(0, 2000)
  } catch (e) {
    const status = e && e.response && e.response.status
    const msg = e && e.response && e.response.data && (e.response.data.error || e.response.data.message || e.response.data)
    console.log('Gemini失败', status || '', msg || '')
    return null
  }
}

async function callOpenAI(text, media, hist, opts) {
  if (!OPENAI_KEY) return null
  try {
    console.log('调用OpenAI')
    const useResponses = OPENAI_WIRE_API === 'responses' || /ark\.cn-beijing\.volces\.com\/api\/v3$/i.test(OPENAI_BASE_URL)
    const url = useResponses ? `${OPENAI_BASE_URL}/responses` : `${OPENAI_BASE_URL}/chat/completions`
    const content = []
    if (opts && opts.contextImage) {
      if (useResponses) content.push({ type: 'input_text', text: '若下方图片与问题无关，请忽略图片，仅回答文本问题。' })
      else content.push({ type: 'text', text: '若下方图片与问题无关，请忽略图片，仅回答文本问题。' })
    }
    if (useResponses) content.push({ type: 'input_text', text: text || 'Hello' })
    else content.push({ type: 'text', text: text || 'Hello' })
    if (Array.isArray(media) && media.length > 0) {
      const limited = media.slice(0, AI_IMAGE_CONTEXT_MAX)
      for (const m of limited) {
        const file = await sourceToBase64(m.url)
        if (file && file.data) {
          const dataUrl = `data:${file.mime};base64,${file.data}`
          if (useResponses) content.push({ type: 'input_image', image_url: dataUrl })
          else content.push({ type: 'image_url', image_url: { url: dataUrl } })
        }
      }
      console.log(`OpenAI媒体数量: ${limited.length}`)
    }
    const msg = []
    if (!useResponses) {
      msg.push({ role: 'system', content: SYSTEM_PROMPT })
      if (Array.isArray(hist) && hist.length > 0) {
        for (const h of hist) {
          msg.push({ role: h.role, content: h.content })
        }
      }
      msg.push({ role: 'user', content })
    }
    const res = await axios.post(
      url,
      useResponses
        ? {
            model: OPENAI_MODEL,
            input: [{ role: 'user', content }],
            ...(OPENAI_REASONING_EFFORT ? { reasoning: { effort: OPENAI_REASONING_EFFORT } } : {}),
            ...(OPENAI_NETWORK_ACCESS ? { metadata: { network_access: OPENAI_NETWORK_ACCESS } } : {})
          }
        : { model: OPENAI_MODEL, messages: msg },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: OPENAI_TIMEOUT_MS,
        httpsAgent: HTTPS_AGENT,
        proxy: false
      }
    )
    const contentText =
      (res.data && res.data.output_text) ||
      (res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content) ||
      (res.data && res.data.output && res.data.output_text) ||
      ''
    if (!contentText) return null
    console.log('OpenAI成功')
    const txt = String(contentText).slice(0, 2000)
    if (Array.isArray(media) && media.length > 0) {
      const ignoreHints = /(未提供(对应)?图片|无法识别到你提供的图片|暂时无法解答|请你补充相关信息)/i
      if (ignoreHints.test(txt)) {
        const again = await callGemini(text, media, opts)
        if (again) return String(again).slice(0, 2000)
      }
    }
    return txt
  } catch (e) {
    const status = e && e.response && e.response.status
    const msg = e && e.response && e.response.data
    console.log('OpenAI失败', status || '', msg || '')
    if (status === 429) return '上游限流，请稍后再试'
    if (status === 401) return '上游鉴权失败，请检查 API Key'
    if (status === 502 || status === 503 || status === 504) return '上游网关异常（5xx），请稍后再试'
    return '上游调用失败'
  }
}

async function callDeepseek(text) {
  if (!DEEPSEEK_KEY) return null
  try {
    console.log('调用DeepSeek')
    const res = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text || '你好' }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000,
        httpsAgent: HTTPS_AGENT,
        proxy: false
      }
    )
    const content = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content
    if (!content) return null
    console.log('DeepSeek成功')
    return String(content).slice(0, 2000)
  } catch (e) {
    console.log('DeepSeek失败')
    return null
  }
}

function buildReplySegments(messageId, content) {
  return [
    { type: 'reply', data: { id: messageId } },
    { type: 'text', data: { text: content } }
  ]
}

function sendAction(ws, action, params) {
  const echo = `e${Date.now()}${Math.random().toString(36).slice(2)}`
  const frame = { action, params, echo }
  return new Promise((resolve, reject) => {
    pending.set(echo, resolve)
    try {
      ws.send(JSON.stringify(frame))
    } catch (e) {
      pending.delete(echo)
      reject(e)
      return
    }
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo)
        reject(new Error('timeout'))
      }
    }, 8000)
  })
}

function parseCQMedia(str) {
  const out = []
  const re = /\[CQ:(image|record|audio|video|emoji|face)(?:,([^\]]*))?\]/g
  let m
  while ((m = re.exec(str)) !== null) {
    const type = m[1]
    const kv = {}
    if (m[2]) {
      m[2].split(',').forEach((pair) => {
        const [k, v] = pair.split('=')
        if (k && v) kv[k] = v
      })
    }
    if (type === 'emoji') continue
    if (type === 'face') continue
    const url = kv.url || kv.file
    if (url) {
      const kind = type === 'record' ? 'audio' : type
      out.push({ kind, url })
    }
  }
  return out
}

async function sourceToBase64(src) {
  if (!src) return null
  if (/^base64:\/\//i.test(src)) {
    const data = src.replace(/^base64:\/\//i, '')
    return { mime: 'application/octet-stream', data }
  }
  if (/^data:/i.test(src)) {
    const i = src.indexOf(',')
    if (i > 0) {
      const head = src.slice(0, i)
      const data = src.slice(i + 1)
      const mimeMatch = head.match(/^data:([^;]+)/i)
      const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream'
      return { mime, data }
    }
    return null
  }
  if (/^file:\/\//i.test(src)) {
    try {
      const p = src.replace(/^file:\/\//i, '')
      const buf = fs.readFileSync(p)
      const ext = path.extname(p).toLowerCase()
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.mp3' ? 'audio/mpeg'
        : ext === '.wav' ? 'audio/wav'
        : ext === '.mp4' ? 'video/mp4'
        : 'application/octet-stream'
      return { mime, data: buf.toString('base64') }
    } catch {
      return null
    }
  }
  if (/^[\\/].+/.test(src)) {
    try {
      const buf = fs.readFileSync(src)
      const ext = path.extname(src).toLowerCase()
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.mp3' ? 'audio/mpeg'
        : ext === '.wav' ? 'audio/wav'
        : ext === '.mp4' ? 'video/mp4'
        : 'application/octet-stream'
      return { mime, data: buf.toString('base64') }
    } catch {
      // fallthrough
    }
  }
  if (/^https?:\/\//i.test(src)) {
    try {
      const headers = { 'User-Agent': 'Mozilla/5.0' }
      if (MEDIA_REFERER) {
        headers.Referer = MEDIA_REFERER
      } else {
        try {
          const u = new URL(src)
          const host = u.hostname || ''
          if (/qpic\.cn$/i.test(host) || /gchat\.qpic\.cn$/i.test(host)) headers.Referer = 'https://gchat.qpic.cn'
          else if (/qun\.qq\.com$/i.test(host)) headers.Referer = 'https://qun.qq.com'
        } catch {}
      }
      const res = await axios.get(src, { responseType: 'arraybuffer', httpsAgent: HTTPS_AGENT, proxy: false, timeout: 15000, headers })
      const ct = (res.headers && res.headers['content-type']) || ''
      const mime = ct.split(';')[0] || 'application/octet-stream'
      const data = Buffer.from(res.data).toString('base64')
      return { mime, data }
    } catch (e) {
      const status = e && e.response && e.response.status
      console.log('媒体下载失败', status || '')
      return null
    }
  }
  return null
}
process.on('SIGINT', () => {
  try { wss.close() } catch {}
  process.exit(0)
})

function getKey(payload) {
  const isGroup = payload.message_type === 'group'
  return isGroup ? `g:${payload.group_id}` : `u:${payload.user_id}`
}

function pushHistory(payload, userText, aiText) {
  if (!AI_CONTEXT_ENABLE) return
  const k = getKey(payload)
  const arr = sessionHist.get(k) || []
  arr.push({ role: 'user', content: String(userText || '').slice(0, 2000), ts: Date.now() })
  arr.push({ role: 'assistant', content: String(aiText || '').slice(0, 2000), ts: Date.now() })
  while (arr.length > AI_CONTEXT_WINDOW * 2) arr.shift()
  sessionHist.set(k, arr)
}

function getHistoryRaw(payload) {
  const k = getKey(payload)
  const arr = sessionHist.get(k) || []
  const now = Date.now()
  return arr.filter((x) => now - x.ts <= AI_CONTEXT_TTL * 1000)
}

function needContext(text) {
  const t = String(text || '').trim()
  if (!AI_CONTEXT_ENABLE) return false
  if (t.length <= 12) return true
  if (/继续|上文|刚才|前面|同样|还是|上述|之前/i.test(t)) return true
  return false
}

function getContext(payload, userText) {
  if (!needContext(userText)) return []
  const raw = getHistoryRaw(payload)
  const out = []
  for (const h of raw) out.push({ role: h.role, content: h.content })
  return out.slice(-AI_CONTEXT_WINDOW * 2)
}

function buildTextWithContext(text, hist) {
  if (!Array.isArray(hist) || hist.length === 0) return text
  const parts = []
  for (const h of hist) {
    parts.push(h.role === 'user' ? `用户：${h.content}` : `助手：${h.content}`)
  }
  parts.push(`用户：${text}`)
  return parts.join('\n')
}

async function checkModeration(ws, groupId, userId, selfId, text) {
  if (!AI_MOD_ENABLE) return false
  const banned = loadBanned(groupId)
  if (!banned || !banned.length) return false
  const t = String(text || '')
  let hit = false
  for (const w of banned) {
    if (w.startsWith('re:')) {
      try {
        const re = new RegExp(w.slice(3), 'i')
        if (re.test(t)) { hit = true; break }
      } catch {}
    } else {
      if (t.includes(w)) { hit = true; break }
    }
  }
  if (!hit) return false
  const role = await getMyRole(ws, groupId, selfId).catch(() => 'member')
  if (role === 'owner' || role === 'admin') {
    await sendAction(ws, 'set_group_ban', { group_id: groupId, user_id: userId, duration: AI_BAN_DURATION }).catch(() => {})
  }
  const msg = [{ type: 'text', data: { text: '已检测到不允许的内容' } }]
  await sendAction(ws, 'send_group_msg', { group_id: groupId, message: msg }).catch(() => {})
  return true
}

function loadBanned(groupId) {
  try {
    const data = fs.readFileSync(BANNED_PATH, 'utf8')
    const obj = JSON.parse(data || '{}')
    const k = String(groupId || '')
    const arr = obj[k] || []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function saveBanned(groupId, list) {
  try {
    const data = fs.readFileSync(BANNED_PATH, 'utf8')
    const obj = JSON.parse(data || '{}')
    obj[String(groupId || '')] = list
    fs.writeFileSync(BANNED_PATH, JSON.stringify(obj), 'utf8')
  } catch {}
}

async function getMyRole(ws, groupId, selfId) {
  const k = `role:${groupId}`
  if (roleCache.has(k)) return roleCache.get(k)
  const uid = typeof selfId === 'number' ? selfId : 0
  const info = await sendAction(ws, 'get_group_member_info', { group_id: groupId, user_id: uid }).catch(() => null)
  let role = 'member'
  if (info && info.status === 'ok' && info.data && info.data.role) role = info.data.role
  roleCache.set(k, role)
  return role
}

async function getUserRole(ws, groupId, userId) {
  const info = await sendAction(ws, 'get_group_member_info', { group_id: groupId, user_id: userId }).catch(() => null)
  let role = 'member'
  if (info && info.status === 'ok' && info.data && info.data.role) role = info.data.role
  return role
}
async function handleCommands(ws, payload, text) {
  const t = String(stripPrefix(text || '')).trim()
  const nt = t.replace(/\s+/g, ' ')
  const isBanned = /^(banned|违禁词|禁词|敏感词)|^(添加|删除|移除|增加|新增)\s*(违禁词|禁词|敏感词)/i.test(nt)
  const isContext = /^(context|上下文)/i.test(nt)
  const isPoke = /^(poke|拍一拍)/i.test(nt)
  if (!isBanned && !isContext && !isPoke) return false
  const isGroup = payload.message_type === 'group'
  const roleUser = isGroup ? await getUserRole(ws, payload.group_id, payload.user_id).catch(() => 'member') : 'owner'
  if (isContext) {
    if (/重置|清空|reset/i.test(nt)) {
      const k = getKey(payload)
      sessionHist.set(k, [])
      const msg = [{ type: 'text', data: { text: '上下文已重置' } }]
      if (isGroup) await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: msg })
      else await sendAction(ws, 'send_private_msg', { user_id: payload.user_id, message: msg })
      return true
    }
    if (roleUser === 'owner' || roleUser === 'admin') {
      if (/开启|打开|on/i.test(nt)) process.env.AI_CONTEXT_ENABLE = 'true'
      if (/关闭|off/i.test(nt)) process.env.AI_CONTEXT_ENABLE = 'false'
      const mw = nt.match(/(窗口|window)\s+(\d+)/i)
      if (mw && mw[2]) process.env.AI_CONTEXT_WINDOW = String(Math.max(1, parseInt(mw[2], 10)))
      const mt = nt.match(/(时长|ttl)\s+(\d+)\s*(秒|分钟|分)?/i)
      if (mt && mt[2]) {
        const val = parseInt(mt[2], 10)
        const unit = (mt[3] || '').trim()
        const sec = unit.includes('分') || unit.includes('分钟') ? val * 60 : val
        process.env.AI_CONTEXT_TTL = String(Math.max(30, sec))
      }
      const msg = [{ type: 'text', data: { text: `上下文：开关=${process.env.AI_CONTEXT_ENABLE} 窗口=${process.env.AI_CONTEXT_WINDOW||AI_CONTEXT_WINDOW} 时长=${process.env.AI_CONTEXT_TTL||AI_CONTEXT_TTL}s` } }]
      if (isGroup) await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: msg })
      else await sendAction(ws, 'send_private_msg', { user_id: payload.user_id, message: msg })
      return true
    }
    return false
  }
  if (isPoke) {
    if (roleUser === 'owner' || roleUser === 'admin') {
      if (/开启|打开|on/i.test(nt)) process.env.AI_POKE_ENABLE = 'true'
      if (/关闭|off/i.test(nt)) process.env.AI_POKE_ENABLE = 'false'
      const msg = [{ type: 'text', data: { text: `拍一拍开关：${process.env.AI_POKE_ENABLE}` } }]
      if (isGroup) await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: msg })
      else await sendAction(ws, 'send_private_msg', { user_id: payload.user_id, message: msg })
      return true
    }
    return false
  }
  if (isBanned) {
    const list = loadBanned(payload.group_id)
    if (/列表|查看|list/i.test(nt)) {
      const msg = [{ type: 'text', data: { text: `违禁词列表：${list.join(',') || '（空）'}｜治理开关=${process.env.AI_MOD_ENABLE||AI_MOD_ENABLE}｜禁言时长=${process.env.AI_BAN_DURATION||AI_BAN_DURATION}s` } }]
      await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: msg }).catch(() => {})
      return true
    }
    if (!(roleUser === 'owner' || roleUser === 'admin')) {
      const denied = [{ type: 'text', data: { text: '需要管理员权限才能管理违禁词' } }]
      if (isGroup) await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: denied }).catch(() => {})
      else await sendAction(ws, 'send_private_msg', { user_id: payload.user_id, message: denied }).catch(() => {})
      return true
    } else if (/add\s+(.+)/i.test(nt) || /(添加|增加|新增)\s*(违禁词|禁词|敏感词)?\s+(.+)/i.test(nt) || /(违禁词|禁词|敏感词)\s*(添加|增加|新增)\s+(.+)/i.test(nt)) {
      const m = nt.match(/add\s+(.+)/i) || nt.match(/(添加|增加|新增)\s*(违禁词|禁词|敏感词)?\s+(.+)/i) || nt.match(/(违禁词|禁词|敏感词)\s*(添加|增加|新增)\s+(.+)/i)
      const w = m ? (m[4] || m[3] || m[1]).trim() : ''
      if (w) {
        if (!list.includes(w)) list.push(w)
        saveBanned(payload.group_id, list)
        const ok = [{ type: 'text', data: { text: `添加违禁词成功：${w}` } }]
        await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: ok }).catch(() => {})
      }
    } else if (/rm\s+(.+)/i.test(nt) || /(删除|移除|去除)\s*(违禁词|禁词|敏感词)?\s+(.+)/i.test(nt) || /(违禁词|禁词|敏感词)\s*(删除|移除|去除)\s+(.+)/i.test(nt)) {
      const m = nt.match(/rm\s+(.+)/i) || nt.match(/(删除|移除|去除)\s*(违禁词|禁词|敏感词)?\s+(.+)/i) || nt.match(/(违禁词|禁词|敏感词)\s*(删除|移除|去除)\s+(.+)/i)
      const w = m ? (m[4] || m[3] || m[1]).trim() : ''
      if (w) {
        const idx = list.indexOf(w)
        if (idx >= 0) list.splice(idx, 1)
        saveBanned(payload.group_id, list)
        const ok = [{ type: 'text', data: { text: `删除违禁词成功：${w}` } }]
        await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: ok }).catch(() => {})
      }
    } else if (/clear|清空|全部删除|重置|reset|empty|purge/i.test(nt)) {
      while (list.length) list.pop()
      saveBanned(payload.group_id, list)
      const ok = [{ type: 'text', data: { text: '违禁词列表已清空' } }]
      await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: ok }).catch(() => {})
    } else if (/治理(开启|打开)|moderation on/i.test(nt)) {
      process.env.AI_MOD_ENABLE = 'true'
      const ok = [{ type: 'text', data: { text: '违禁词治理已开启' } }]
      await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: ok }).catch(() => {})
    } else if (/治理关闭|moderation off/i.test(nt)) {
      process.env.AI_MOD_ENABLE = 'false'
      const ok = [{ type: 'text', data: { text: '违禁词治理已关闭' } }]
      await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: ok }).catch(() => {})
    } else if (/(禁言时长|duration)\s+(\d+)\s*(秒|分钟|分)?/i.test(nt)) {
      const m = nt.match(/(禁言时长|duration)\s+(\d+)\s*(秒|分钟|分)?/i)
      if (m && m[2]) {
        const val = parseInt(m[2], 10)
        const unit = (m[3] || '').trim()
        const sec = unit.includes('分') || unit.includes('分钟') ? val * 60 : val
        process.env.AI_BAN_DURATION = String(Math.max(30, sec))
        const ok = [{ type: 'text', data: { text: `禁言时长已设置为：${process.env.AI_BAN_DURATION}s` } }]
        await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: ok }).catch(() => {})
      }
    }
    return true
  }
  return false
}
