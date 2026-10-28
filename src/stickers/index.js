const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function cleanText(value, maxChars) {
  return String(value ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', mime: 'image/png' }
  const header = buffer.subarray(0, 12).toString('ascii')
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return { ext: '.gif', mime: 'image/gif' }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' }
  if (header.slice(4, 12) === 'ftypavif') return { ext: '.avif', mime: 'image/avif' }
  return null
}

function normalizeTags(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, 40))
    .filter(Boolean))).slice(0, 20)
}

function createStickerStore(options = {}) {
  const enabled = options.enabled !== false
  const rootDir = path.resolve(String(options.rootDir || 'sticker_data'))
  const imagesDir = path.join(rootDir, 'images')
  const indexFile = path.join(rootDir, 'stickers.json')
  const maxBytes = Math.max(64 * 1024, Math.min(20 * 1024 * 1024, Number(options.maxBytes) || 10 * 1024 * 1024))
  const maxCount = Math.max(1, Math.min(10000, Number(options.maxCount) || 1000))
  const maxCollectPerHour = Math.max(1, Math.min(100, Number(options.maxCollectPerHour) || 10))
  let entries = null
  let collectTimes = []

  function ensureDirectory(directory) {
    try {
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Sticker directory is not safe')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Sticker directory is not safe')
    }
  }

  function ensureRoot() {
    ensureDirectory(rootDir)
    ensureDirectory(imagesDir)
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null
    const id = cleanText(raw.id, 80)
    const file = cleanText(raw.file, 200).replace(/\\/g, '/')
    if (!/^st_[a-f0-9]{16,32}$/i.test(id)) return null
    if (!/^images\/st_[a-f0-9]{16,32}\.(?:jpg|png|gif|webp|avif)$/i.test(file)) return null
    const contentHash = cleanText(raw.contentHash, 64).toLowerCase()
    return {
      id,
      file,
      // 图片字节的 sha256：同一张图从不同消息收藏时据此去重。
      contentHash: /^[a-f0-9]{64}$/.test(contentHash) ? contentHash : '',
      note: cleanText(raw.note, 240),
      tags: normalizeTags(raw.tags),
      usage: cleanText(raw.usage, 300),
      useCount: Math.max(0, Math.floor(Number(raw.useCount) || 0)),
      lastUsedAt: Math.max(0, Number(raw.lastUsedAt) || 0),
      createdAt: Math.max(0, Number(raw.createdAt) || Date.now()),
      updatedAt: Math.max(0, Number(raw.updatedAt) || Date.now())
    }
  }

  function load() {
    if (Array.isArray(entries)) return entries
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      entries = (Array.isArray(parsed) ? parsed : []).map(normalizeEntry).filter(Boolean).slice(0, maxCount)
    } catch {
      entries = []
    }
    return entries
  }

  function save() {
    ensureRoot()
    const temporary = `${indexFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(load(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, indexFile)
  }

  function publicEntry(entry) {
    return {
      id: entry.id,
      note: entry.note,
      tags: entry.tags.slice(),
      usage: entry.usage,
      useCount: entry.useCount,
      lastUsedAt: entry.lastUsedAt || null
    }
  }

  function list(query = '', limit = 24) {
    if (!enabled) throw new Error('表情库未启用')
    const normalizedQuery = cleanText(query, 100).toLowerCase()
    const max = Math.max(1, Math.min(100, Number(limit) || 24))
    const all = load().slice().sort((left, right) =>
      (right.useCount || 0) - (left.useCount || 0)
      || (right.lastUsedAt || 0) - (left.lastUsedAt || 0)
      || left.id.localeCompare(right.id))
    const matched = normalizedQuery
      ? all.filter((entry) => [entry.note, entry.usage, ...entry.tags].join(' ').toLowerCase().includes(normalizedQuery))
      : all
    return {
      total: all.length,
      matched: matched.length,
      truncated: matched.length > max,
      stickers: matched.slice(0, max).map(publicEntry),
      instruction: '这些只是可选表情。根据当前语气、关系和场合决定是否发送，不要每条都发；没有贴切表情时保持纯文字。'
    }
  }

  function get(id) {
    const normalized = cleanText(id, 80)
    return load().find((entry) => entry.id === normalized) || null
  }

  function annotate(id, patch = {}) {
    const entry = get(id)
    if (!entry) return null
    if (patch.note !== undefined) entry.note = cleanText(patch.note, 240)
    if (patch.tags !== undefined) entry.tags = normalizeTags(patch.tags)
    if (patch.usage !== undefined) entry.usage = cleanText(patch.usage, 300)
    entry.updatedAt = Date.now()
    save()
    return publicEntry(entry)
  }

  function writeImage(id, buffer, extension) {
    ensureRoot()
    const destination = path.join(imagesDir, `${id}${extension}`)
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temporary, buffer, { mode: 0o600 })
    fs.renameSync(temporary, destination)
    return `images/${id}${extension}`
  }

  async function collect({ key, note, tags, usage, getBytes } = {}) {
    if (!enabled) throw new Error('表情库未启用')
    if (typeof getBytes !== 'function') throw new Error('缺少图片读取方式')
    const now = Date.now()
    collectTimes = collectTimes.filter((time) => now - time < 60 * 60 * 1000)
    const signature = cleanText(key, 500)
    if (!signature) throw new Error('缺少图片来源标识')
    const id = `st_${crypto.createHash('sha256').update(signature).digest('hex').slice(0, 20)}`
    const existing = get(id)
    if (!existing && load().length >= maxCount) throw new Error('表情库已满，请先整理已有表情')
    if (!existing && collectTimes.length >= maxCollectPerHour) throw new Error('收藏太频繁，请稍后再试')
    const buffer = await getBytes()
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('图片内容为空')
    if (buffer.length > maxBytes) throw new Error(`图片超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上限`)
    const type = detectImageType(buffer)
    if (!type) throw new Error('文件不是受支持的图片格式')
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
    if (existing) {
      const file = writeImage(id, buffer, type.ext)
      if (existing.file !== file) {
        const oldPath = path.join(rootDir, existing.file)
        try { fs.unlinkSync(oldPath) } catch {}
      }
      existing.file = file
      existing.contentHash = contentHash
      existing.note = cleanText(note || existing.note, 240)
      existing.tags = tags !== undefined ? normalizeTags(tags) : existing.tags
      existing.usage = usage !== undefined ? cleanText(usage, 300) : existing.usage
      existing.updatedAt = now
      save()
      return publicEntry(existing)
    }
    // 同一张图从不同消息收藏时，按内容哈希复用已有条目，不重复占库存。
    const duplicate = load().find((entry) => entry.contentHash && entry.contentHash === contentHash)
    if (duplicate) {
      if (note) duplicate.note = cleanText(note, 240)
      if (tags !== undefined) duplicate.tags = normalizeTags(tags)
      if (usage !== undefined) duplicate.usage = cleanText(usage, 300)
      duplicate.updatedAt = now
      save()
      return publicEntry(duplicate)
    }
    const file = writeImage(id, buffer, type.ext)
    const entry = {
      id,
      file,
      contentHash,
      note: cleanText(note, 240),
      tags: normalizeTags(tags),
      usage: cleanText(usage, 300),
      useCount: 0,
      lastUsedAt: 0,
      createdAt: now,
      updatedAt: now
    }
    load().push(entry)
    collectTimes.push(now)
    save()
    return publicEntry(entry)
  }

  function readForSend(id) {
    const entry = get(id)
    if (!entry) throw new Error('找不到这个表情')
    ensureRoot()
    const file = path.resolve(rootDir, entry.file)
    const relative = path.relative(imagesDir, file)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('表情文件路径不安全')
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) throw new Error('表情文件不可用')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    let buffer
    try {
      buffer = fs.readFileSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    const type = detectImageType(buffer)
    if (!type) throw new Error('表情文件格式已损坏')
    return { entry: publicEntry(entry), buffer, mime: type.mime, localPath: file }
  }

  function markUsed(id, context = '') {
    const entry = get(id)
    if (!entry) return null
    entry.useCount += 1
    entry.lastUsedAt = Date.now()
    entry.updatedAt = entry.lastUsedAt
    entry.lastContext = cleanText(context, 200)
    save()
    return publicEntry(entry)
  }

  return {
    available: () => enabled,
    list,
    get: (id) => {
      const entry = get(id)
      return entry ? publicEntry(entry) : null
    },
    annotate,
    collect,
    readForSend,
    markUsed
  }
}

module.exports = { createStickerStore, detectImageType }
