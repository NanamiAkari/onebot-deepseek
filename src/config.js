const fs = require('fs')
const path = require('path')
const { HttpsProxyAgent } = require('https-proxy-agent')
require('dotenv').config()

const PROJECT_ROOT = path.join(__dirname, '..')

function readSystemPrompt() {
  const f = process.env.PROMPT_FILE
  if (f) {
    const p = path.isAbsolute(f) ? f : path.join(PROJECT_ROOT, f)
    try {
      const s = fs.readFileSync(p, 'utf8').trim()
      if (s) return s
    } catch {}
  }
  return process.env.SYSTEM_PROMPT || '你是一个QQ群内的AI助手，回答简洁且有帮助。'
}

function readTextListFile(filePath) {
  if (!filePath) return []
  const p = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_ROOT, filePath)
  try {
    const raw = fs.readFileSync(p, 'utf8').trim()
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.map((item) => {
          if (typeof item === 'string') return String(item || '').trim()
          if (item && typeof item === 'object' && item.type !== 'image') {
            return String(item.content || item.text || '').trim()
          }
          return ''
        }).filter(Boolean)
      }
    } catch {}
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
  } catch {
    return []
  }
}

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
const DEFAULT_IGNORE_REGEX = /^(?:pjsk|b30|msa|msp|mysekai|tsearch|song|taikoupdate|taikorec|taikob|taikotrend|wlsk|sekai|qooapp|cnmusicupdate|cnmusicdiffupdate|sk预测|查房|分数线|段位进度|live订阅)(?:\s|$)/i

