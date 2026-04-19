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
  PREFIXES: (process.env.AI_PREFIXES || '/ai').split(',').map((s) => s.trim()).filter(Boolean),
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
  AI_POKE_ENABLE: String(process.env.AI_POKE_ENABLE || 'true').toLowerCase() === 'true',
  AI_POKE_COOLDOWN: parseInt(process.env.AI_POKE_COOLDOWN || '10', 10),
  AI_POKE_REPLY_TEXT: process.env.AI_POKE_REPLY_TEXT || '拍了拍',
  AI_CONTEXT_ENABLE: String(process.env.AI_CONTEXT_ENABLE || 'true').toLowerCase() === 'true',
  AI_CONTEXT_WINDOW: parseInt(process.env.AI_CONTEXT_WINDOW || '6', 10),
  AI_CONTEXT_TTL: parseInt(process.env.AI_CONTEXT_TTL || '900', 10),
  AI_BAN_DURATION: parseInt(process.env.AI_BAN_DURATION || '600', 10),
  AI_MOD_ENABLE: String(process.env.AI_MOD_ENABLE || 'true').toLowerCase() === 'true',
  AI_IMAGE_CONTEXT_TTL: parseInt(process.env.AI_IMAGE_CONTEXT_TTL || '60', 10),
  AI_IMAGE_CONTEXT_MODE: (process.env.AI_IMAGE_CONTEXT_MODE || 'rule').toLowerCase(),
  AI_IMAGE_CONTEXT_REQUIRE_HINTS: String(process.env.AI_IMAGE_CONTEXT_REQUIRE_HINTS || 'true').toLowerCase() === 'true',
  AI_IMAGE_CONTEXT_REQUIRE_SAME_USER: String(process.env.AI_IMAGE_CONTEXT_REQUIRE_SAME_USER || 'true').toLowerCase() === 'true',
  AI_IMAGE_HINT_REGEX: process.env.AI_IMAGE_HINT_REGEX ? new RegExp(process.env.AI_IMAGE_HINT_REGEX, 'i') : /(上图|这个图|这图|这张图|这个图片|这张图片|图中|这幅图|图片里)/i,
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
