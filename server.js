const { WebSocketServer } = require('ws')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const config = require('./src/config')
const { createSessionStore } = require('./src/session/store')
const { extractOpenAIText, extractOpenAIToolCalls, formatOpenAITools } = require('./src/providers/openai')
const { createDefaultToolRegistry } = require('./src/agent/tools')
const { createAgentRunner } = require('./src/agent/runner')
const { createToolExecutor } = require('./src/agent/tool-executor')
const { createMessageHandler } = require('./src/app/message-handler')

const {
  PROJECT_ROOT,
  PORT,
  PATH: WS_PATH,
  PROVIDER,
  MODEL,
  API_KEY,
  API_URL,
  SYSTEM_PROMPT,
  GEMINI_KEY,
  GEMINI_MODEL,
  DEEPSEEK_KEY,
  DEEPSEEK_MODEL,
  HTTPS_AGENT,
  REQUIRE_PREFIX,
  GROUP_REQUIRE_MENTION,
  PREFIXES,
  ADMIN_USER_IDS,
  IGNORE_REGEX,
  MAX_MEDIA_BYTES,
  MEDIA_REFERER,
  OPENAI_KEY,
  OPENAI_MODEL,
  OPENAI_BASE_URL,
  OPENAI_WIRE_API,
  OPENAI_REASONING_EFFORT,
  OPENAI_NETWORK_ACCESS,
  AI_SIMPLE_MODE,
  OPENAI_TIMEOUT_MS,
  AI_REPLY_MAX_CHARS,
  AI_REPLY_CHUNK_CHARS,
  AI_POKE_ENABLE,
  AI_POKE_COOLDOWN,
  AI_POKE_REPLY_FILE,
  AI_POKE_REPLY_TEXT,
  AI_POKE_REPLY_TEXTS,
  AI_CONTEXT_ENABLE,
  AI_CONTEXT_WINDOW,
  AI_CONTEXT_TTL,
  AI_BAN_DURATION,
  AI_MOD_ENABLE,
  AI_IMAGE_CONTEXT_TTL,
  AI_IMAGE_CONTEXT_MODE,
  AI_IMAGE_CONTEXT_REQUIRE_HINTS,
  AI_IMAGE_CONTEXT_REQUIRE_SAME_USER,
  AI_IMAGE_HINT_REGEX,
  AI_IMAGE_CONTEXT_MAX,
  AI_IMAGE_ONLY_NO_CALL,
  BANNED_PATH
} = config

const sessionStore = createSessionStore(config)
const { pending, pokeCooldown, roleCache, mediaCache, getKey, pushHistory, getHistoryRaw, needContext, getContext, clearHistory } = sessionStore
const toolRegistry = createDefaultToolRegistry()
const toolExecutor = createToolExecutor({ sendAction, getHistoryRaw, workspaceRoot: PROJECT_ROOT })
const agentRunner = createAgentRunner({
  toolRegistry,
  toolExecutor,
  invokeModel: async (input) => callLLM(input.message, input.media, input.history, { contextImage: input.contextImage, tools: input.tools, structured: true }),
  invokeModelWithToolResult: async (input) => callLLM(input.message, input.media, input.history, { contextImage: input.contextImage, tools: input.tools, structured: true }),
  maxSteps: 10
})
const AI_POKE_ONLY_SELF = String(process.env.AI_POKE_ONLY_SELF || 'true').toLowerCase() === 'true'
let currentPokeReplyTexts = []

function resolveProjectFile(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(PROJECT_ROOT, filePath)
}

function getPokeReplyFilePath() {
  return resolveProjectFile(AI_POKE_REPLY_FILE || 'poke_replies.json')
}

function toOutboundImageFile(source) {
  const value = String(source || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || /^data:/i.test(value) || /^base64:\/\//i.test(value) || /^file:\/\//i.test(value)) return value
  if (/^[\\/]/.test(value)) return `file://${encodeURI(value.replace(/\\/g, '/'))}`
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    const normalized = value.replace(/\\/g, '/')
    return `file:///${encodeURI(normalized)}`
  }
  return value
}

function pickPokeImageSource(item) {
  if (!item || typeof item !== 'object') return ''
  return String(item.url || item.source || item.file || item.localPath || '').trim()
}

function normalizePokeReplyItem(item) {
  if (typeof item === 'string') {
    const content = String(item || '').replace(/\r/g, '').trim()
    return content ? { type: 'text', content } : null
  }
  if (!item || typeof item !== 'object') return null
  if (item.type === 'image') {
    const source = pickPokeImageSource(item)
    if (!source) return null
    const name = String(item.name || '').trim()
    return name ? { type: 'image', source, name } : { type: 'image', source }
  }
  const content = String(item.content || item.text || '').replace(/\r/g, '').trim()
  return content ? { type: 'text', content } : null
}