module.exports = {
  PROJECT_ROOT,
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 5000,
  PATH: process.env.ONEBOT_PATH || '/onebot/v11/ws',
  PROVIDER: (process.env.LLM_PROVIDER || 'deepseek').toLowerCase(),
  MODEL: process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || ((process.env.LLM_PROVIDER || 'deepseek').toLowerCase() === 'gemini' ? 'gemini-1.5-flash' : (process.env.LLM_PROVIDER || 'deepseek').toLowerCase() === 'openai' ? 'gpt-3.5-turbo' : 'deepseek-chat'),
  API_KEY: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
  API_URL: process.env.LLM_API_URL || process.env.DEEPSEEK_API_URL || ((process.env.LLM_PROVIDER || 'deepseek').toLowerCase() === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.deepseek.com/v1/chat/completions'),
  SYSTEM_PROMPT: readSystemPrompt(),
  GEMINI_KEY: (process.env.LLM_PROVIDER === 'gemini' ? process.env.LLM_API_KEY : process.env.GEMINI_API_KEY) || '',
  GEMINI_MODEL: (process.env.LLM_PROVIDER === 'gemini' ? process.env.LLM_MODEL : process.env.GEMINI_MODEL) || 'gemini-1.5-flash-latest',
  DEEPSEEK_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  PROXY_URL,
  HTTPS_AGENT: PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined,
  REQUIRE_PREFIX: String(process.env.AI_REQUIRE_PREFIX || 'true').toLowerCase() === 'true',
  GROUP_REQUIRE_MENTION: String(process.env.AI_GROUP_REQUIRE_MENTION || 'false').toLowerCase() === 'true',
  PREFIXES: (process.env.AI_PREFIXES || '/ai').split(',').map((s) => s.trim()).filter(Boolean),
  ADMIN_USER_IDS: (process.env.AI_ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  AI_FILE_TOOLS_ENABLE: String(process.env.AI_FILE_TOOLS_ENABLE || 'false').toLowerCase() === 'true',
  AI_WEB_SEARCH_ENABLE: String(process.env.AI_WEB_SEARCH_ENABLE || 'true').toLowerCase() === 'true',
  AI_WEB_SEARCH_PROVIDER: (process.env.AI_WEB_SEARCH_PROVIDER || 'auto').toLowerCase(),
  AI_WEB_SEARCH_MAX_RESULTS: Math.max(1, Math.min(8, parseInt(process.env.AI_WEB_SEARCH_MAX_RESULTS || '5', 10) || 5)),
  AI_WEB_SEARCH_TIMEOUT_MS: Math.max(3000, Math.min(30000, parseInt(process.env.AI_WEB_SEARCH_TIMEOUT_MS || '15000', 10) || 15000)),
  AI_WEB_SEARCH_MAX_CHARS: Math.max(1000, Math.min(20000, parseInt(process.env.AI_WEB_SEARCH_MAX_CHARS || '8000', 10) || 8000)),
  AI_WEB_FETCH_ENABLE: String(process.env.AI_WEB_FETCH_ENABLE || 'true').toLowerCase() === 'true',
  AI_WEB_FETCH_TIMEOUT_MS: Math.max(3000, Math.min(30000, parseInt(process.env.AI_WEB_FETCH_TIMEOUT_MS || '15000', 10) || 15000)),
  AI_WEB_FETCH_MAX_BYTES: Math.max(65536, Math.min(5242880, parseInt(process.env.AI_WEB_FETCH_MAX_BYTES || '2097152', 10) || 2097152)),
  AI_WEB_FETCH_MAX_CHARS: Math.max(500, Math.min(50000, parseInt(process.env.AI_WEB_FETCH_MAX_CHARS || '12000', 10) || 12000)),
  AI_STICKER_ENABLE: String(process.env.AI_STICKER_ENABLE || 'true').toLowerCase() === 'true',
  AI_STICKER_DIR: process.env.AI_STICKER_DIR || 'sticker_data',
  AI_STICKER_MAX_BYTES: Math.max(65536, Math.min(20971520, parseInt(process.env.AI_STICKER_MAX_BYTES || '10485760', 10) || 10485760)),
  AI_STICKER_MAX_COUNT: Math.max(1, Math.min(10000, parseInt(process.env.AI_STICKER_MAX_COUNT || '1000', 10) || 1000)),
  AI_STICKER_MAX_COLLECT_PER_HOUR: Math.max(1, Math.min(100, parseInt(process.env.AI_STICKER_MAX_COLLECT_PER_HOUR || '10', 10) || 10)),
  AI_POKE_IMAGE_MAX_BYTES: Math.max(65536, Math.min(20971520, parseInt(process.env.AI_POKE_IMAGE_MAX_BYTES || '10485760', 10) || 10485760)),
  TAVILY_API_KEY: process.env.TAVILY_API_KEY || '',
  BOCHA_API_KEY: process.env.BOCHA_API_KEY || '',
  SEARXNG_BASE_URL: process.env.SEARXNG_BASE_URL || '',
  DEEPSEEK_SEARCH_API_KEY: process.env.DEEPSEEK_SEARCH_API_KEY || process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_SEARCH_API_URL: process.env.DEEPSEEK_SEARCH_API_URL || 'https://api.deepseek.com/responses',
  DEEPSEEK_SEARCH_MODEL: process.env.DEEPSEEK_SEARCH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  AI_MAX_CONCURRENT_REQUESTS: Math.max(1, Math.min(8, parseInt(process.env.AI_MAX_CONCURRENT_REQUESTS || '2', 10) || 2)),
  AI_QUEUE_MAX_PER_SESSION: Math.max(1, Math.min(100, parseInt(process.env.AI_QUEUE_MAX_PER_SESSION || '10', 10) || 10)),
  AI_QUEUE_MAX_TOTAL: Math.max(1, Math.min(500, parseInt(process.env.AI_QUEUE_MAX_TOTAL || '50', 10) || 50)),
  AI_QUEUE_WAIT_TIMEOUT_MS: Math.max(1000, Math.min(600000, parseInt(process.env.AI_QUEUE_WAIT_TIMEOUT_MS || '120000', 10) || 120000)),
  AI_TOOL_PARALLEL_MAX: Math.max(1, Math.min(16, parseInt(process.env.AI_TOOL_PARALLEL_MAX || '4', 10) || 4)),
  AI_TURN_DEADLINE_MS: Math.max(5000, Math.min(300000, parseInt(process.env.AI_TURN_DEADLINE_MS || '60000', 10) || 60000)),
  AI_TOOL_WRITE_LOCK: ['keyed', 'global', 'none'].includes(String(process.env.AI_TOOL_WRITE_LOCK || '').toLowerCase())
    ? String(process.env.AI_TOOL_WRITE_LOCK).toLowerCase()
    : 'keyed',
  // 0 是明确的关闭值，不能被 || 默认值吞掉。
  AI_SEND_DEDUPE_MS: (() => {
    const raw = process.env.AI_SEND_DEDUPE_MS
    if (raw === undefined || raw === '') return 9000
    const value = parseInt(raw, 10)
    return Number.isFinite(value) ? Math.max(0, Math.min(60000, value)) : 9000
  })(),
  // 用量统计只记 token 数量和模型名；单价为每百万 token，0 表示不估算成本
  AI_USAGE_STATS_ENABLE: String(process.env.AI_USAGE_STATS_ENABLE || 'true').toLowerCase() === 'true',
  AI_USAGE_DIR: process.env.AI_USAGE_DIR || 'usage_data',
  AI_PRICE_INPUT_PER_1M: Math.max(0, parseFloat(process.env.AI_PRICE_INPUT_PER_1M || '0') || 0),
  AI_PRICE_OUTPUT_PER_1M: Math.max(0, parseFloat(process.env.AI_PRICE_OUTPUT_PER_1M || '0') || 0),
  // 定时任务发送失败后的重试间隔与最大尝试次数
  AI_SCHEDULE_RETRY_DELAY_MS: Math.max(15000, Math.min(600000, parseInt(process.env.AI_SCHEDULE_RETRY_DELAY_MS || '60000', 10) || 60000)),
  AI_SCHEDULE_MAX_ATTEMPTS: Math.max(1, Math.min(10, parseInt(process.env.AI_SCHEDULE_MAX_ATTEMPTS || '3', 10) || 3)),
  AI_NAME_INTENT_ENABLE: String(process.env.AI_NAME_INTENT_ENABLE || 'true').toLowerCase() === 'true',
  AI_NAME_INTENT_THRESHOLD: (() => {
    const value = parseFloat(process.env.AI_NAME_INTENT_THRESHOLD || '0.65')
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.65
  })(),
  AI_NAME_INTENT_TIMEOUT_MS: Math.max(1000, Math.min(30000, parseInt(process.env.AI_NAME_INTENT_TIMEOUT_MS || '10000', 10) || 10000)),
  IGNORE_REGEX: process.env.AI_IGNORE_REGEX ? new RegExp(process.env.AI_IGNORE_REGEX, 'i') : DEFAULT_IGNORE_REGEX,
  MAX_MEDIA_BYTES: parseInt(process.env.AI_MAX_MEDIA_BYTES || '5242880', 10),
  MEDIA_REFERER: process.env.AI_MEDIA_REFERER || '',
  OPENAI_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  OPENAI_BASE_URL: (process.env.OPENAI_BASE_URL || process.env.LLM_API_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  OPENAI_WIRE_API: (process.env.OPENAI_WIRE_API || '').toLowerCase(),
  OPENAI_REASONING_EFFORT: process.env.OPENAI_REASONING_EFFORT || '',
  OPENAI_NETWORK_ACCESS: process.env.OPENAI_NETWORK_ACCESS || '',
  AI_SIMPLE_MODE: String(process.env.AI_SIMPLE_MODE || 'false').toLowerCase() === 'true',
  OPENAI_TIMEOUT_MS: parseInt(process.env.OPENAI_TIMEOUT_MS || '12000', 10),
  OPENAI_IMAGE_TIMEOUT_MS: parseInt(process.env.OPENAI_IMAGE_TIMEOUT_MS || '180000', 10),
  AI_IMAGE_GENERATION_INTENT_THRESHOLD: parseFloat(process.env.AI_IMAGE_GENERATION_INTENT_THRESHOLD || '0.75'),
  AI_REPLY_MAX_CHARS: parseInt(process.env.AI_REPLY_MAX_CHARS || '3200', 10),
  AI_REPLY_CHUNK_CHARS: parseInt(process.env.AI_REPLY_CHUNK_CHARS || '750', 10),
  AI_POKE_ENABLE: String(process.env.AI_POKE_ENABLE || 'true').toLowerCase() === 'true',
  AI_POKE_COOLDOWN: parseInt(process.env.AI_POKE_COOLDOWN || '10', 10),
  AI_POKE_REPLY_FILE: process.env.AI_POKE_REPLY_FILE || 'poke_replies.json',
  AI_CUSTOM_REPLY_FILE: process.env.AI_CUSTOM_REPLY_FILE || 'custom_replies.json',
  AI_SCHEDULE_FILE: process.env.AI_SCHEDULE_FILE || 'scheduled_tasks.json',
  AI_POKE_REPLY_TEXT: process.env.AI_POKE_REPLY_TEXT || '拍了拍',
  AI_POKE_REPLY_TEXTS: (() => {
    const fileItems = readTextListFile(process.env.AI_POKE_REPLY_FILE || 'poke_replies.json')
    if (fileItems.length > 0) return fileItems
    return (process.env.AI_POKE_REPLY_TEXTS || process.env.AI_POKE_REPLY_TEXT || '拍了拍').split('|').map((s) => s.trim()).filter(Boolean)
  })(),
  AI_CONTEXT_ENABLE: String(process.env.AI_CONTEXT_ENABLE || 'true').toLowerCase() === 'true',
  AI_CONTEXT_WINDOW: parseInt(process.env.AI_CONTEXT_WINDOW || '6', 10),
  AI_CONTEXT_TTL: parseInt(process.env.AI_CONTEXT_TTL || '900', 10),
  AI_GROUP_CONTEXT_MESSAGES: parseInt(process.env.AI_GROUP_CONTEXT_MESSAGES || '6', 10),
  AI_GROUP_CONTEXT_MAX_CHARS: parseInt(process.env.AI_GROUP_CONTEXT_MAX_CHARS || '3000', 10),
  AI_GROUP_CONTEXT_TTL: parseInt(process.env.AI_GROUP_CONTEXT_TTL || '300', 10),
  AI_RUNTIME_CACHE_MAX: parseInt(process.env.AI_RUNTIME_CACHE_MAX || '1000', 10),
  AI_MEMORY_ENABLE: String(process.env.AI_MEMORY_ENABLE || 'true').toLowerCase() === 'true',
  AI_MEMORY_DIR: process.env.AI_MEMORY_DIR || 'memory_data',
  AI_MEMORY_RETENTION_DAYS: parseInt(process.env.AI_MEMORY_RETENTION_DAYS || '14', 10),
  AI_MEMORY_PROFILE_CACHE_TTL: parseInt(process.env.AI_MEMORY_PROFILE_CACHE_TTL || '1800', 10),
  AI_MEMORY_PROFILE_CACHE_MAX: parseInt(process.env.AI_MEMORY_PROFILE_CACHE_MAX || '500', 10),
  AI_MEMORY_MESSAGE_MAX_CHARS: parseInt(process.env.AI_MEMORY_MESSAGE_MAX_CHARS || '1000', 10),
  AI_MEMORY_DAILY_MAX_MESSAGES: parseInt(process.env.AI_MEMORY_DAILY_MAX_MESSAGES || '300', 10),
  AI_MEMORY_DAILY_MAX_CHARS: parseInt(process.env.AI_MEMORY_DAILY_MAX_CHARS || '30000', 10),
  AI_MEMORY_GROUP_DAILY_MAX_MESSAGES: parseInt(process.env.AI_MEMORY_GROUP_DAILY_MAX_MESSAGES || '500', 10),
  AI_MEMORY_GROUP_DAILY_MAX_CHARS: parseInt(process.env.AI_MEMORY_GROUP_DAILY_MAX_CHARS || '50000', 10),
  AI_MEMORY_CONTEXT_MAX_CHARS: parseInt(process.env.AI_MEMORY_CONTEXT_MAX_CHARS || '1200', 10),
  AI_MEMORY_DEDUPE_TTL: parseInt(process.env.AI_MEMORY_DEDUPE_TTL || '3600', 10),
  AI_MEMORY_DEDUPE_MAX: parseInt(process.env.AI_MEMORY_DEDUPE_MAX || '5000', 10),
  AI_MEMORY_RETRY_BASE_SECONDS: parseInt(process.env.AI_MEMORY_RETRY_BASE_SECONDS || '3600', 10),
  AI_MEMORY_MAX_RETRIES: parseInt(process.env.AI_MEMORY_MAX_RETRIES || '3', 10),
  AI_MEMORY_SUMMARY_HOUR: parseInt(process.env.AI_MEMORY_SUMMARY_HOUR || '4', 10),
  AI_BAN_DURATION: parseInt(process.env.AI_BAN_DURATION || '600', 10),
  AI_MOD_ENABLE: String(process.env.AI_MOD_ENABLE || 'true').toLowerCase() === 'true',
  AI_IMAGE_CONTEXT_TTL: parseInt(process.env.AI_IMAGE_CONTEXT_TTL || '60', 10),
  AI_IMAGE_CONTEXT_MODE: (process.env.AI_IMAGE_CONTEXT_MODE || 'rule').toLowerCase(),
  AI_IMAGE_CONTEXT_REQUIRE_HINTS: String(process.env.AI_IMAGE_CONTEXT_REQUIRE_HINTS || 'true').toLowerCase() === 'true',
  AI_IMAGE_CONTEXT_REQUIRE_SAME_USER: String(process.env.AI_IMAGE_CONTEXT_REQUIRE_SAME_USER || 'true').toLowerCase() === 'true',
  AI_IMAGE_HINT_REGEX: process.env.AI_IMAGE_HINT_REGEX ? new RegExp(process.env.AI_IMAGE_HINT_REGEX, 'i') : /(上图|这个图|这图|这张图|这个图片|这张图片|图中|这幅图|图片里|表情包|这个表情|那张图|刚才的图|刚发的图|刚发的表情|上一条)/i,
  AI_IMAGE_CONTEXT_MAX: parseInt(process.env.AI_IMAGE_CONTEXT_MAX || '3', 10),
  AI_IMAGE_ONLY_NO_CALL: String(process.env.AI_IMAGE_ONLY_NO_CALL || 'true').toLowerCase() === 'true',
  AI_IMAGE_PREPROCESS_ENABLE: String(process.env.AI_IMAGE_PREPROCESS_ENABLE || 'true').toLowerCase() === 'true',
  AI_IMAGE_CACHE_ENABLE: String(process.env.AI_IMAGE_CACHE_ENABLE || 'true').toLowerCase() === 'true',
  AI_IMAGE_CACHE_TTL: parseInt(process.env.AI_IMAGE_CACHE_TTL || '1800', 10),
  AI_IMAGE_PREPROCESS_MAX_EDGE: parseInt(process.env.AI_IMAGE_PREPROCESS_MAX_EDGE || '1568', 10),
  AI_IMAGE_PREPROCESS_SCREEN_MAX_EDGE: parseInt(process.env.AI_IMAGE_PREPROCESS_SCREEN_MAX_EDGE || '1400', 10),
  AI_IMAGE_PREPROCESS_LONG_MAX_EDGE: parseInt(process.env.AI_IMAGE_PREPROCESS_LONG_MAX_EDGE || '1080', 10),
  AI_IMAGE_PREPROCESS_JPEG_QUALITY: parseInt(process.env.AI_IMAGE_PREPROCESS_JPEG_QUALITY || '82', 10),
  AI_IMAGE_PREPROCESS_WEBP_QUALITY: parseInt(process.env.AI_IMAGE_PREPROCESS_WEBP_QUALITY || '86', 10),
  AI_OCR_ENABLE: String(process.env.AI_OCR_ENABLE || 'true').toLowerCase() === 'true',
  AI_OCR_LANG: process.env.AI_OCR_LANG || 'eng+jpn+chi_sim',
  AI_OCR_TIMEOUT_MS: parseInt(process.env.AI_OCR_TIMEOUT_MS || '45000', 10),
  AI_OCR_CACHE_ENABLE: String(process.env.AI_OCR_CACHE_ENABLE || 'true').toLowerCase() === 'true',
  AI_OCR_CACHE_TTL: parseInt(process.env.AI_OCR_CACHE_TTL || '1800', 10),
  AI_OCR_MAX_CHARS: parseInt(process.env.AI_OCR_MAX_CHARS || '3000', 10),
  AI_OCR_TRIGGER_REGEX: process.env.AI_OCR_TRIGGER_REGEX ? new RegExp(process.env.AI_OCR_TRIGGER_REGEX, 'i') : /(写了什么|文字|识别|ocr|翻译|读图|内容|标题|地名|地图|哪个|哪一个|都道府县|县市|是什么字)/i,
  AI_OCR_ONLY_TEXT_REGEX: process.env.AI_OCR_ONLY_TEXT_REGEX ? new RegExp(process.env.AI_OCR_ONLY_TEXT_REGEX, 'i') : /(写了什么|提取.*文字|识别.*文字|ocr|翻译|读出|图中.*字|图片.*字|截图.*字)/i,
  AI_OCR_MIN_TEXT_LENGTH: parseInt(process.env.AI_OCR_MIN_TEXT_LENGTH || '12', 10),
  BANNED_PATH: path.join(PROJECT_ROOT, 'banned.json')
}
