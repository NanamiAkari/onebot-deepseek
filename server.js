const { WebSocketServer } = require('ws')
const axios = require('axios')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const config = require('./src/config')
const { createSessionStore } = require('./src/session/store')
const { extractOpenAIText, extractOpenAIToolCalls, extractOpenAIImages, formatOpenAITools } = require('./src/providers/openai')
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
  OPENAI_IMAGE_TIMEOUT_MS,
  AI_REPLY_MAX_CHARS,
  AI_REPLY_CHUNK_CHARS,
  AI_POKE_ENABLE,
  AI_POKE_COOLDOWN,
  AI_POKE_REPLY_FILE,
  AI_CUSTOM_REPLY_FILE,
  AI_SCHEDULE_FILE,
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
const { pending, pokeCooldown, roleCache, mediaCache, customReplyDrafts, scheduleTaskDrafts, getKey, pushHistory, getHistoryRaw, needContext, getContext, clearHistory } = sessionStore
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

function getCustomReplyFilePath() {
  return resolveProjectFile(AI_CUSTOM_REPLY_FILE || 'custom_replies.json')
}

function getScheduleFilePath() {
  return resolveProjectFile(AI_SCHEDULE_FILE || 'scheduled_tasks.json')
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

function isTransientQqCachePath(source) {
  const value = String(source || '').trim().replace(/\\/g, '/')
  if (!value) return false
  return /\/\.config\/QQ\//i.test(value)
    || /\/nt_data\/Pic\//i.test(value)
    || /\/NapCat\/temp\//i.test(value)
}

function pickPokeImageSource(item) {
  if (!item || typeof item !== 'object') return ''
  const localPath = String(item.localPath || '').trim()
  const source = String(item.source || '').trim()
  const url = String(item.url || '').trim()
  if (localPath && !isTransientQqCachePath(localPath)) return localPath
  if (source && !isTransientQqCachePath(source)) return source
  if (url && !isQqImageUrl(url)) return url
  if (url) return url
  if (localPath) return localPath
  if (source) return source

  const file = String(item.file || '').trim()
  if (isDirectMediaSource(file)) return file
  return file
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

function normalizeCustomReplyTrigger(text) {
  return String(text || '').replace(/\r/g, '').trim()
}

function normalizeCustomReplySegment(segment) {
  if (!segment || typeof segment !== 'object') return null
  if (segment.type === 'text') {
    const text = String(segment.data && segment.data.text || segment.text || '').replace(/\r/g, '')
    return text ? { type: 'text', data: { text } } : null
  }
  if (segment.type === 'image') {
    const source = String(segment.source || (segment.data && (segment.data.source || segment.data.file || segment.data.url)) || '').trim()
    return source ? { type: 'image', source } : null
  }
  if (segment.type === 'face' || segment.type === 'emoji' || segment.type === 'mface') {
    return { type: segment.type, data: { ...(segment.data || {}) } }
  }
  return null
}

function normalizeCustomReplyEntry(entry) {
  const rawSegments = Array.isArray(entry) ? entry : (entry && Array.isArray(entry.segments) ? entry.segments : [])
  const segments = rawSegments.map(normalizeCustomReplySegment).filter(Boolean)
  return segments.length > 0 ? { segments } : null
}

function customReplyEntrySignature(entry) {
  const normalized = normalizeCustomReplyEntry(entry)
  return normalized ? JSON.stringify(normalized.segments) : ''
}

function previewCustomReplyEntry(entry) {
  const normalized = normalizeCustomReplyEntry(entry)
  if (!normalized) return '（空）'
  const parts = []
  for (const segment of normalized.segments) {
    if (segment.type === 'text') {
      const text = String(segment.data && segment.data.text || '').replace(/\s+/g, ' ').trim()
      if (text) parts.push(text)
    } else if (segment.type === 'image') {
      parts.push('[图片]')
    } else if (segment.type === 'face' || segment.type === 'emoji' || segment.type === 'mface') {
      parts.push('[表情]')
    }
  }
  const compact = parts.join(' ').trim() || '（空）'
  return compact.length > 60 ? `${compact.slice(0, 60)}...` : compact
}

function loadCustomReplyStore() {
  const filePath = getCustomReplyFilePath()
  try {
    if (!fs.existsSync(filePath)) return {}
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const store = {}
    for (const [groupId, groupValue] of Object.entries(parsed)) {
      if (!groupValue || typeof groupValue !== 'object' || Array.isArray(groupValue)) continue
      const groupStore = {}
      for (const [trigger, replies] of Object.entries(groupValue)) {
        const normalizedTrigger = normalizeCustomReplyTrigger(trigger)
        if (!normalizedTrigger) continue
        const normalizedReplies = (Array.isArray(replies) ? replies : [])
          .map(normalizeCustomReplyEntry)
          .filter(Boolean)
        if (normalizedReplies.length > 0) groupStore[normalizedTrigger] = normalizedReplies
      }
      if (Object.keys(groupStore).length > 0) store[String(groupId)] = groupStore
    }
    return store
  } catch {
    return {}
  }
}

function saveCustomReplyStore(store) {
  const filePath = getCustomReplyFilePath()
  const normalizedStore = {}
  for (const [groupId, groupValue] of Object.entries(store || {})) {
    if (!groupValue || typeof groupValue !== 'object' || Array.isArray(groupValue)) continue
    const groupStore = {}
    for (const [trigger, replies] of Object.entries(groupValue)) {
      const normalizedTrigger = normalizeCustomReplyTrigger(trigger)
      if (!normalizedTrigger) continue
      const normalizedReplies = (Array.isArray(replies) ? replies : [])
        .map(normalizeCustomReplyEntry)
        .filter(Boolean)
      if (normalizedReplies.length > 0) groupStore[normalizedTrigger] = normalizedReplies
    }
    if (Object.keys(groupStore).length > 0) normalizedStore[String(groupId)] = groupStore
  }
  fs.writeFileSync(filePath, `${JSON.stringify(normalizedStore, null, 2)}\n`, 'utf8')
  return normalizedStore
}

function listCustomReplyTriggers(groupId) {
  const store = loadCustomReplyStore()
  const groupStore = store[String(groupId)] || {}
  return Object.entries(groupStore).map(([trigger, replies]) => ({
    trigger,
    replies: Array.isArray(replies) ? replies : []
  }))
}

function getCustomReplyEntries(groupId, trigger) {
  const normalizedTrigger = normalizeCustomReplyTrigger(trigger)
  if (!normalizedTrigger) return []
  const store = loadCustomReplyStore()
  const groupStore = store[String(groupId)] || {}
  const replies = Array.isArray(groupStore[normalizedTrigger]) ? groupStore[normalizedTrigger] : []
  return replies.map(normalizeCustomReplyEntry).filter(Boolean)
}

function addCustomReply(groupId, trigger, entry) {
  const normalizedTrigger = normalizeCustomReplyTrigger(trigger)
  const normalizedEntry = normalizeCustomReplyEntry(entry)
  if (!normalizedTrigger || !normalizedEntry) return { ok: false, reason: 'invalid' }
  const store = loadCustomReplyStore()
  const groupKey = String(groupId || '')
  const groupStore = store[groupKey] && typeof store[groupKey] === 'object' ? store[groupKey] : {}
  const currentReplies = Array.isArray(groupStore[normalizedTrigger]) ? groupStore[normalizedTrigger].slice() : []
  const signature = customReplyEntrySignature(normalizedEntry)
  if (signature && currentReplies.some((item) => customReplyEntrySignature(item) === signature)) {
    return { ok: false, reason: 'duplicate', count: currentReplies.length }
  }
  currentReplies.push(normalizedEntry)
  groupStore[normalizedTrigger] = currentReplies
  store[groupKey] = groupStore
  saveCustomReplyStore(store)
  return { ok: true, count: currentReplies.length, totalTriggers: Object.keys(groupStore).length, entry: normalizedEntry }
}

function removeCustomReply(groupId, trigger) {
  const normalizedTrigger = normalizeCustomReplyTrigger(trigger)
  if (!normalizedTrigger) return { ok: false }
  const store = loadCustomReplyStore()
  const groupKey = String(groupId || '')
  const groupStore = store[groupKey]
  if (!groupStore || !groupStore[normalizedTrigger]) return { ok: false }
  const removed = groupStore[normalizedTrigger]
  delete groupStore[normalizedTrigger]
  if (Object.keys(groupStore).length === 0) delete store[groupKey]
  else store[groupKey] = groupStore
  saveCustomReplyStore(store)
  return { ok: true, removedCount: Array.isArray(removed) ? removed.length : 0 }
}

function removeCustomReplyEntry(groupId, trigger, index) {
  const normalizedTrigger = normalizeCustomReplyTrigger(trigger)
  if (!normalizedTrigger || !Number.isInteger(index) || index < 1) return { ok: false, reason: 'invalid' }
  const store = loadCustomReplyStore()
  const groupKey = String(groupId || '')
  const groupStore = store[groupKey]
  const replies = groupStore && Array.isArray(groupStore[normalizedTrigger]) ? groupStore[normalizedTrigger].slice() : null
  if (!replies || index > replies.length) return { ok: false, reason: 'missing' }
  const removed = normalizeCustomReplyEntry(replies[index - 1])
  replies.splice(index - 1, 1)
  if (replies.length === 0) delete groupStore[normalizedTrigger]
  else groupStore[normalizedTrigger] = replies
  if (Object.keys(groupStore).length === 0) delete store[groupKey]
  else store[groupKey] = groupStore
  saveCustomReplyStore(store)
  return { ok: true, removed, remainingCount: replies.length }
}

function clearCustomReplies(groupId) {
  const store = loadCustomReplyStore()
  const groupKey = String(groupId || '')
  const groupStore = store[groupKey]
  if (!groupStore || typeof groupStore !== 'object') return { ok: false, removedTriggers: 0, removedReplies: 0 }
  const removedTriggers = Object.keys(groupStore).length
  const removedReplies = Object.values(groupStore).reduce((sum, replies) => sum + (Array.isArray(replies) ? replies.length : 0), 0)
  delete store[groupKey]
  saveCustomReplyStore(store)
  return { ok: true, removedTriggers, removedReplies }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function normalizeWeeklyDay(value) {
  const key = String(value || '').trim()
  if (key === '1' || key === '一') return 1
  if (key === '2' || key === '二') return 2
  if (key === '3' || key === '三') return 3
  if (key === '4' || key === '四') return 4
  if (key === '5' || key === '五') return 5
  if (key === '6' || key === '六') return 6
  if (key === '7' || key === '日' || key === '天') return 0
  return null
}

function formatWeeklyDay(weekday) {
  return weekday === 0 ? '日' : weekday === 1 ? '一' : weekday === 2 ? '二' : weekday === 3 ? '三' : weekday === 4 ? '四' : weekday === 5 ? '五' : weekday === 6 ? '六' : '?'
}

function parseScheduleSpec(input) {
  const text = String(input || '').trim()
  if (!text) return null
  const dailyMatch = text.match(/^(?:每天|每日)\s*(\d{1,2}):(\d{2})$/)
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10)
    const minute = parseInt(dailyMatch[2], 10)
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return {
      mode: 'daily',
      hour,
      minute,
      specText: `每天 ${pad2(hour)}:${pad2(minute)}`
    }
  }
  const weeklyMatch = text.match(/^(?:每周|每星期)\s*([一二三四五六日天1-7])\s*(\d{1,2}):(\d{2})$/)
  if (weeklyMatch) {
    const weekday = normalizeWeeklyDay(weeklyMatch[1])
    const hour = parseInt(weeklyMatch[2], 10)
    const minute = parseInt(weeklyMatch[3], 10)
    if (weekday === null || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return {
      mode: 'weekly',
      weekday,
      hour,
      minute,
      specText: `每周${formatWeeklyDay(weekday)} ${pad2(hour)}:${pad2(minute)}`
    }
  }
  const monthlyMatch = text.match(/^每月\s*(\d{1,2})(?:号|日)\s*(\d{1,2}):(\d{2})$/)
  if (monthlyMatch) {
    const day = parseInt(monthlyMatch[1], 10)
    const hour = parseInt(monthlyMatch[2], 10)
    const minute = parseInt(monthlyMatch[3], 10)
    if (day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return {
      mode: 'monthly',
      day,
      hour,
      minute,
      specText: `每月 ${day}号 ${pad2(hour)}:${pad2(minute)}`
    }
  }
  const onceMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/)
  if (!onceMatch) return null
  const year = parseInt(onceMatch[1], 10)
  const month = parseInt(onceMatch[2], 10)
  const day = parseInt(onceMatch[3], 10)
  const hour = parseInt(onceMatch[4], 10)
  const minute = parseInt(onceMatch[5], 10)
  const runAt = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (runAt.getFullYear() !== year || runAt.getMonth() !== month - 1 || runAt.getDate() !== day || hour > 23 || minute > 59) return null
  return {
    mode: 'once',
    runAt: runAt.getTime(),
    specText: `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`
  }
}

function computeDailyNextRunAt(hour, minute, nowTs = Date.now()) {
  const now = new Date(nowTs)
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
  if (target.getTime() <= nowTs + 1000) target.setDate(target.getDate() + 1)
  return target.getTime()
}

function computeWeeklyNextRunAt(weekday, hour, minute, nowTs = Date.now()) {
  const now = new Date(nowTs)
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
  let offset = weekday - now.getDay()
  if (offset < 0 || (offset === 0 && target.getTime() <= nowTs + 1000)) offset += 7
  target.setDate(target.getDate() + offset)
  return target.getTime()
}

function buildMonthlyCandidate(year, monthIndex, day, hour, minute) {
  const target = new Date(year, monthIndex, day, hour, minute, 0, 0)
  if (target.getFullYear() !== year || target.getMonth() !== monthIndex || target.getDate() !== day) return null
  return target
}

function computeMonthlyNextRunAt(day, hour, minute, nowTs = Date.now()) {
  const now = new Date(nowTs)
  for (let offset = 0; offset < 24; offset += 1) {
    const year = now.getFullYear() + Math.floor((now.getMonth() + offset) / 12)
    const monthIndex = (now.getMonth() + offset) % 12
    const candidate = buildMonthlyCandidate(year, monthIndex, day, hour, minute)
    if (!candidate) continue
    if (candidate.getTime() > nowTs + 1000) return candidate.getTime()
  }
  return 0
}

function formatScheduleTime(ts) {
  const date = new Date(Number(ts || 0))
  if (!Number.isFinite(date.getTime())) return '未知时间'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function normalizeScheduledTask(task) {
  if (!task || typeof task !== 'object') return null
  const id = String(task.id || '').trim() || crypto.randomBytes(8).toString('hex')
  const groupId = String(task.groupId || '').trim()
  const mode = task.mode === 'once' ? 'once'
    : task.mode === 'daily' ? 'daily'
    : task.mode === 'weekly' ? 'weekly'
    : task.mode === 'monthly' ? 'monthly'
    : ''
  const content = normalizeCustomReplyEntry(task.content || task.entry)
  if (!groupId || !mode || !content) return null
  if (mode === 'daily') {
    const hour = parseInt(task.hour, 10)
    const minute = parseInt(task.minute, 10)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null
    const nextRunAt = Number.isFinite(Number(task.nextRunAt)) && Number(task.nextRunAt) > Date.now() - 60000
      ? Number(task.nextRunAt)
      : computeDailyNextRunAt(hour, minute)
    return {
      id,
      groupId,
      mode,
      hour,
      minute,
      specText: `每天 ${pad2(hour)}:${pad2(minute)}`,
      nextRunAt,
      createdAt: Number(task.createdAt || Date.now()),
      createdBy: String(task.createdBy || ''),
      lastRunAt: Number(task.lastRunAt || 0),
      content
    }
  }
  if (mode === 'weekly') {
    const weekday = parseInt(task.weekday, 10)
    const hour = parseInt(task.hour, 10)
    const minute = parseInt(task.minute, 10)
    if (![0, 1, 2, 3, 4, 5, 6].includes(weekday) || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null
    const nextRunAt = Number.isFinite(Number(task.nextRunAt)) && Number(task.nextRunAt) > Date.now() - 60000
      ? Number(task.nextRunAt)
      : computeWeeklyNextRunAt(weekday, hour, minute)
    return {
      id,
      groupId,
      mode,
      weekday,
      hour,
      minute,
      specText: `每周${formatWeeklyDay(weekday)} ${pad2(hour)}:${pad2(minute)}`,
      nextRunAt,
      createdAt: Number(task.createdAt || Date.now()),
      createdBy: String(task.createdBy || ''),
      lastRunAt: Number(task.lastRunAt || 0),
      content
    }
  }
  if (mode === 'monthly') {
    const day = parseInt(task.day, 10)
    const hour = parseInt(task.hour, 10)
    const minute = parseInt(task.minute, 10)
    if (!Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null
    const nextRunAt = Number.isFinite(Number(task.nextRunAt)) && Number(task.nextRunAt) > Date.now() - 60000
      ? Number(task.nextRunAt)
      : computeMonthlyNextRunAt(day, hour, minute)
    if (!nextRunAt) return null
    return {
      id,
      groupId,
      mode,
      day,
      hour,
      minute,
      specText: `每月 ${day}号 ${pad2(hour)}:${pad2(minute)}`,
      nextRunAt,
      createdAt: Number(task.createdAt || Date.now()),
      createdBy: String(task.createdBy || ''),
      lastRunAt: Number(task.lastRunAt || 0),
      content
    }
  }
  const runAt = Number(task.runAt)
  if (!Number.isFinite(runAt) || runAt <= 0) return null
  return {
    id,
    groupId,
    mode,
    runAt,
    specText: String(task.specText || formatScheduleTime(runAt)),
    nextRunAt: Number.isFinite(Number(task.nextRunAt)) ? Number(task.nextRunAt) : runAt,
    createdAt: Number(task.createdAt || Date.now()),
    createdBy: String(task.createdBy || ''),
    lastRunAt: Number(task.lastRunAt || 0),
    content
  }
}

function loadScheduledTaskStore() {
  const filePath = getScheduleFilePath()
  try {
    if (!fs.existsSync(filePath)) return {}
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [groupId, tasks] of Object.entries(parsed)) {
      const normalizedTasks = (Array.isArray(tasks) ? tasks : [])
        .map(normalizeScheduledTask)
        .filter(Boolean)
        .filter((task) => task.mode === 'daily' || task.mode === 'weekly' || task.mode === 'monthly' || task.nextRunAt > Date.now() - 60000)
      if (normalizedTasks.length > 0) out[String(groupId)] = normalizedTasks
    }
    return out
  } catch {
    return {}
  }
}

function saveScheduledTaskStore(store) {
  const filePath = getScheduleFilePath()
  const normalizedStore = {}
  for (const [groupId, tasks] of Object.entries(store || {})) {
    const normalizedTasks = (Array.isArray(tasks) ? tasks : [])
      .map(normalizeScheduledTask)
      .filter(Boolean)
    if (normalizedTasks.length > 0) normalizedStore[String(groupId)] = normalizedTasks
  }
  fs.writeFileSync(filePath, `${JSON.stringify(normalizedStore, null, 2)}\n`, 'utf8')
  return normalizedStore
}

function listScheduledTasks(groupId) {
  const store = loadScheduledTaskStore()
  return ((store[String(groupId)] || []).slice()).sort((a, b) => a.nextRunAt - b.nextRunAt)
}

function addScheduledTask(groupId, scheduleSpec, entry, createdBy) {
  const parsed = typeof scheduleSpec === 'string' ? parseScheduleSpec(scheduleSpec) : scheduleSpec
  const content = normalizeCustomReplyEntry(entry)
  if (!parsed || !content) return { ok: false, reason: 'invalid' }
  if (parsed.mode === 'once' && parsed.runAt <= Date.now()) return { ok: false, reason: 'past' }
  const task = normalizeScheduledTask({
    id: crypto.randomBytes(8).toString('hex'),
    groupId: String(groupId || ''),
    mode: parsed.mode,
    weekday: parsed.weekday,
    day: parsed.day,
    hour: parsed.hour,
    minute: parsed.minute,
    runAt: parsed.runAt,
    specText: parsed.specText,
    nextRunAt: parsed.mode === 'daily' ? computeDailyNextRunAt(parsed.hour, parsed.minute)
      : parsed.mode === 'weekly' ? computeWeeklyNextRunAt(parsed.weekday, parsed.hour, parsed.minute)
      : parsed.mode === 'monthly' ? computeMonthlyNextRunAt(parsed.day, parsed.hour, parsed.minute)
      : parsed.runAt,
    createdAt: Date.now(),
    createdBy: String(createdBy || ''),
    content
  })
  if (!task) return { ok: false, reason: 'invalid' }
  const store = loadScheduledTaskStore()
  const groupKey = String(groupId || '')
  const current = Array.isArray(store[groupKey]) ? store[groupKey].slice() : []
  current.push(task)
  store[groupKey] = current
  saveScheduledTaskStore(store)
  return { ok: true, task, count: current.length }
}

function removeScheduledTask(groupId, index) {
  const store = loadScheduledTaskStore()
  const groupKey = String(groupId || '')
  const tasks = ((store[groupKey] || []).slice()).sort((a, b) => a.nextRunAt - b.nextRunAt)
  if (!Number.isInteger(index) || index < 1 || index > tasks.length) return { ok: false }
  const removed = tasks[index - 1]
  const remaining = tasks.filter((task) => task.id !== removed.id)
  if (remaining.length > 0) store[groupKey] = remaining
  else delete store[groupKey]
  saveScheduledTaskStore(store)
  return { ok: true, removed, count: remaining.length }
}

function clearScheduledTasks(groupId) {
  const store = loadScheduledTaskStore()
  const groupKey = String(groupId || '')
  const tasks = Array.isArray(store[groupKey]) ? store[groupKey] : []
  if (tasks.length === 0) return { ok: false, removedCount: 0 }
  delete store[groupKey]
  saveScheduledTaskStore(store)
  return { ok: true, removedCount: tasks.length }
}

function previewScheduledTask(task) {
  if (!task) return '（空）'
  return `${task.specText || formatScheduleTime(task.nextRunAt)} | ${previewCustomReplyEntry(task.content)}`
}

async function sendScheduledTaskMessage(ws, task) {
  const variants = await buildCustomReplyMessageVariants(task.content)
  for (const msg of variants) {
    const result = await sendAction(ws, 'send_group_msg', { group_id: Number(task.groupId), message: msg }).catch(() => null)
    if (result && result.status === 'ok') return true
  }
  return false
}

let activeWsClient = null
let scheduledTaskRunnerBusy = false

function isWsClientReady(ws) {
  return Boolean(ws && ws.readyState === 1)
}

async function runScheduledTasksTick() {
  if (scheduledTaskRunnerBusy || !isWsClientReady(activeWsClient)) return
  scheduledTaskRunnerBusy = true
  try {
    const now = Date.now()
    const store = loadScheduledTaskStore()
    let changed = false
    for (const [groupId, tasks] of Object.entries(store)) {
      const nextTasks = []
      for (const task of Array.isArray(tasks) ? tasks : []) {
        const normalized = normalizeScheduledTask(task)
        if (!normalized) {
          changed = true
          continue
        }
        if (normalized.nextRunAt > now + 1000) {
          nextTasks.push(normalized)
          continue
        }
        const sent = await sendScheduledTaskMessage(activeWsClient, normalized).catch(() => false)
        if (normalized.mode === 'daily') {
          normalized.lastRunAt = now
          normalized.nextRunAt = computeDailyNextRunAt(normalized.hour, normalized.minute, now + 1000)
          nextTasks.push(normalized)
          changed = true
          if (!sent) console.log(`定时任务发送失败，将保留任务 group=${groupId} id=${normalized.id}`)
          continue
        }
        if (normalized.mode === 'weekly') {
          normalized.lastRunAt = now
          normalized.nextRunAt = computeWeeklyNextRunAt(normalized.weekday, normalized.hour, normalized.minute, now + 1000)
          nextTasks.push(normalized)
          changed = true
          if (!sent) console.log(`定时任务发送失败，将保留任务 group=${groupId} id=${normalized.id}`)
          continue
        }
        if (normalized.mode === 'monthly') {
          normalized.lastRunAt = now
          normalized.nextRunAt = computeMonthlyNextRunAt(normalized.day, normalized.hour, normalized.minute, now + 1000)
          if (normalized.nextRunAt) nextTasks.push(normalized)
          changed = true
          if (!sent) console.log(`定时任务发送失败，将保留任务 group=${groupId} id=${normalized.id}`)
          continue
        }
        changed = true
        if (!sent) console.log(`一次性定时任务发送失败，仍按已执行移除 group=${groupId} id=${normalized.id}`)
      }
      if (nextTasks.length > 0) store[groupId] = nextTasks
      else delete store[groupId]
    }
    if (changed) saveScheduledTaskStore(store)
  } finally {
    scheduledTaskRunnerBusy = false
  }
}

setInterval(() => {
  runScheduledTasksTick().catch((err) => console.log('runScheduledTasksTick', err && err.stack ? err.stack : err))
}, 15000)

function findCustomReplyMatches(groupId, text) {
  const normalizedText = normalizeCustomReplyTrigger(text)
  if (!normalizedText) return []
  const store = loadCustomReplyStore()
  const groupStore = store[String(groupId)] || {}
  return Object.entries(groupStore)
    .filter(([trigger, replies]) => trigger && normalizedText.includes(trigger) && Array.isArray(replies) && replies.length > 0)
    .sort((a, b) => b[0].length - a[0].length)
}

function pickCustomReply(groupId, text) {
  const matches = findCustomReplyMatches(groupId, text)
  if (matches.length === 0) return null
  const [, replies] = matches[0]
  if (replies.length === 0) return null
  return normalizeCustomReplyEntry(replies[Math.floor(Math.random() * replies.length)])
}

function hasCustomReplyTrigger(groupId, text) {
  return findCustomReplyMatches(groupId, text).length > 0
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
  handleImageGenerationRequest,
  handleScheduleTaskDraftInput,
  handleCustomReplyDraftInput,
  handleCustomReplyMatch,
  hasCustomReplyTrigger,
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
  AI_IMAGE_CONTEXT_REQUIRE_SAME_USER,
  AI_IMAGE_CONTEXT_MAX,
  AI_IMAGE_ONLY_NO_CALL
})

wss.on('connection', (ws) => {
  activeWsClient = ws
  ws.on('message', (data) => onMessage(ws, data))
  ws.on('close', () => {
    if (activeWsClient === ws) {
      const nextClient = Array.from(wss.clients || []).find((client) => client && client.readyState === 1 && client !== ws) || null
      activeWsClient = nextClient
    }
  })
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
  t = t.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, _lang, body) => `${body}\n`)
  t = t.replace(/`([^`]*)`/g, '$1')
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s*([-*+]|(\d+[\.\)]))\s+/gm, '')
  t = t.replace(/\*\*([\s\S]*?)\*\*/g, '$1')
  t = t.replace(/\*([\s\S]*?)\*/g, '$1')
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, '\n$1\n')
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, '\n$1\n')
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, '$1')
  t = t.replace(/\\begin\{([^}]+)\}([\s\S]*?)\\end\{\1\}/g, '\n$2\n')
  t = t.replace(/<[^>]+>/g, ' ')
  t = t.replace(/[ \t]{2,}/g, ' ')
  t = t.replace(/[ \t]+\n/g, '\n')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
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
  const requestTimeout = opts && Number.isFinite(opts.timeoutMs)
    ? opts.timeoutMs
    : imageCount > 0
    ? Math.max(OPENAI_TIMEOUT_MS, 60000)
    : OPENAI_TIMEOUT_MS
  try {
    const useResponses = OPENAI_WIRE_API === 'responses' || /ark\.cn-beijing\.volces\.com\/api\/v3$/i.test(OPENAI_BASE_URL)
    console.log(`调用OpenAI timeout=${requestTimeout}ms api=${useResponses ? 'responses' : 'chat'} image=${Boolean(opts && opts.generateImage)}`)
    const url = useResponses ? `${OPENAI_BASE_URL}/responses` : `${OPENAI_BASE_URL}/chat/completions`
    const wantsImageGeneration = Boolean(opts && opts.generateImage)
    if (wantsImageGeneration && !useResponses) {
      return opts && opts.structured ? { text: '当前上游接口不支持 Responses 生图工具', toolCalls: [], images: [] } : '当前上游接口不支持 Responses 生图工具'
    }
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
    if (wantsImageGeneration && useResponses) tools.push({ type: 'image_generation' })
    const responseInput = []
    if (useResponses && Array.isArray(hist) && hist.length > 0) {
      for (const h of hist) {
        const role = h && h.role === 'assistant' ? 'assistant' : 'user'
        const contentText = String(h && h.content || '').trim()
        if (!contentText) continue
        responseInput.push({ role, content: contentText })
      }
    }
    if (useResponses) responseInput.push({ role: 'user', content })
    const buildPayload = (includeTools) => useResponses
      ? {
          model: OPENAI_MODEL,
          instructions: SYSTEM_PROMPT,
          input: responseInput,
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
    const images = extractOpenAIImages(res.data)
    if (!contentText && toolCalls.length === 0 && images.length === 0) return null
    console.log('OpenAI成功')
    const txt = String(contentText || '').slice(0, 2000)
    if (txt && Array.isArray(effectiveMedia) && effectiveMedia.length > 0) {
      const ignoreHints = /(未提供(对应)?图片|无法识别到你提供的图片|暂时无法解答|请你补充相关信息)/i
      if (ignoreHints.test(txt)) {
        const again = await callGemini(text, effectiveMedia, opts)
        if (again) return { text: String(again).slice(0, 2000), toolCalls }
      }
    }
    return { text: txt, toolCalls, images }
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
    if (status === 429) return opts && opts.structured ? { text: '上游限流，请稍后再试', toolCalls: [], images: [] } : '上游限流，请稍后再试'
    if (status === 401) return opts && opts.structured ? { text: '上游鉴权失败，请检查 API Key', toolCalls: [], images: [] } : '上游鉴权失败，请检查 API Key'
    if (status === 502 || status === 503 || status === 504) return opts && opts.structured ? { text: '上游网关异常（5xx），请稍后再试', toolCalls: [], images: [] } : '上游网关异常（5xx），请稍后再试'
    if (errorMessage && /timeout/i.test(errorMessage)) return opts && opts.structured ? { text: '图片分析超时，请稍后重试或发送更小的图片', toolCalls: [], images: [] } : '图片分析超时，请稍后重试或发送更小的图片'
    return opts && opts.structured ? { text: '上游调用失败', toolCalls: [], images: [] } : '上游调用失败'
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

function detectImageExtFromMime(mime) {
  const normalized = String(mime || '').toLowerCase()
  return normalized === 'image/jpeg' ? '.jpg'
    : normalized === 'image/png' ? '.png'
    : normalized === 'image/gif' ? '.gif'
    : normalized === 'image/webp' ? '.webp'
    : '.img'
}

function isImageMime(mime) {
  return typeof mime === 'string' && /^image\//i.test(mime)
}

function shouldGenerateImage(text) {
  const value = String(text || '').trim()
  if (!value) return false
  return /(文生图|生图|出图|画图|绘图|作图|画一张|生成一张|做一张图|生成图片|生成图像)/i.test(value)
    || /(生成|画|绘制|做|来|给我|帮我).{0,80}(图|图片|图像|配图|插图|壁纸|头像|表情包|动漫风|二次元|插画)/i.test(value)
}

function saveGeneratedImage(base64Data, mime = 'image/png') {
  const normalized = String(base64Data || '').trim()
  if (!normalized) return ''
  const buffer = Buffer.from(normalized, 'base64')
  if (!buffer.length) return ''
  const fileMime = isImageMime(mime) ? mime : detectMimeFromBuffer(buffer, 'image/png')
  const dir = path.join(PROJECT_ROOT, 'generated_images')
  fs.mkdirSync(dir, { recursive: true })
  const hash = crypto.createHash('sha1').update(buffer).digest('hex')
  const ext = detectImageExtFromMime(fileMime)
  const filePath = path.join(dir, `${hash}${ext}`)
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer)
  return filePath
}

function isLocalFileSource(src) {
  const value = String(src || '').trim()
  return /^file:\/\//i.test(value) || /^[\\/]/.test(value) || /^[a-zA-Z]:[\\/]/.test(value)
}

async function persistPokeImageSource(source) {
  const value = String(source || '').trim()
  if (!value) return ''

  const ownedDir = path.join(PROJECT_ROOT, 'poke_media')
  const normalizedOwnedDir = path.resolve(ownedDir)
  if (isLocalFileSource(value)) {
    try {
      const localPath = /^file:\/\//i.test(value)
        ? decodeURIComponent(value.replace(/^file:\/\//i, ''))
        : value
      const normalizedLocalPath = path.resolve(localPath)
      if (normalizedLocalPath.startsWith(normalizedOwnedDir) && fs.existsSync(normalizedLocalPath)) return normalizedLocalPath
    } catch {}
  }

  const downloaded = await sourceToBuffer(value).catch(() => null)
  if (!downloaded || !downloaded.buf || !isImageMime(downloaded.mime)) return value

  fs.mkdirSync(ownedDir, { recursive: true })
  const hash = crypto.createHash('sha1').update(downloaded.buf).digest('hex')
  const ext = detectImageExtFromMime(downloaded.mime)
  const filePath = path.join(ownedDir, `${hash}${ext}`)
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, downloaded.buf)
  return filePath
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

async function captureCustomReplySegments(ws, message) {
  const segments = []
  if (typeof message === 'string') {
    const text = String(message || '').replace(/\r/g, '')
    if (text.trim()) segments.push({ type: 'text', data: { text } })
    return segments
  }
  if (!Array.isArray(message)) return segments
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'text') {
      const text = String(seg.data && seg.data.text || '').replace(/\r/g, '')
      if (text) segments.push({ type: 'text', data: { text } })
      continue
    }
    if (seg.type === 'image' && seg.data) {
      let source = pickPokeImageSource(seg.data)
      const fileRef = seg.data.file || ''
      if ((!source || !isDirectMediaSource(source)) && fileRef && !isDirectMediaSource(fileRef)) {
        const resp = await sendAction(ws, 'get_image', { file: fileRef }).catch(() => null)
        if (resp && resp.status === 'ok' && resp.data) {
          source = pickPokeImageSource({ ...resp.data, file: fileRef })
        }
      }
      const persistedSource = await persistPokeImageSource(source).catch(() => source)
      const normalized = normalizeCustomReplySegment({ type: 'image', source: persistedSource || source })
      if (normalized) segments.push(normalized)
      continue
    }
    if (seg.type === 'face' || seg.type === 'emoji' || seg.type === 'mface') {
      const normalized = normalizeCustomReplySegment({ type: seg.type, data: { ...(seg.data || {}) } })
      if (normalized) segments.push(normalized)
    }
  }
  return segments
}

async function buildImageMessageVariants(source) {
  const actualSource = await persistPokeImageSource(source).catch(() => source)
  const variants = []
  const seen = new Set()
  const pushVariant = (segment) => {
    const key = JSON.stringify(segment)
    if (seen.has(key)) return
    seen.add(key)
    variants.push(segment)
  }
  if (isLocalFileSource(actualSource)) {
    const file = toOutboundImageFile(actualSource)
    if (file) pushVariant({ type: 'image', data: { file } })
  }
  const base64 = await sourceToBase64(actualSource).catch(() => null)
  if (base64 && base64.data) pushVariant({ type: 'image', data: { file: `base64://${base64.data}` } })
  const file = toOutboundImageFile(actualSource)
  if (file) pushVariant({ type: 'image', data: { file } })
  return variants
}

function combineCustomReplyVariants(variantSets, limit = 8) {
  let combined = [[]]
  for (const variants of variantSets) {
    const next = []
    for (const current of combined) {
      for (const variant of variants) {
        next.push(current.concat([variant]))
        if (next.length >= limit) break
      }
      if (next.length >= limit) break
    }
    combined = next
    if (combined.length >= limit) break
  }
  return combined
}

async function buildCustomReplyMessageVariants(entry, headerText = '') {
  const normalized = normalizeCustomReplyEntry(entry)
  const prefix = headerText ? [{ type: 'text', data: { text: headerText } }] : []
  if (!normalized) return [prefix.concat([{ type: 'text', data: { text: '（空）' } }])]
  const variantSets = []
  for (const segment of normalized.segments) {
    if (segment.type === 'image') {
      const variants = await buildImageMessageVariants(segment.source)
      if (variants.length > 0) variantSets.push(variants)
      continue
    }
    variantSets.push([segment])
  }
  if (variantSets.length === 0) return [prefix.concat([{ type: 'text', data: { text: '（空）' } }])]
  return combineCustomReplyVariants(variantSets).map((segments) => prefix.concat(segments))
}

function getCustomReplyDraftKey(payload) {
  return `g:${payload.group_id || ''}:u:${payload.user_id || ''}`
}

const CUSTOM_REPLY_DRAFT_TTL_MS = 10 * 60 * 1000

function createCustomReplyDraft(stage, extra = {}) {
  return {
    stage,
    ...extra,
    updatedAt: Date.now(),
    expiresAt: Date.now() + CUSTOM_REPLY_DRAFT_TTL_MS
  }
}

function isCustomReplyDraftExpired(draft) {
  if (!draft || typeof draft !== 'object') return true
  return Number(draft.expiresAt || 0) > 0 && Date.now() > Number(draft.expiresAt || 0)
}

function purgeExpiredCustomReplyDrafts() {
  for (const [key, draft] of customReplyDrafts.entries()) {
    if (isCustomReplyDraftExpired(draft)) customReplyDrafts.delete(key)
  }
}

async function handleCustomReplyDraftInput(ws, payload) {
  if (!payload || payload.message_type !== 'group') return false
  purgeExpiredCustomReplyDrafts()
  const draftKey = getCustomReplyDraftKey(payload)
  const draft = customReplyDrafts.get(draftKey)
  if (!draft) return false
  if (isCustomReplyDraftExpired(draft)) {
    customReplyDrafts.delete(draftKey)
    await replyCommandMessage(ws, payload, '创建自定义回复已超时，请重新发送“阿卡林 创建自定义回复”开始')
    return true
  }
  const content = extractContent(payload.message)
  const triggerText = normalizeCustomReplyTrigger(content.text)
  if (triggerText === '取消') {
    customReplyDrafts.delete(draftKey)
    await replyCommandMessage(ws, payload, '已取消创建自定义回复')
    return true
  }
  if (draft.stage === 'await_trigger') {
    if (!triggerText) {
      customReplyDrafts.set(draftKey, createCustomReplyDraft('await_trigger'))
      await replyCommandMessage(ws, payload, '请输入要被触发的文本内容，例如：测试')
      return true
    }
    customReplyDrafts.set(draftKey, createCustomReplyDraft('await_reply', { trigger: triggerText }))
    await replyCommandMessage(ws, payload, `已记录被回复内容：${triggerText}\n请发送回复内容，可包含文本、图片、表情等；发送“取消”可退出`)
    return true
  }
  if (draft.stage === 'await_reply') {
    const replySegments = await captureCustomReplySegments(ws, payload.message)
    if (replySegments.length === 0) {
      customReplyDrafts.set(draftKey, createCustomReplyDraft('await_reply', { trigger: draft.trigger }))
      await replyCommandMessage(ws, payload, '未识别到可保存的回复内容，请发送文本、图片或表情，或发送“取消”退出')
      return true
    }
    const added = addCustomReply(payload.group_id, draft.trigger, { segments: replySegments })
    customReplyDrafts.delete(draftKey)
    if (!added.ok && added.reason === 'duplicate') {
      await replyCommandMessage(ws, payload, `该自定义回复已存在：${draft.trigger} => ${previewCustomReplyEntry({ segments: replySegments })}`)
      return true
    }
    await replyCommandMessage(ws, payload, `已创建自定义回复：${draft.trigger} => ${previewCustomReplyEntry(added.entry)}\n当前该关键词共有 ${added.count} 条回复`)
    return true
  }
  customReplyDrafts.delete(draftKey)
  return false
}

function getScheduleTaskDraftKey(payload) {
  return `g:${payload.group_id || ''}:u:${payload.user_id || ''}`
}

const SCHEDULE_TASK_DRAFT_TTL_MS = 10 * 60 * 1000

function createScheduleTaskDraft(stage, extra = {}) {
  return {
    stage,
    ...extra,
    updatedAt: Date.now(),
    expiresAt: Date.now() + SCHEDULE_TASK_DRAFT_TTL_MS
  }
}

function isScheduleTaskDraftExpired(draft) {
  if (!draft || typeof draft !== 'object') return true
  return Number(draft.expiresAt || 0) > 0 && Date.now() > Number(draft.expiresAt || 0)
}

function purgeExpiredScheduleTaskDrafts() {
  for (const [key, draft] of scheduleTaskDrafts.entries()) {
    if (isScheduleTaskDraftExpired(draft)) scheduleTaskDrafts.delete(key)
  }
}

async function handleScheduleTaskDraftInput(ws, payload) {
  if (!payload || payload.message_type !== 'group') return false
  purgeExpiredScheduleTaskDrafts()
  const draftKey = getScheduleTaskDraftKey(payload)
  const draft = scheduleTaskDrafts.get(draftKey)
  if (!draft) return false
  if (isScheduleTaskDraftExpired(draft)) {
    scheduleTaskDrafts.delete(draftKey)
    await replyCommandMessage(ws, payload, '创建定时任务已超时，请重新发送“阿卡林 创建定时任务”开始')
    return true
  }
  const content = extractContent(payload.message)
  const inputText = normalizeCommandText(content.text)
  if (inputText === '取消') {
    scheduleTaskDrafts.delete(draftKey)
    await replyCommandMessage(ws, payload, '已取消创建定时任务')
    return true
  }
  if (draft.stage === 'await_spec') {
    const parsed = parseScheduleSpec(inputText)
    if (!parsed) {
      scheduleTaskDrafts.set(draftKey, createScheduleTaskDraft('await_spec'))
      await replyCommandMessage(ws, payload, '请输入定时规则，例如：每天 08:30、每周一 08:30、每月 1号 08:30、2026-05-07 08:30')
      return true
    }
    if (parsed.mode === 'once' && parsed.runAt <= Date.now()) {
      scheduleTaskDrafts.set(draftKey, createScheduleTaskDraft('await_spec'))
      await replyCommandMessage(ws, payload, '一次性定时任务的时间必须晚于当前时间，请重新输入')
      return true
    }
    scheduleTaskDrafts.set(draftKey, createScheduleTaskDraft('await_content', { scheduleSpec: parsed }))
    await replyCommandMessage(ws, payload, `已记录定时规则：${parsed.specText}\n请发送定时内容\n可包含文本、图片、表情，或引用一条消息\n发送“取消”可退出`)
    return true
  }
  if (draft.stage === 'await_content') {
    let replySegments = await captureCustomReplySegments(ws, payload.message)
    if (replySegments.length === 0 && content.replyId) {
      const repliedContent = await getReplyMessageContent(ws, content.replyId)
      replySegments = await captureCustomReplySegments(ws, repliedContent && repliedContent.message)
    }
    if (replySegments.length === 0) {
      scheduleTaskDrafts.set(draftKey, createScheduleTaskDraft('await_content', { scheduleSpec: draft.scheduleSpec }))
      await replyCommandMessage(ws, payload, '未识别到可保存的定时内容，请发送文本、图片、表情，或引用一条消息')
      return true
    }
    const added = addScheduledTask(payload.group_id, draft.scheduleSpec, { segments: replySegments }, payload.user_id)
    scheduleTaskDrafts.delete(draftKey)
    if (!added.ok && added.reason === 'past') {
      await replyCommandMessage(ws, payload, '一次性定时任务的时间必须晚于当前时间，请重新创建')
      return true
    }
    if (!added.ok) {
      await replyCommandMessage(ws, payload, '定时任务创建失败，请重新创建')
      return true
    }
    await replyCommandMessage(ws, payload, `已创建定时任务 #${added.count}：${previewScheduledTask(added.task)}\n下次执行：${formatScheduleTime(added.task.nextRunAt)}`)
    return true
  }
  scheduleTaskDrafts.delete(draftKey)
  return false
}

async function handleCustomReplyMatch(ws, payload, text) {
  if (!payload || payload.message_type !== 'group') return false
  const entry = pickCustomReply(payload.group_id, text)
  if (!entry) return false
  await replyCommandMessage(ws, payload, await buildCustomReplyMessageVariants(entry))
  return true
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
  const textPrefix = headerText ? [{ type: 'text', data: { text: headerText } }] : []
  const withHeader = (messageSegments) => textPrefix.concat(Array.isArray(messageSegments) ? messageSegments : [])
  if (!normalizedItem) {
    return [withHeader([{ type: 'text', data: { text: '（空）' } }])]
  }
  if (normalizedItem.type === 'image') {
    const actualSource = await persistPokeImageSource(normalizedItem.source).catch(() => normalizedItem.source)
    const variants = []
    const seen = new Set()
    const pushVariant = (messageSegments) => {
      const variant = withHeader(messageSegments)
      const key = JSON.stringify(variant)
      if (seen.has(key)) return
      seen.add(key)
      variants.push(variant)
    }
    if (isLocalFileSource(actualSource)) {
      const file = toOutboundImageFile(actualSource)
      pushVariant([{ type: 'image', data: { file } }])
    }
    const base64 = await sourceToBase64(actualSource).catch(() => null)
    if (base64 && base64.data) {
      pushVariant([{ type: 'image', data: { file: `base64://${base64.data}` } }])
    }
    const file = toOutboundImageFile(actualSource)
    if (file) pushVariant([{ type: 'image', data: { file } }])
    return variants.length > 0
      ? variants
      : [withHeader([{ type: 'text', data: { text: '[图片发送失败]' } }])]
  }
  return [withHeader([{ type: 'text', data: { text: normalizedItem.content } }])]
}

function normalizeMessageVariants(message) {
  if (!Array.isArray(message)) return [[{ type: 'text', data: { text: String(message || '') } }]]
  if (message.length > 0 && Array.isArray(message[0])) return message
  return [message]
}

async function replyCommandMessage(ws, payload, text) {
  const baseMessage = Array.isArray(text) ? text : [{ type: 'text', data: { text } }]
  const variants = normalizeMessageVariants(baseMessage)
  for (const msg of variants) {
    const result = payload.message_type === 'group'
      ? await sendAction(ws, 'send_group_msg', { group_id: payload.group_id, message: msg }).catch(() => null)
      : await sendAction(ws, 'send_private_msg', { user_id: payload.user_id, message: msg }).catch(() => null)
    if (result && result.status === 'ok') return
  }
}

async function handleImageGenerationRequest(ws, payload, promptText, hist) {
  const prompt = String(promptText || '').trim()
  if (!prompt || !shouldGenerateImage(prompt)) return { handled: false }
  console.log('命中生图请求', prompt.slice(0, 120))
  await replyCommandMessage(ws, payload, '收到啦，正在生成图片，可能需要几十秒……')
  const startedAt = Date.now()
  const result = await callOpenAI(prompt, [], hist, {
    structured: true,
    generateImage: true,
    timeoutMs: OPENAI_IMAGE_TIMEOUT_MS
  })
  if (!result || typeof result !== 'object') return { handled: false }
  const images = Array.isArray(result.images) ? result.images : []
  const text = sanitizeText(result.text || '')
  console.log(`生图返回 images=${images.length} elapsed=${Date.now() - startedAt}ms text=${text ? text.slice(0, 80) : ''}`)
  if (images.length === 0) {
    await replyCommandMessage(ws, payload, text || '当前上游暂不支持文生图，或本次生图失败，请稍后再试')
    return { handled: true, deliveredText: text || '当前上游暂不支持文生图，或本次生图失败，请稍后再试' }
  }
  if (text) await replyCommandMessage(ws, payload, text)
  let deliveredImages = 0
  for (const image of images.slice(0, 1)) {
    const filePath = saveGeneratedImage(image.b64, 'image/png')
    if (!filePath) continue
    const variants = await buildCustomReplyMessageVariants({ segments: [{ type: 'image', source: filePath }] })
    await replyCommandMessage(ws, payload, variants)
    deliveredImages += 1
  }
  if (deliveredImages === 0) {
    const fallbackText = text || '图片已生成，但发送失败，请稍后再试'
    await replyCommandMessage(ws, payload, fallbackText)
    return { handled: true, deliveredText: fallbackText }
  }
  return { handled: true, deliveredText: text || '[已发送生成图片]' }
}

async function getReplyMessageContent(ws, replyId) {
  const normalizedReplyId = String(replyId || '').trim()
  if (!normalizedReplyId) return null
  const replied = await sendAction(ws, 'get_msg', { message_id: normalizedReplyId }).catch(() => null)
  if (!(replied && replied.status === 'ok' && replied.data && replied.data.message)) return null
  const repliedContent = extractContent(replied.data.message)
  repliedContent.media = await resolveMediaSources(ws, repliedContent.media)
  repliedContent.message = replied.data.message
  return repliedContent
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

function buildCustomReplyHelp(isAdminUser) {
  const lines = [
    '自定义回复命令：',
    '1. 创建自定义回复',
    '2. 自定义回复 添加 触发词 => 回复文本',
    '3. 可引用一条消息后发送：自定义回复 添加 触发词',
    '4. 可引用一条消息后发送：创建自定义回复 触发词',
    '5. 自定义回复 列表',
    '6. 自定义回复 查看 触发词',
    '7. 自定义回复 删除 触发词',
    '8. 自定义回复 删除 触发词 第N条',
    '9. 自定义回复 清空',
    '10. 交互创建过程中发送“取消”可退出'
  ]
  if (!isAdminUser) lines.push('以上命令需要管理员权限')
  return lines.join('\n')
}

function buildScheduleCommandHelp(isAdminUser) {
  const lines = [
    '定时任务命令：',
    '1. 定时任务 列表',
    '2. 定时任务 查看 序号'
  ]
  if (isAdminUser) {
    lines.push('3. 定时任务 添加 每天 08:30 => 文本内容')
    lines.push('4. 定时任务 添加 每周一 08:30 => 文本内容')
    lines.push('5. 定时任务 添加 每月 1号 08:30 => 文本内容')
    lines.push('6. 定时任务 添加 2026-05-07 08:30 => 文本内容')
    lines.push('7. 可引用一条消息后发送：定时任务 添加 每天 08:30')
    lines.push('8. 创建定时任务')
    lines.push('9. 定时任务 删除 序号')
    lines.push('10. 定时任务 清空')
  } else {
    lines.push('其余定时任务管理命令需要管理员权限')
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
  const isSchedule = /^(创建定时任务|取消定时任务|定时任务|定时|计划任务|定时提醒)/i.test(nt) || /^(创建定时任务|取消定时任务|定时任务|定时|计划任务|定时提醒)/i.test(compact)
  const isCustomReply = /^(创建自定义回复|取消自定义回复|自定义回复|关键词回复|关键字回复)/i.test(nt)
    || /^(创建自定义回复|取消自定义回复|自定义回复|关键词回复|关键字回复)/i.test(compact)
  const matchedCommand = isBanned || isContext || isPoke || isSchedule || isCustomReply
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
      let repliedContent = null
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
        let content = String((rawAddMatch && rawAddMatch[1]) || addMatch[1] || '').trim()
        if (!content && commandContent.replyId) {
          repliedContent = repliedContent || await getReplyMessageContent(ws, commandContent.replyId)
          content = String((repliedContent && repliedContent.text) || '').trim()
        }
        if (!content) {
          await replyCommandMessage(ws, payload, '请在命令后附带要添加的拍一拍文案，或引用一条带文本的消息')
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
          repliedContent = repliedContent || await getReplyMessageContent(ws, commandContent.replyId)
          imageMedia = ((repliedContent && repliedContent.media) || []).find((item) => item && item.kind === 'image') || null
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
        const persistedSource = await persistPokeImageSource(source).catch(() => source)
        const item = normalizePokeReplyItem({ type: 'image', source: persistedSource || source })
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
    if (isSchedule) {
      if (!isGroup) {
        await replyCommandMessage(ws, payload, '定时任务目前仅支持群聊')
        return true
      }
      const commandContent = extractContent(payload.message)
      const draftKey = getScheduleTaskDraftKey(payload)
      purgeExpiredScheduleTaskDrafts()
      const currentDraft = scheduleTaskDrafts.get(draftKey)
      const startInteractive = /^(创建定时任务|定时任务创建|定时任务新建)$/i.test(nt) || /^(创建定时任务|定时任务创建|定时任务新建)$/i.test(compact)
      const cancelInteractive = /^(取消定时任务|取消创建定时任务|定时任务取消)$/i.test(nt) || /^(取消定时任务|取消创建定时任务|定时任务取消)$/i.test(compact)
      const listMatch = /^(?:定时任务|定时|计划任务|定时提醒).*(列表|list)$/i.test(nt) || /(定时任务列表|计划任务列表)/i.test(compact)
      const viewMatch = nt.match(/^(?:定时任务|定时|计划任务|定时提醒)\s*(?:查看|详情|明细|show|view)\s+(\d+)$/i)
      const deleteMatch = nt.match(/^(?:定时任务|定时|计划任务|定时提醒)\s*(?:删除|移除|取消)\s+(\d+)$/i)
      const clearMatch = /^(?:定时任务|定时|计划任务|定时提醒).*(清空|clear|reset)$/i.test(nt)
      const textAddMatch = String(rawCommandText || '').match(/^(?:定时任务|定时|计划任务|定时提醒)\s*(?:添加|新增|创建)\s+(.+?)\s*(?:=>|->|＝>|→)\s*([\s\S]+)$/i)
      const quotedAddMatch = String(rawCommandText || '').match(/^(?:定时任务|定时|计划任务|定时提醒)\s*(?:添加|新增|创建)\s+([\s\S]+)$/i)

      if (listMatch) {
        const tasks = listScheduledTasks(payload.group_id)
        if (tasks.length === 0) {
          await replyCommandMessage(ws, payload, '当前群还没有定时任务')
          return true
        }
        const body = tasks.map((task, index) => `${index + 1}. ${previewScheduledTask(task)} | 下次执行：${formatScheduleTime(task.nextRunAt)}`).join('\n')
        await replyCommandMessage(ws, payload, `当前群定时任务列表：\n${body}`)
        return true
      }
      if (viewMatch) {
        const tasks = listScheduledTasks(payload.group_id)
        const index = parseInt(viewMatch[1], 10)
        if (!Number.isInteger(index) || index < 1 || index > tasks.length) {
          await replyCommandMessage(ws, payload, '请提供正确的任务编号，例如：定时任务 查看 1')
          return true
        }
        const task = tasks[index - 1]
        await replyCommandMessage(ws, payload, `定时任务 #${index}\n时间：${task.specText}\n下次执行：${formatScheduleTime(task.nextRunAt)}`)
        await replyCommandMessage(ws, payload, await buildCustomReplyMessageVariants(task.content))
        return true
      }
      if (!isAdminUser) {
        await replyCommandMessage(ws, payload, '需要管理员权限才能管理定时任务')
        return true
      }
      if (cancelInteractive) {
        if (currentDraft) {
          scheduleTaskDrafts.delete(draftKey)
          await replyCommandMessage(ws, payload, '已取消创建定时任务')
        } else {
          await replyCommandMessage(ws, payload, '当前没有正在进行的定时任务创建流程')
        }
        return true
      }
      if (startInteractive) {
        scheduleTaskDrafts.set(draftKey, createScheduleTaskDraft('await_spec'))
        await replyCommandMessage(ws, payload, '请输入定时规则\n例如：每天 08:30、每周一 08:30、每月 1号 08:30、2026-05-07 08:30\n10分钟内未继续将自动取消')
        return true
      }
      if (deleteMatch) {
        const index = parseInt(deleteMatch[1], 10)
        const removed = removeScheduledTask(payload.group_id, index)
        if (!removed.ok) {
          await replyCommandMessage(ws, payload, '未找到对应的定时任务编号')
          return true
        }
        await replyCommandMessage(ws, payload, `已删除定时任务 #${index}：${previewScheduledTask(removed.removed)}\n当前共 ${removed.count} 条`)
        return true
      }
      if (clearMatch) {
        const cleared = clearScheduledTasks(payload.group_id)
        if (!cleared.ok) {
          await replyCommandMessage(ws, payload, '当前群没有可清空的定时任务')
          return true
        }
        await replyCommandMessage(ws, payload, `已清空当前群定时任务，共移除 ${cleared.removedCount} 条`)
        return true
      }
      if (textAddMatch || quotedAddMatch) {
        const scheduleRaw = String((textAddMatch && textAddMatch[1]) || (quotedAddMatch && quotedAddMatch[1]) || '').trim()
        const schedule = parseScheduleSpec(scheduleRaw)
        if (!schedule) {
          await replyCommandMessage(ws, payload, '请使用正确的时间格式，例如：定时任务 添加 每天 08:30 => 早安、定时任务 添加 每周一 08:30 => 周会、定时任务 添加 每月 1号 08:30 => 月初提醒、定时任务 添加 2026-05-07 08:30 => 开会提醒')
          return true
        }
        let entry = null
        if (textAddMatch) {
          const contentText = String(textAddMatch[2] || '').replace(/\r/g, '').trim()
          if (!contentText) {
            await replyCommandMessage(ws, payload, '请在 => 后提供文本内容，或改用引用消息的方式创建定时任务')
            return true
          }
          entry = { segments: [{ type: 'text', data: { text: contentText } }] }
        } else if (commandContent.replyId) {
          const repliedContent = await getReplyMessageContent(ws, commandContent.replyId)
          const replySegments = await captureCustomReplySegments(ws, repliedContent && repliedContent.message)
          if (replySegments.length > 0) entry = { segments: replySegments }
        }
        if (!entry) {
          await replyCommandMessage(ws, payload, '请在命令中使用 => 提供文本内容，或引用一条带文本/图片/表情的消息作为定时发送内容')
          return true
        }
        const added = addScheduledTask(payload.group_id, schedule, entry, payload.user_id)
        if (!added.ok && added.reason === 'past') {
          await replyCommandMessage(ws, payload, '一次性定时任务的时间必须晚于当前时间')
          return true
        }
        if (!added.ok) {
          await replyCommandMessage(ws, payload, '定时任务创建失败，请检查时间格式和发送内容')
          return true
        }
        await replyCommandMessage(ws, payload, `已创建定时任务 #${added.count}：${previewScheduledTask(added.task)}\n下次执行：${formatScheduleTime(added.task.nextRunAt)}`)
        return true
      }
      await replyCommandMessage(ws, payload, buildScheduleCommandHelp(isAdminUser))
      return true
    }
    if (isCustomReply) {
      if (!isGroup) {
        await replyCommandMessage(ws, payload, '自定义回复目前仅支持群聊')
        return true
      }
      const commandContent = extractContent(payload.message)
      const draftKey = getCustomReplyDraftKey(payload)
      purgeExpiredCustomReplyDrafts()
      const currentDraft = customReplyDrafts.get(draftKey)
      const startInteractive = /^(创建自定义回复|自定义回复创建|自定义回复新建)$/i.test(nt) || /^(创建自定义回复|自定义回复创建|自定义回复新建)$/i.test(compact)
      const cancelInteractive = /^(取消自定义回复|取消创建自定义回复|自定义回复取消)$/i.test(nt) || /^(取消自定义回复|取消创建自定义回复|自定义回复取消)$/i.test(compact)
      const listRules = /^(自定义回复|关键词回复|关键字回复).*(列表|list)$/i.test(nt) || /(自定义回复列表|关键词回复列表|关键字回复列表)/i.test(compact)
      const viewMatch = nt.match(/^(?:自定义回复|关键词回复|关键字回复)\s*(?:查看|详情|明细|show|view)\s+([\s\S]+)$/i)
      const removeEntryMatch = nt.match(/^(?:自定义回复|关键词回复|关键字回复)\s*(?:删除|移除|去除)\s+([\s\S]+?)\s*(?:第\s*)?(\d+)\s*条?$/i)
      const removeMatch = nt.match(/^(?:自定义回复|关键词回复|关键字回复)\s*(?:删除|移除|去除)\s+(.+)$/i)
      const clearRules = /^(?:自定义回复|关键词回复|关键字回复).*(清空|重置|clear|reset|empty|purge)$/i.test(nt)
        || /(自定义回复清空|关键词回复清空|关键字回复清空|自定义回复重置)/i.test(compact)
      const rawAddMatch = String(rawCommandText || '').match(/^(?:自定义回复|关键词回复|关键字回复)\s*(?:添加|新增|创建)\s+([\s\S]+?)\s*(?:=>|->|＝>|→)\s*([\s\S]+)$/i)
      const quotedAddTriggerMatch = String(rawCommandText || '').match(/^(?:自定义回复|关键词回复|关键字回复)\s*(?:添加|新增|创建)\s+([\s\S]+)$/i)
      const quotedCreateTriggerMatch = String(rawCommandText || '').match(/^(?:创建自定义回复|自定义回复创建|自定义回复新建)\s+([\s\S]+)$/i)

      if (!isAdminUser) {
        await replyCommandMessage(ws, payload, '需要管理员权限才能管理自定义回复')
        return true
      }
      if (cancelInteractive) {
        if (currentDraft) {
          customReplyDrafts.delete(draftKey)
          await replyCommandMessage(ws, payload, '已取消创建自定义回复')
        } else {
          await replyCommandMessage(ws, payload, '当前没有正在进行的自定义回复创建流程')
        }
        return true
      }
      if (startInteractive) {
        customReplyDrafts.set(draftKey, createCustomReplyDraft('await_trigger'))
        await replyCommandMessage(ws, payload, '请输入被回复内容\n10分钟内未继续将自动取消')
        return true
      }
      if (rawAddMatch) {
        const trigger = normalizeCustomReplyTrigger(rawAddMatch[1])
        const replyText = String(rawAddMatch[2] || '').replace(/\r/g, '').trim()
        if (!trigger || !replyText) {
          await replyCommandMessage(ws, payload, '请使用：自定义回复 添加 触发词 => 回复文本')
          return true
        }
        const added = addCustomReply(payload.group_id, trigger, {
          segments: [{ type: 'text', data: { text: replyText } }]
        })
        if (!added.ok && added.reason === 'duplicate') {
          await replyCommandMessage(ws, payload, `该自定义回复已存在：${trigger} => ${replyText}`)
          return true
        }
        await replyCommandMessage(ws, payload, `已创建自定义回复：${trigger} => ${replyText}\n当前该关键词共有 ${added.count} 条回复`)
        return true
      }
      const quotedTriggerRaw = (quotedAddTriggerMatch && quotedAddTriggerMatch[1]) || (quotedCreateTriggerMatch && quotedCreateTriggerMatch[1]) || ''
      const quotedTrigger = normalizeCustomReplyTrigger(quotedTriggerRaw)
      if (quotedTrigger && commandContent.replyId) {
        const repliedContent = await getReplyMessageContent(ws, commandContent.replyId)
        const replySegments = await captureCustomReplySegments(ws, repliedContent && repliedContent.message)
        if (replySegments.length === 0) {
          await replyCommandMessage(ws, payload, '引用消息里没有可保存的回复内容，请引用一条带文本、图片或表情的消息')
          return true
        }
        const added = addCustomReply(payload.group_id, quotedTrigger, { segments: replySegments })
        if (!added.ok && added.reason === 'duplicate') {
          await replyCommandMessage(ws, payload, `该自定义回复已存在：${quotedTrigger} => ${previewCustomReplyEntry({ segments: replySegments })}`)
          return true
        }
        await replyCommandMessage(ws, payload, `已创建自定义回复：${quotedTrigger} => ${previewCustomReplyEntry(added.entry)}\n当前该关键词共有 ${added.count} 条回复`)
        return true
      }
      if (quotedTriggerRaw) {
        await replyCommandMessage(ws, payload, '请引用一条消息作为回复内容，或使用：自定义回复 添加 触发词 => 回复内容')
        return true
      }
      if (listRules) {
        const rules = listCustomReplyTriggers(payload.group_id)
        if (rules.length === 0) {
          await replyCommandMessage(ws, payload, '当前群还没有自定义回复')
          return true
        }
        const body = rules
          .map((rule, index) => `${index + 1}. ${rule.trigger}（${rule.replies.length} 条） 示例：${previewCustomReplyEntry(rule.replies[0])}`)
          .join('\n')
        await replyCommandMessage(ws, payload, `当前群自定义回复列表：\n${body}`)
        return true
      }
      if (viewMatch) {
        const trigger = normalizeCustomReplyTrigger(viewMatch[1])
        if (!trigger) {
          await replyCommandMessage(ws, payload, '请提供要查看的触发词，例如：自定义回复 查看 测试')
          return true
        }
        const entries = getCustomReplyEntries(payload.group_id, trigger)
        if (entries.length === 0) {
          await replyCommandMessage(ws, payload, `未找到触发词为“${trigger}”的自定义回复`)
          return true
        }
        await replyCommandMessage(ws, payload, `自定义回复：${trigger}\n共 ${entries.length} 条`)
        for (let index = 0; index < entries.length; index += 1) {
          await replyCommandMessage(ws, payload, await buildCustomReplyMessageVariants(entries[index], `#${index + 1}：\n`))
        }
        return true
      }
      if (removeEntryMatch) {
        const trigger = normalizeCustomReplyTrigger(removeEntryMatch[1])
        const index = parseInt(removeEntryMatch[2], 10)
        if (!trigger || !Number.isInteger(index) || index < 1) {
          await replyCommandMessage(ws, payload, '请使用：自定义回复 删除 触发词 第2条')
          return true
        }
        const removed = removeCustomReplyEntry(payload.group_id, trigger, index)
        if (!removed.ok) {
          await replyCommandMessage(ws, payload, `未找到“${trigger}”的第 ${index} 条回复`)
          return true
        }
        await replyCommandMessage(ws, payload, `已删除自定义回复：${trigger} 第 ${index} 条\n内容：${previewCustomReplyEntry(removed.removed)}\n剩余 ${removed.remainingCount} 条`)
        return true
      }
      if (removeMatch) {
        const trigger = normalizeCustomReplyTrigger(removeMatch[1])
        if (!trigger) {
          await replyCommandMessage(ws, payload, '请提供要删除的触发词，例如：自定义回复 删除 测试')
          return true
        }
        const removed = removeCustomReply(payload.group_id, trigger)
        if (!removed.ok) {
          await replyCommandMessage(ws, payload, `未找到触发词为“${trigger}”的自定义回复`)
          return true
        }
        await replyCommandMessage(ws, payload, `已删除自定义回复：${trigger}（共 ${removed.removedCount} 条回复）`)
        return true
      }
      if (clearRules) {
        const cleared = clearCustomReplies(payload.group_id)
        if (!cleared.ok) {
          await replyCommandMessage(ws, payload, '当前群没有可清空的自定义回复')
          return true
        }
        await replyCommandMessage(ws, payload, `已清空当前群自定义回复：移除 ${cleared.removedTriggers} 个触发词，共 ${cleared.removedReplies} 条回复`)
        return true
      }
      await replyCommandMessage(ws, payload, buildCustomReplyHelp(isAdminUser))
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
