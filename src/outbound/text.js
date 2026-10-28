// 出站文本处理：模型输出在发到 QQ 之前统一走这里。
//   · sanitizeModelText：去掉思考标签和 Markdown 语法（QQ 不渲染 Markdown）
//   · escapeCqText：把 “[CQ:” 换成全角冒号，避免文本被协议端当成 CQ 码执行
//   · splitForQQ：按长度分条，切点落在 emoji 代理对中间时自动修正

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

function escapeCqText(value) {
  return String(value ?? '').replace(/\[CQ:/gi, '[CQ：')
}

function sanitizeModelText(value) {
  let t = String(value || '')
  // 思考标签：成对的整段删除，未闭合的从标签处删到结尾（宁可少说，不泄露内心戏）。
  t = t.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
  t = t.replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, '')
  t = t.replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '')
  t = t.replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/gi, '')
  t = t.replace(/<analysis\b[^>]*>[\s\S]*$/gi, '')
  t = t.replace(/<reasoning\b[^>]*>[\s\S]*$/gi, '')
  // Markdown → 纯文本
  t = t.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, _lang, body) => `${body}\n`)
  t = t.replace(/`([^`]*)`/g, '$1')
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '$1')
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s{0,3}>\s?/gm, '')
  t = t.replace(/^\s*([-*+]|(\d+[\.\)]))\s+/gm, '')
  t = t.replace(/\*\*([\s\S]*?)\*\*/g, '$1')
  t = t.replace(/\*([\s\S]*?)\*/g, '$1')
  t = t.replace(/~~([^~]+)~~/g, '$1')
  // LaTeX 定界符：保留公式本体
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

// 按长度切分，优先在换行处断开。切点正好落在代理对中间时把切点前移一个码元，
// 否则 emoji / 生僻字会被切成半个字符，在群里显示成乱码。
function splitForQQ(value, max = 4000) {
  const text = String(value ?? '').replace(/\r/g, '').trim()
  const limit = Math.max(1, Math.floor(Number(max) || 4000))
  if (!text) return []
  if (text.length <= limit) return [text]
  const parts = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    if (cut > 0 && cut < rest.length && isHighSurrogate(rest.charCodeAt(cut - 1)) && isLowSurrogate(rest.charCodeAt(cut))) {
      cut -= 1
    }
    if (cut <= 0) {
      const first = rest.charCodeAt(0)
      const second = rest.charCodeAt(1)
      cut = isHighSurrogate(first) && isLowSurrogate(second) ? 2 : 1
    }
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

module.exports = { escapeCqText, sanitizeModelText, splitForQQ }
