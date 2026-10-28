const fs = require('fs')
const path = require('path')

function pad2(value) {
  return String(value).padStart(2, '0')
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function emptyState(date) {
  return {
    date,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    byModel: {},
    updatedAt: 0
  }
}

// token 用量按天累计到一个 JSON 文件里。
// 只记数字，不记消息内容、群号和用户身份；写失败只记一次日志，不能影响回复。
function createUsageTracker(options = {}) {
  const dir = options.dir ? String(options.dir) : ''
  const enabled = options.enabled !== false && Boolean(dir)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const priceInputPer1M = Math.max(0, Number(options.priceInputPer1M) || 0)
  const priceOutputPer1M = Math.max(0, Number(options.priceOutputPer1M) || 0)
  const maxModels = Math.max(10, Math.min(500, Number(options.maxModels) || 100))
  const log = typeof options.log === 'function' ? options.log : () => {}
  let state = null
  let warned = false

  function fileFor(date) {
    return path.join(dir, `usage-${date}.json`)
  }

  function load(date) {
    const fresh = emptyState(date)
    try {
      const raw = JSON.parse(fs.readFileSync(fileFor(date), 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fresh
      return {
        ...fresh,
        ...raw,
        date,
        byModel: raw.byModel && typeof raw.byModel === 'object' && !Array.isArray(raw.byModel) ? raw.byModel : {}
      }
    } catch {
      return fresh
    }
  }

  function ensure() {
    const date = localDateKey(new Date(now()))
    if (state && state.date === date) return state
    state = load(date)
    return state
  }

  function persist(value) {
    if (!enabled) return
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const target = fileFor(value.date)
      const temporary = `${target}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporary, target)
    } catch (error) {
      if (warned) return
      warned = true
      log(`用量统计写入失败：${error && error.message ? error.message : error}`)
    }
  }

  function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null
    const promptTokens = Math.max(0, Math.floor(Number(usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens) || 0))
    const completionTokens = Math.max(0, Math.floor(Number(usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens) || 0))
    const totalTokens = Math.max(0, Math.floor(Number(usage.totalTokens ?? usage.total_tokens) || (promptTokens + completionTokens)))
    const reasoningTokens = Math.max(0, Math.floor(Number(usage.reasoningTokens ?? usage.reasoning_tokens) || 0))
    if (!promptTokens && !completionTokens && !totalTokens) return null
    return { promptTokens, completionTokens, totalTokens, reasoningTokens }
  }

  function record(usage, meta = {}) {
    if (!enabled) return null
    const normalized = normalizeUsage(usage)
    if (!normalized) return null
    const current = ensure()
    current.calls += 1
    current.promptTokens += normalized.promptTokens
    current.completionTokens += normalized.completionTokens
    current.totalTokens += normalized.totalTokens
    current.reasoningTokens += normalized.reasoningTokens
    const model = String(meta.model || 'unknown').slice(0, 80)
    let bucketKey = model
    if (!current.byModel[bucketKey] && Object.keys(current.byModel).length >= maxModels) bucketKey = 'other'
    const bucket = current.byModel[bucketKey] || (current.byModel[bucketKey] = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    bucket.calls += 1
    bucket.promptTokens += normalized.promptTokens
    bucket.completionTokens += normalized.completionTokens
    bucket.totalTokens += normalized.totalTokens
    current.updatedAt = now()
    persist(current)
    return normalized
  }

  function costOf(value) {
    const prompt = Number(value && value.promptTokens) || 0
    const completion = Number(value && value.completionTokens) || 0
    if (!priceInputPer1M && !priceOutputPer1M) return 0
    return (prompt / 1e6) * priceInputPer1M + (completion / 1e6) * priceOutputPer1M
  }

  function summary() {
    const current = ensure()
    return { ...current, cost: Number(costOf(current).toFixed(6)) }
  }

  function reset() {
    state = null
  }

  return { enabled, record, summary, costOf, reset, dateKey: () => ensure().date }
}

module.exports = { createUsageTracker, localDateKey }
