// 内联工具调用兜底。
//
// 有些模型不返回原生 tool_calls，而是把调用写进正文：
//   <tool_call>{"name":"send_group_msg","arguments":{...}}</tool_call>
// 以前这段 JSON 会被当成普通回复发到群里。这里把它解析成真正的工具调用，
// 解析不了的协议残片也从正文里删掉，保证任何情况下都不外泄。

const BLOCK_RE = /<(tool_call|function_call)\b[^>]*>([\s\S]*?)<\/\1>/gi
const OPEN_TAG_RE = /<(?:tool_call|function_call)\b[^>]*>[\s\S]*$/i

function parseJson(value) {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const fn = payload.function && typeof payload.function === 'object' ? payload.function : null
  const name = String((fn && fn.name) || payload.name || payload.tool || payload.tool_name || '').trim()
  if (!name) return null
  let args = fn
    ? (fn.arguments ?? fn.parameters)
    : (payload.arguments ?? payload.args ?? payload.parameters ?? payload.input)
  if (typeof args === 'string') args = parseJson(args) ?? {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
  return { name, arguments: args }
}

/**
 * @param {string} text 模型正文
 * @param {Iterable<string>} knownNames 当前已注册的工具名
 * @returns {{ calls: Array<{name: string, arguments: object}>, cleanedText: string }}
 */
function parseInlineToolCalls(text, knownNames) {
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames || [])
  const body = String(text || '')
  if (!body.trim()) return { calls: [], cleanedText: body }
  const calls = []
  let cleaned = body.replace(BLOCK_RE, (_match, _tag, inner) => {
    const payload = normalizePayload(parseJson(inner))
    if (payload && known.has(payload.name)) calls.push(payload)
    return ' '
  })
  // 未闭合的标签：协议残片一律删除，不发给用户。
  cleaned = cleaned.replace(OPEN_TAG_RE, ' ')
  // 整段正文就是一个裸 JSON 调用（没有标签包裹）时也认。
  if (calls.length === 0) {
    const trimmed = cleaned.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const payload = normalizePayload(parseJson(trimmed))
      if (payload && known.has(payload.name)) {
        calls.push(payload)
        cleaned = ''
      }
    }
  }
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { calls, cleanedText: cleaned }
}

module.exports = { parseInlineToolCalls }
