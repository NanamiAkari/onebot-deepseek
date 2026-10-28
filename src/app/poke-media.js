// 拍一拍图片路径的“可搬移”处理。
//
// 历史实现把 /opt/onebot-deepseek/poke_media/xxx.jpg 这样的绝对路径写进
// poke_replies.json。换部署目录或把项目拷到本机后，这些路径全部失效，
// 拍一拍图片就发不出去了。
//
// 约定：
//   · 落盘时写成 poke_media/<文件名>（相对项目根）；
//   · 读取时先认相对路径；文件不在就按文件名在 poke_media 里找回（搬家自愈）；
//   · 非本地来源（http/data/base64）原样保留。

const fs = require('fs')
const path = require('path')

const PREFIX = 'poke_media/'

function toLocalPath(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (/^file:\/\//i.test(text)) {
    try {
      return decodeURIComponent(text.replace(/^file:\/\//i, ''))
    } catch {
      return ''
    }
  }
  if (/^[\\/]/.test(text) || /^[a-zA-Z]:[\\/]/.test(text)) return text
  return ''
}

function isInside(target, dir) {
  const resolved = path.resolve(target)
  const root = path.resolve(dir)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

function fileExists(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

function healByBasename(filePath, dir) {
  const base = path.basename(String(filePath || ''))
  if (!base || base === '.' || base === '..') return ''
  const candidate = path.join(dir, base)
  return fileExists(candidate) ? candidate : ''
}

function portablePokeSource(source, options = {}) {
  const value = String(source || '').trim()
  if (!value) return ''
  const dir = path.resolve(options.dir)
  const localPath = toLocalPath(value)
  if (!localPath) return value
  const resolved = path.resolve(localPath)
  if (!isInside(resolved, dir)) return value
  return `${PREFIX}${path.basename(resolved)}`
}

function resolvePokeSource(source, options = {}) {
  const value = String(source || '').trim()
  if (!value) return ''
  const dir = path.resolve(options.dir)
  const projectRoot = path.resolve(options.projectRoot || path.dirname(dir))
  if (value.startsWith(PREFIX) || value.startsWith('poke_media\\')) {
    const relative = value.replace(/\\/g, '/')
    const candidate = path.resolve(projectRoot, relative)
    if (isInside(candidate, dir) && fileExists(candidate)) return candidate
    return healByBasename(relative, dir) || value
  }
  const localPath = toLocalPath(value)
  if (!localPath) return value
  const resolved = path.resolve(localPath)
  if (fileExists(resolved)) return resolved
  return healByBasename(resolved, dir) || value
}

module.exports = { portablePokeSource, resolvePokeSource, PREFIX }
