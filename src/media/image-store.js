// 图片字节读取与内容寻址落盘：拍一拍、表情库、视觉输入共用。
//
// 统一做三件事：
//   1. 从 base64 / data: / file:// / 本地路径 / http(s) 读字节；
//   2. 网络下载带 QQ 图床 Referer，并按字节上限提前截断；
//   3. 落盘前校验魔数与体积，用内容哈希命名（同一张图只存一份）。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const axios = require('axios')
const { detectImageType } = require('../stickers')

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15000
const GIF_STATIC_MAX_EDGE = 1024

let sharpModule = null
function loadSharp() {
  if (sharpModule !== null) return sharpModule || null
  try {
    // eslint-disable-next-line global-require
    sharpModule = require('sharp')
    return sharpModule
  } catch {
    sharpModule = false
    return null
  }
}

// QQ 表情包大多是 GIF，不少模型只会取第一帧，而第一帧经常是空白/纯白，
// 于是模型把表情描述成“白色小团子”。这里取中间帧转成静态 PNG 再发。
async function gifToStaticPng(buffer, options = {}) {
  const sharp = options.sharp || loadSharp()
  if (!sharp || !Buffer.isBuffer(buffer) || buffer.length === 0) return null
  const metadata = await sharp(buffer, { animated: true }).metadata().catch(() => null)
  const pages = Math.max(1, Number(metadata && metadata.pages) || 1)
  // 动图取中间帧，静态图/单帧就取第 0 帧。
  const page = pages > 1 ? Math.floor(pages / 2) : 0
  const maxEdge = Math.max(256, Math.min(2048, Number(options.maxEdge) || GIF_STATIC_MAX_EDGE))
  let pipeline = sharp(buffer, { page })
  if (metadata && (metadata.width > maxEdge || metadata.height > maxEdge)) {
    pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
  }
  const png = await pipeline.png().toBuffer()
  return png && png.length ? png : null
}

function detectMime(buffer, fallback = '') {
  const image = detectImageType(buffer)
  if (image) return image.mime
  if (Buffer.isBuffer(buffer) && buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  return fallback || 'application/octet-stream'
}

function qqReferer(src) {
  try {
    const host = new URL(src).hostname || ''
    if (/qpic\.cn$/i.test(host) || /gchat\.qpic\.cn$/i.test(host)) return 'https://gchat.qpic.cn'
    if (/qun\.qq\.com$/i.test(host)) return 'https://qun.qq.com'
  } catch {}
  return ''
}

async function readSourceBuffer(source, options = {}) {
  const value = String(source || '').trim()
  if (!value) return null
  const maxBytes = Math.max(0, Number(options.maxBytes) || 0)
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
  let buffer = null
  let mime = 'application/octet-stream'

  if (/^base64:\/\//i.test(value)) {
    buffer = Buffer.from(value.replace(/^base64:\/\//i, ''), 'base64')
    mime = detectMime(buffer, mime)
  } else if (/^data:/i.test(value)) {
    const comma = value.indexOf(',')
    if (comma <= 0) return null
    const head = value.slice(0, comma)
    const match = head.match(/^data:([^;]+)/i)
    mime = match ? match[1] : 'application/octet-stream'
    buffer = Buffer.from(value.slice(comma + 1), 'base64')
  } else if (/^file:\/\//i.test(value) || /^[\\/].+/.test(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    const filePath = /^file:\/\//i.test(value)
      ? decodeURIComponent(value.replace(/^file:\/\//i, ''))
      : decodeURIComponent(value)
    const stat = fs.statSync(filePath)
    if (maxBytes && stat.size > maxBytes) throw new Error('图片超过大小上限')
    buffer = fs.readFileSync(filePath)
    mime = detectMime(buffer, '')
  } else if (/^https?:\/\//i.test(value)) {
    const headers = { 'User-Agent': 'Mozilla/5.0' }
    const referer = String(options.referer || '') || qqReferer(value)
    if (referer) headers.Referer = referer
    const response = await axios.get(value, {
      responseType: 'arraybuffer',
      httpsAgent: options.httpsAgent,
      proxy: false,
      timeout: timeoutMs,
      headers,
      maxContentLength: maxBytes || -1,
      maxBodyLength: maxBytes || -1
    })
    buffer = Buffer.from(response.data)
    const contentType = (response.headers && response.headers['content-type']) || ''
    mime = detectMime(buffer, contentType.split(';')[0])
  } else {
    return null
  }

  if (!buffer || buffer.length === 0) return null
  if (maxBytes && buffer.length > maxBytes) throw new Error('图片超过大小上限')
  return { buf: buffer, mime }
}

function writeContentAddressedImage(directory, buffer, options = {}) {
  const dir = path.resolve(String(directory || ''))
  if (!dir) throw new Error('图片目录不可用')
  const rawMaxBytes = Number(options.maxBytes)
  const maxBytes = Number.isFinite(rawMaxBytes) && rawMaxBytes > 0 ? Math.floor(rawMaxBytes) : DEFAULT_MAX_BYTES
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('图片内容为空')
  if (buffer.length > maxBytes) throw new Error(`图片超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上限`)
  const type = detectImageType(buffer)
  if (!type) throw new Error('不是受支持的图片格式')
  const hash = crypto.createHash('sha1').update(buffer).digest('hex')
  const filePath = path.join(dir, `${hash}${type.ext}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!fs.existsSync(filePath)) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temporary, buffer, { mode: 0o600 })
    fs.renameSync(temporary, filePath)
  }
  return { path: filePath, hash, ext: type.ext, mime: type.mime, size: buffer.length }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  detectMime,
  gifToStaticPng,
  readSourceBuffer,
  writeContentAddressedImage
}