function normalizePokeReplyList(items) {
  return (Array.isArray(items) ? items : []).map(normalizePokeReplyItem).filter(Boolean)
}

function serializePokeReplyItem(item) {
  if (!item || typeof item !== 'object') return null
  if (item.type === 'image') {
    const source = String(item.source || '').trim()
    if (!source) return null
    const name = String(item.name || '').trim()
    return name ? { type: 'image', source, name } : { type: 'image', source }
  }
  const content = String(item.content || '').replace(/\r/g, '').trim()
  return content ? { type: 'text', content } : null
}

function pokeReplySignature(item) {
  if (!item || typeof item !== 'object') return ''
  if (item.type === 'image') return `image:${String(item.source || '').trim()}`
  return `text:${String(item.content || '').replace(/\r/g, '').trim()}`
}

function loadPokeReplyTextsFromFile() {
  try {
    const filePath = getPokeReplyFilePath()
    if (!fs.existsSync(filePath)) return []
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return normalizePokeReplyList(parsed)
    } catch {}
    return normalizePokeReplyList(
      raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'))
    )
  } catch {
    return []
  }
}

function refreshPokeReplyTexts() {
  const fileItems = loadPokeReplyTextsFromFile()
  if (fileItems.length > 0) currentPokeReplyTexts = fileItems
  else currentPokeReplyTexts = normalizePokeReplyList(Array.isArray(AI_POKE_REPLY_TEXTS) && AI_POKE_REPLY_TEXTS.length > 0 ? AI_POKE_REPLY_TEXTS : [AI_POKE_REPLY_TEXT])
  return currentPokeReplyTexts.slice()
}

function getPokeReplyTexts() {
  if (!Array.isArray(currentPokeReplyTexts) || currentPokeReplyTexts.length === 0) return refreshPokeReplyTexts()
  return currentPokeReplyTexts.slice()
}

function savePokeReplyTexts(list) {
  const items = normalizePokeReplyList(list)
  const filePath = getPokeReplyFilePath()
  const serialized = items.map(serializePokeReplyItem).filter(Boolean)
  fs.writeFileSync(filePath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8')
  currentPokeReplyTexts = items
  return items.slice()
}

function dedupeTextList(list) {
  const seen = new Set()
  const out = []
  for (const item of normalizePokeReplyList(list)) {
    const key = pokeReplySignature(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function previewPokeReplyText(item) {
  const normalizedItem = normalizePokeReplyItem(item)
  if (!normalizedItem) return '（空）'
  if (normalizedItem.type === 'image') return '[图片回复]'
  const normalized = String(normalizedItem.content || '').replace(/\r/g, '').trim()
  if (!normalized) return '（空）'
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean)
  const firstLines = lines.slice(0, 2).join(' ↵ ')
  const compact = firstLines.replace(/\s+/g, ' ').trim()
  return compact.length > 60 ? `${compact.slice(0, 60)}...` : compact
}

function isConfiguredAdmin(userId) {
  return ADMIN_USER_IDS.includes(String(userId || ''))
}

const wss = new WebSocketServer({ port: PORT, path: WS_PATH })

wss.on('listening', () => {
  try {
    if (!fs.existsSync(BANNED_PATH)) fs.writeFileSync(BANNED_PATH, JSON.stringify({}), 'utf8')
  } catch {}
})

const onMessage = createMessageHandler({
  pending,
  pokeCooldown,
  mediaCache,
  getKey,
  pushHistory,
  sendAction,
  extractContent,
  resolveMediaSources,
  checkMention,
  checkModeration,
  handleCommands,
  shouldIgnoreText,
  GROUP_REQUIRE_MENTION,
  shouldRespond,
  stripPrefix,
  getContext,
  agentRunner,
  buildReplySegments,
  AI_POKE_ENABLE,
  AI_POKE_COOLDOWN,
  AI_POKE_REPLY_TEXT,
  AI_POKE_REPLY_TEXTS,
  getPokeReplyTexts,
  AI_POKE_ONLY_SELF,
  buildPokeReplyMessageSegments: buildPokeReplyMessageSegmentsAsync,
  AI_REPLY_CHUNK_CHARS,
  AI_IMAGE_CONTEXT_TTL,
  AI_IMAGE_CONTEXT_REQUIRE_HINTS,
  AI_IMAGE_HINT_REGEX,
  AI_IMAGE_CONTEXT_MODE,
  AI_IMAGE_CONTEXT_MAX,
  AI_IMAGE_ONLY_NO_CALL
})

wss.on('connection', (ws) => {
  ws.on('message', (data) => onMessage(ws, data))
})

process.on('unhandledRejection', (reason) => {
  const text = reason && reason.stack ? String(reason.stack) : String(reason)
  console.log('unhandledRejection', text)
})

process.on('uncaughtException', (error) => {
  const text = error && error.stack ? String(error.stack) : String(error)
  console.log('uncaughtException', text)
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
        const url = seg.data.url || ''
        const file = seg.data.file || ''
        if (url || file) media.push({ kind: 'image', url, file })
      } else if ((seg.type === 'record' || seg.type === 'audio') && seg.data) {
        const url = seg.data.url || seg.data.file
        if (url) media.push({ kind: 'audio', url, file: seg.data.file || '' })
      } else if (seg.type === 'video' && seg.data) {
        const url = seg.data.url || seg.data.file
        if (url) media.push({ kind: 'video', url, file: seg.data.file || '' })
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
  if (shouldIgnoreText(t)) return false
  if (!REQUIRE_PREFIX) return true
  return PREFIXES.some((p) => t.startsWith(p))
}

function shouldIgnoreText(text) {
  const t = String(text || '').trim()
  if (!t) return false
  return Boolean(IGNORE_REGEX && IGNORE_REGEX.test(t))
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
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const out = {
      text: b.text ? sanitizeText(b.text) : '',
      toolCalls: Array.isArray(b.toolCalls) ? b.toolCalls : []
    }
    if (out.text || out.toolCalls.length > 0) return out
  }
  if (b) return sanitizeText(b)
  if (opts && opts.structured) return { text: '上游模型暂时不可用，请稍后再试', toolCalls: [] }
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
  const effectiveMedia = Array.isArray(media) ? media.slice() : []
  const imageCount = Array.isArray(effectiveMedia) ? effectiveMedia.filter((m) => m && m.kind === 'image').length : 0
  const requestTimeout = imageCount > 0 ? Math.max(OPENAI_TIMEOUT_MS, 60000) : OPENAI_TIMEOUT_MS
  try {
    console.log('调用OpenAI')
    const useResponses = OPENAI_WIRE_API === 'responses' || /ark\.cn-beijing\.volces\.com\/api\/v3$/i.test(OPENAI_BASE_URL)
    const url = useResponses ? `${OPENAI_BASE_URL}/responses` : `${OPENAI_BASE_URL}/chat/completions`
    const content = []
    let attached = 0
    if (opts && opts.contextImage) {
      if (useResponses) content.push({ type: 'input_text', text: '若下方图片与问题无关，请忽略图片，仅回答文本问题。' })
      else content.push({ type: 'text', text: '若下方图片与问题无关，请忽略图片，仅回答文本问题。' })
    }
    if (useResponses) content.push({ type: 'input_text', text: text || 'Hello' })
    else content.push({ type: 'text', text: text || 'Hello' })
    if (Array.isArray(effectiveMedia) && effectiveMedia.length > 0) {
      const limited = effectiveMedia.filter((m) => m && m.kind === 'image').slice(0, AI_IMAGE_CONTEXT_MAX)
      for (const m of limited) {
        const imageUrl = await toOpenAIImageUrl(m)
        if (!imageUrl) continue
        if (useResponses) content.push({ type: 'input_image', image_url: imageUrl })
        else content.push({ type: 'image_url', image_url: { url: imageUrl } })
        attached += 1
      }
      console.log(`OpenAI媒体数量: ${attached}`)
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
    const tools = formatOpenAITools(opts && opts.tools, useResponses)
    const buildPayload = (includeTools) => useResponses
      ? {
          model: OPENAI_MODEL,
          input: [{ role: 'user', content }],
          ...(OPENAI_REASONING_EFFORT ? { reasoning: { effort: OPENAI_REASONING_EFFORT } } : {}),
          ...(OPENAI_NETWORK_ACCESS ? { metadata: { network_access: OPENAI_NETWORK_ACCESS } } : {}),
          ...(includeTools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
        }
      : {
          model: OPENAI_MODEL,
          messages: msg,
          ...(includeTools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
        }
    let res
    try {
      res = await axios.post(
        url,
        buildPayload(true),
        {
          headers: {
            Authorization: `Bearer ${OPENAI_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: requestTimeout,
          httpsAgent: HTTPS_AGENT,
          proxy: false
        }
      )
    } catch (e) {
      const status = e && e.response && e.response.status
      const raw = e && e.response && e.response.data
      const errorText = typeof raw === 'string' ? raw : JSON.stringify(raw || '')
      const canFallback = tools.length > 0 && (status === 400 || status === 404 || /tool|parameter|unsupported|schema|function/i.test(errorText))
      if (!canFallback) throw e
      console.log('OpenAI工具调用参数不兼容，回退纯文本模式')
      res = await axios.post(
        url,
        buildPayload(false),
        {
          headers: {
            Authorization: `Bearer ${OPENAI_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: requestTimeout,
          httpsAgent: HTTPS_AGENT,
          proxy: false
        }
      )
    }
    const contentText = extractOpenAIText(res.data)
    const toolCalls = extractOpenAIToolCalls(res.data)
    if (!contentText && toolCalls.length === 0) return null
    console.log('OpenAI成功')
    const txt = String(contentText || '').slice(0, 2000)
    if (txt && Array.isArray(effectiveMedia) && effectiveMedia.length > 0) {
      const ignoreHints = /(未提供(对应)?图片|无法识别到你提供的图片|暂时无法解答|请你补充相关信息)/i
      if (ignoreHints.test(txt)) {
        const again = await callGemini(text, effectiveMedia, opts)
        if (again) return { text: String(again).slice(0, 2000), toolCalls }
      }
    }
    return { text: txt, toolCalls }
  } catch (e) {
    const status = e && e.response && e.response.status
    const msg = e && e.response && e.response.data
    const errorMessage = e && e.message ? String(e.message) : ''
    let errText = ''
    if (typeof msg === 'string') errText = msg
    else {
      try {
        errText = JSON.stringify(msg || '')
      } catch {
        errText = String(msg || '')
      }
    }
    console.log('OpenAI失败', status || '', `media=${Array.isArray(media) ? media.length : 0}`, `timeout=${requestTimeout}`, errorMessage, errText.slice(0, 500))
    if (status === 429) return opts && opts.structured ? { text: '上游限流，请稍后再试', toolCalls: [] } : '上游限流，请稍后再试'
    if (status === 401) return opts && opts.structured ? { text: '上游鉴权失败，请检查 API Key', toolCalls: [] } : '上游鉴权失败，请检查 API Key'
    if (status === 502 || status === 503 || status === 504) return opts && opts.structured ? { text: '上游网关异常（5xx），请稍后再试', toolCalls: [] } : '上游网关异常（5xx），请稍后再试'
    if (errorMessage && /timeout/i.test(errorMessage)) return opts && opts.structured ? { text: '图片分析超时，请稍后重试或发送更小的图片', toolCalls: [] } : '图片分析超时，请稍后重试或发送更小的图片'
    return opts && opts.structured ? { text: '上游调用失败', toolCalls: [] } : '上游调用失败'
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

function splitLongText(text, chunkSize = AI_REPLY_CHUNK_CHARS) {
  const normalized = String(text || '').replace(/\r/g, '').trim()
  if (!normalized) return []
  const chunks = []
  const paragraphs = normalized.split('\n')
  let current = ''
  for (const rawPart of paragraphs) {
    const part = String(rawPart || '')
    const candidate = current ? `${current}\n${part}` : part
    if (candidate.length <= chunkSize) {
      current = candidate
      continue
    }
    if (current) chunks.push(current)
    if (part.length <= chunkSize) {
      current = part
      continue
    }
    for (let i = 0; i < part.length; i += chunkSize) {
      chunks.push(part.slice(i, i + chunkSize))
    }
    current = ''
  }
  if (current) chunks.push(current)
  return chunks.filter(Boolean)
}

function truncateReplyText(text, maxChars = AI_REPLY_MAX_CHARS) {
  const normalized = String(text || '').replace(/\r/g, '').trim()
  if (!normalized) return ''
  if (normalized.length <= maxChars) return normalized
  const suffix = '\n\n[后续内容已截断]'
  const keep = Math.max(0, maxChars - suffix.length)
  return `${normalized.slice(0, keep)}${suffix}`
}

function buildReplySegments(messageId, content, options = {}) {
  const includeReply = options.includeReply !== false
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : AI_REPLY_MAX_CHARS
  const chunkSize = Number.isFinite(options.chunkSize) ? options.chunkSize : AI_REPLY_CHUNK_CHARS
  const safeText = truncateReplyText(content, maxChars)
  const chunks = splitLongText(safeText, chunkSize)
  if (chunks.length === 0) {
    return [[
      ...(includeReply ? [{ type: 'reply', data: { id: messageId } }] : []),
      { type: 'text', data: { text: '（空）' } }
    ]]
  }
  return chunks.map((chunk, index) => {
    if (includeReply && index === 0) {
      return [
        { type: 'reply', data: { id: messageId } },
        { type: 'text', data: { text: chunk } }
      ]
    }
    return [{ type: 'text', data: { text: chunk } }]
  })
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
      out.push({ kind, url, file: kv.file || '' })
    }
  }
  return out
}

async function resolveMediaSources(ws, media) {
  if (!Array.isArray(media) || media.length === 0) return []
  const out = []
  for (const item of media) {
    if (!item || item.kind !== 'image') {
      out.push(item)
      continue
    }
    let url = item.url || ''
    let localPath = item.localPath || ''
    const fileRef = item.file || ''
    if (!localPath && fileRef && !isDirectMediaSource(fileRef)) {
      const resp = await sendAction(ws, 'get_image', { file: fileRef }).catch(() => null)
      if (resp && resp.status === 'ok' && resp.data) {
        if (resp.data.file) localPath = String(resp.data.file)
        if (!url && resp.data.url) url = String(resp.data.url)
      }
    }
    out.push({ ...item, url, localPath })
  }
  return out
}

function isDirectMediaSource(src) {
  return /^https?:\/\//i.test(src) || /^file:\/\//i.test(src) || /^data:/i.test(src) || /^base64:\/\//i.test(src) || /^[\\/]/.test(src) || /^[a-zA-Z]:[\\/]/.test(src)
}

function isQqImageUrl(src) {
  try {
    const u = new URL(src)
    const host = u.hostname || ''
    return /qpic\.cn$/i.test(host) || /gchat\.qpic\.cn$/i.test(host) || /multimedia\.nt\.qq\.com$/i.test(host) || /multimedia\.nt\.qq\.com\.cn$/i.test(host)
  } catch {
    return false
  }
}

function detectMimeFromBuffer(buf, fallback = '') {
  if (!buf || buf.length < 4) return fallback || 'application/octet-stream'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  return fallback || 'application/octet-stream'
}

function detectMimeFromExt(filePath) {
  const ext = path.extname(filePath || '').toLowerCase()
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.png' ? 'image/png'
    : ext === '.gif' ? 'image/gif'
    : ext === '.webp' ? 'image/webp'
    : ext === '.mp3' ? 'audio/mpeg'
    : ext === '.wav' ? 'audio/wav'
    : ext === '.mp4' ? 'video/mp4'
    : 'application/octet-stream'
}

function isImageMime(mime) {
  return typeof mime === 'string' && /^image\//i.test(mime)
}

async function sourceToBuffer(src) {
  if (!src) return null
  let buf = null
  let mime = 'application/octet-stream'
  if (/^base64:\/\//i.test(src)) {
    buf = Buffer.from(src.replace(/^base64:\/\//i, ''), 'base64')
    mime = detectMimeFromBuffer(buf, mime)
  } else if (/^data:/i.test(src)) {
    const i = src.indexOf(',')
    if (i <= 0) return null
    const head = src.slice(0, i)
    const data = src.slice(i + 1)
    const mimeMatch = head.match(/^data:([^;]+)/i)
    mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream'
    buf = Buffer.from(data, 'base64')
  } else if (/^file:\/\//i.test(src)) {
    const p = decodeURIComponent(src.replace(/^file:\/\//i, ''))
    buf = fs.readFileSync(p)
    mime = detectMimeFromBuffer(buf, detectMimeFromExt(p))
  } else if (/^[\\/].+/.test(src) || /^[a-zA-Z]:[\\/]/.test(src)) {
    const p = decodeURIComponent(src)
    buf = fs.readFileSync(p)
    mime = detectMimeFromBuffer(buf, detectMimeFromExt(p))
  } else if (/^https?:\/\//i.test(src)) {
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
    buf = Buffer.from(res.data)
    const ct = (res.headers && res.headers['content-type']) || ''
    mime = detectMimeFromBuffer(buf, ct.split(';')[0] || 'application/octet-stream')
  } else {
    return null
  }
  return { buf, mime }
}

async function toOpenAIImageUrl(media) {
  if (!media) return ''
  const candidates = [media.localPath, media.file, media.url].filter(Boolean)
  for (const src of candidates) {
    if (!src) continue
    if (!/^https?:\/\//i.test(src) || isQqImageUrl(src)) {
      const file = await sourceToBase64(src)
      if (file && file.data && /^image\//i.test(file.mime)) return `data:${file.mime};base64,${file.data}`
    }
  }
  for (const src of candidates) {
    if (/^https?:\/\//i.test(src)) return src
  }
  return ''
}

async function sourceToBase64(src) {
  if (!src) return null
  try {
    const source = await sourceToBuffer(src)
    if (!source || !source.buf) return null
    return { mime: source.mime, data: source.buf.toString('base64') }
  } catch (e) {
    const status = e && e.response && e.response.status
    console.log('媒体下载失败', status || '')
    return null
  }
}
process.on('SIGINT', () => {
  try { wss.close() } catch {}
  process.exit(0)
})

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

function buildPokeReplyMessageSegments(item, headerText = '') {
  const normalizedItem = normalizePokeReplyItem(item)
  const segments = []
  if (headerText) segments.push({ type: 'text', data: { text: headerText } })
  if (!normalizedItem) {
    segments.push({ type: 'text', data: { text: '（空）' } })
    return segments
  }
  if (normalizedItem.type === 'image') {
    const file = toOutboundImageFile(normalizedItem.source)
    segments.push({ type: 'image', data: { file } })
    return segments
  }
  segments.push({ type: 'text', data: { text: normalizedItem.content } })
  return segments
}

async function buildPokeReplyMessageSegmentsAsync(item, headerText = '') {
  const normalizedItem = normalizePokeReplyItem(item)
  const segments = []
  if (headerText) segments.push({ type: 'text', data: { text: headerText } })
  if (!normalizedItem) {
    segments.push({ type: 'text', data: { text: '（空）' } })
    return segments
  }
  if (normalizedItem.type === 'image') {
    const base64 = await sourceToBase64(normalizedItem.source).catch(() => null)
    if (base64 && base64.data) {
      segments.push({ type: 'image', data: { file: `base64://${base64.data}` } })
      return segments
    }
    const file = toOutboundImageFile(normalizedItem.source)
    segments.push({ type: 'image', data: { file } })
    return segments
  }
  segments.push({ type: 'text', data: { text: normalizedItem.content } })
  return segments
}

async function replyCommandMessage(ws, payload, text) {
  const msg = Array.isArray(text) ? text : [{ type: 'text', data: { text } }]
  if (payload.message_type === 'group') {
    await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: msg }).catch(() => {})
  } else {
    await sendAction(ws, 'send_private_msg', { user_id: payload.user_id, message: msg }).catch(() => {})
  }
}

function normalizeCommandText(text) {
  return String(text || '')
    .replace(/^[\s,，.。!！?？:：;；/\\|+-]+/, '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^一拍一拍/, '拍一拍')
}

function compactCommandText(text) {
  return normalizeCommandText(text).replace(/\s+/g, '')
}

function buildPokeCommandHelp(isAdminUser) {
  const lines = [
    '拍一拍命令：',
    '1. 拍一拍 文案列表',
    '2. 拍一拍 文案查看 序号'
  ]
  if (isAdminUser) {
    lines.push('3. 拍一拍 文案添加 内容')
    lines.push('4. 拍一拍 图片添加 / 加图 / 添加图片')
    lines.push('5. 拍一拍 文案删除 序号')
    lines.push('6. 拍一拍 文案清空')
    lines.push('7. 拍一拍 文案去重')
    lines.push('8. 拍一拍 开启')
    lines.push('9. 拍一拍 关闭')
  } else {
    lines.push('其余文案管理和开关命令需要管理员权限')
  }
  return lines.join('\n')
}

async function handleCommands(ws, payload, text) {
  const rawCommandText = stripPrefix(text || '')
  const t = normalizeCommandText(rawCommandText)
  const nt = t.replace(/\s+/g, ' ')
  const compact = compactCommandText(t)
  const isBanned = /^(banned|违禁词|禁词|敏感词)|^(添加|删除|移除|增加|新增)\s*(违禁词|禁词|敏感词)/i.test(nt)
  const isContext = /^(context|上下文)/i.test(nt)
  const isPoke = /^(poke|拍一拍|一拍一拍|戳一戳)/i.test(nt) || /^(poke|拍一拍|一拍一拍|戳一戳)/i.test(compact)
  const matchedCommand = isBanned || isContext || isPoke
  if (!matchedCommand) return false
  try {
    const isGroup = payload.message_type === 'group'
    const roleUser = isGroup ? await getUserRole(ws, payload.group_id, payload.user_id).catch(() => 'member') : 'member'
    const isAdminUser = roleUser === 'owner' || roleUser === 'admin' || isConfiguredAdmin(payload.user_id)
    if (isContext) {
      if (/重置|清空|reset/i.test(nt)) {
        clearHistory(payload)
        await replyCommandMessage(ws, payload, '上下文已重置')
        return true
      }
      if (isAdminUser) {
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
        await replyCommandMessage(ws, payload, `上下文：开关=${process.env.AI_CONTEXT_ENABLE} 窗口=${process.env.AI_CONTEXT_WINDOW || AI_CONTEXT_WINDOW} 时长=${process.env.AI_CONTEXT_TTL || AI_CONTEXT_TTL}s`)
        return true
      }
      await replyCommandMessage(ws, payload, '需要管理员权限才能修改上下文配置')
      return true
    }
    if (isPoke) {
      const commandContent = extractContent(payload.message)
      const commandMedia = await resolveMediaSources(ws, commandContent.media)
      if (/(回复\s*列表|文案\s*列表|list)/i.test(nt) || /(回复列表|文案列表)/i.test(compact)) {
        const items = refreshPokeReplyTexts()
        const body = items.length > 0 ? items.map((s, i) => `${i + 1}. ${previewPokeReplyText(s)}`).join('\n') : '（空）'
        await replyCommandMessage(ws, payload, `拍一拍回复列表：\n${body}`)
        return true
      }
      const viewMatch = nt.match(/(?:回复|文案)\s*(?:查看|详情|明细)\s*(\d+)/i) || nt.match(/(?:view|show)\s+(\d+)/i)
      if (viewMatch) {
        const items = refreshPokeReplyTexts()
        const index = parseInt(viewMatch[1], 10)
        if (!Number.isInteger(index) || index < 1) {
          await replyCommandMessage(ws, payload, '请提供正确的文案编号，例如：拍一拍 文案查看 3')
          return true
        }
        if (index > items.length) {
          await replyCommandMessage(ws, payload, `未找到编号为 ${index} 的拍一拍文案，当前共 ${items.length} 条`)
          return true
        }
        const targetItem = normalizePokeReplyItem(items[index - 1])
        if (targetItem && targetItem.type === 'image') {
          await replyCommandMessage(ws, payload, `拍一拍文案 #${index}：[图片回复]`)
          await replyCommandMessage(ws, payload, await buildPokeReplyMessageSegmentsAsync(targetItem))
          return true
        }
        await replyCommandMessage(ws, payload, buildPokeReplyMessageSegments(targetItem, `拍一拍文案 #${index}：\n`))
        return true
      }
      const addMatch = nt.match(/(?:回复|文案)\s*(?:添加|增加|新增)\s+(.+)/i) || nt.match(/(?:add|replyadd)\s+(.+)/i)
      if (addMatch) {
        if (!isAdminUser) {
          await replyCommandMessage(ws, payload, '需要管理员权限才能添加拍一拍文案')
          return true
        }
        const rawAddMatch = String(rawCommandText || '').match(/(?:回复|文案)\s*(?:添加|增加|新增)\s+([\s\S]+)/i)
          || String(rawCommandText || '').match(/(?:add|replyadd)\s+([\s\S]+)/i)
        const content = String((rawAddMatch && rawAddMatch[1]) || addMatch[1] || '').trim()
        if (!content) {
          await replyCommandMessage(ws, payload, '请在命令后附带要添加的拍一拍文案')
          return true
        }
        const items = refreshPokeReplyTexts()
        if (items.includes(content)) {
          await replyCommandMessage(ws, payload, `该拍一拍文案已存在：${content}`)
          return true
        }
        const saved = savePokeReplyTexts(items.concat(content))
        await replyCommandMessage(ws, payload, `已添加拍一拍文案 #${saved.length}：${previewPokeReplyText(saved[saved.length - 1])}\n当前共 ${saved.length} 条`)
        return true
      }
      const imageAddMatch = nt.match(/(?:图片|图)\s*(?:添加|增加|新增)(?:\s+(.+))?/i)
        || nt.match(/(?:添加图片|加图|加图片)(?:\s+(.+))?/i)
        || nt.match(/(?:imageadd|imgadd|addimage)(?:\s+(.+))?/i)
      if (imageAddMatch) {
        if (!isAdminUser) {
          await replyCommandMessage(ws, payload, '需要管理员权限才能添加拍一拍图片回复')
          return true
        }
        let imageMedia = (commandMedia || []).find((item) => item && item.kind === 'image')
        if (!imageMedia && commandContent.replyId) {
          const replied = await sendAction(ws, 'get_msg', { message_id: commandContent.replyId }).catch(() => null)
          if (replied && replied.status === 'ok' && replied.data && replied.data.message) {
            const repliedContent = extractContent(replied.data.message)
            const repliedMedia = await resolveMediaSources(ws, repliedContent.media)
            imageMedia = (repliedMedia || []).find((item) => item && item.kind === 'image') || null
          }
        }
        const rawImageAddMatch = String(rawCommandText || '').match(/(?:图片|图)\s*(?:添加|增加|新增)\s+([\s\S]+)/i)
          || String(rawCommandText || '').match(/(?:添加图片|加图|加图片)\s+([\s\S]+)/i)
          || String(rawCommandText || '').match(/(?:imageadd|imgadd|addimage)\s+([\s\S]+)/i)
        const source = String(
          (imageMedia && pickPokeImageSource(imageMedia))
          || (rawImageAddMatch && rawImageAddMatch[1])
          || imageAddMatch[1]
          || ''
        ).trim()
        if (!source) {
          await replyCommandMessage(ws, payload, '请在命令消息中附带图片、引用一条带图片的消息，或在命令后提供图片地址/路径')
          return true
        }
        const item = normalizePokeReplyItem({ type: 'image', source })
        const items = refreshPokeReplyTexts()
        if (item && items.some((existing) => pokeReplySignature(existing) === pokeReplySignature(item))) {
          await replyCommandMessage(ws, payload, '该拍一拍图片回复已存在')
          return true
        }
        const saved = savePokeReplyTexts(items.concat(item))
        await replyCommandMessage(ws, payload, `已添加拍一拍图片回复 #${saved.length}：[图片回复]\n当前共 ${saved.length} 条`)
        return true
      }
      const removeMatch = nt.match(/(?:回复|文案)\s*(?:删除|移除|去除)\s*(\d+)/i) || nt.match(/(?:rm|remove|replyrm)\s+(\d+)/i)
      if (removeMatch) {
        if (!isAdminUser) {
          await replyCommandMessage(ws, payload, '需要管理员权限才能删除拍一拍文案')
          return true
        }
        const index = parseInt(removeMatch[1], 10)
        if (!Number.isInteger(index) || index < 1) {
          await replyCommandMessage(ws, payload, '请提供正确的文案编号，例如：拍一拍 文案删除 3')
          return true
        }
        const items = refreshPokeReplyTexts()
        if (index > items.length) {
          await replyCommandMessage(ws, payload, `未找到编号为 ${index} 的拍一拍文案，当前共 ${items.length} 条`)
          return true
        }
        const removed = items[index - 1]
        const nextItems = items.slice(0, index - 1).concat(items.slice(index))
        const saved = savePokeReplyTexts(nextItems)
        await replyCommandMessage(ws, payload, `已删除拍一拍文案 #${index}：${previewPokeReplyText(removed)}\n当前共 ${saved.length} 条`)
        return true
      }
      if (/(回复|文案).*(清空|重置)|(?:clear|empty|purge|reset)/i.test(nt) || /(回复清空|文案清空|回复重置|文案重置)/i.test(compact)) {
        if (!isAdminUser) {
          await replyCommandMessage(ws, payload, '需要管理员权限才能清空拍一拍文案')
          return true
        }
        savePokeReplyTexts([])
        await replyCommandMessage(ws, payload, '拍一拍文案已清空')
        return true
      }
      if (/(回复|文案).*(去重)|(?:dedupe|unique)/i.test(nt) || /(回复去重|文案去重)/i.test(compact)) {
        if (!isAdminUser) {
          await replyCommandMessage(ws, payload, '需要管理员权限才能去重拍一拍文案')
          return true
        }
        const items = refreshPokeReplyTexts()
        const saved = savePokeReplyTexts(dedupeTextList(items))
        const removedCount = items.length - saved.length
        await replyCommandMessage(ws, payload, `拍一拍文案已去重，移除 ${removedCount} 条重复项，当前共 ${saved.length} 条`)
        return true
      }
      if (isAdminUser) {
        if (/开启|打开|on/i.test(nt)) process.env.AI_POKE_ENABLE = 'true'
        if (/关闭|off/i.test(nt)) process.env.AI_POKE_ENABLE = 'false'
        await replyCommandMessage(ws, payload, `拍一拍开关：${process.env.AI_POKE_ENABLE}｜文案数=${getPokeReplyTexts().length}`)
        return true
      }
      if (/开启|打开|关闭|off|on/i.test(nt)) {
        await replyCommandMessage(ws, payload, '需要管理员权限才能管理拍一拍配置')
        return true
      }
      await replyCommandMessage(ws, payload, buildPokeCommandHelp(isAdminUser))
      return true
    }
    if (isBanned) {
      const list = loadBanned(payload.group_id)
      if (/列表|查看|list/i.test(nt)) {
        const msg = [{ type: 'text', data: { text: `违禁词列表：${list.join(',') || '（空）'}｜治理开关=${process.env.AI_MOD_ENABLE || AI_MOD_ENABLE}｜禁言时长=${process.env.AI_BAN_DURATION || AI_BAN_DURATION}s` } }]
        await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: msg }).catch(() => {})
        return true
      }
      if (!isAdminUser) {
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
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error)
    console.log('命令处理失败', nt, message)
    await replyCommandMessage(ws, payload, '命令处理失败，请稍后重试')
    return true
  }
  return false
}
