function createAgentRunner(deps) {
  const { toolRegistry, toolExecutor, invokeModel, invokeModelWithToolResult, maxSteps = 5 } = deps

  function compactToolData(value, maxChars = 12000) {
    if (value == null) return value
    if (typeof value === 'string') return value.length > maxChars ? `${value.slice(0, maxChars)}…[结果已截断]` : value
    let serialized = ''
    try { serialized = JSON.stringify(value) } catch { return '[工具结果不可序列化]' }
    if (serialized.length <= maxChars) return value
    if (Array.isArray(value)) {
      const items = []
      for (const item of value) {
        const candidate = items.concat([item])
        if (JSON.stringify(candidate).length > maxChars - 80) break
        items.push(item)
      }
      return { items, truncated: true, omitted: Math.max(0, value.length - items.length) }
    }
    if (typeof value === 'object') {
      const output = {}
      const keys = Object.keys(value).sort((a, b) => {
        const metadata = new Set(['scan_truncated', 'instruction', 'truncated', 'omitted'])
        return Number(metadata.has(b)) - Number(metadata.has(a))
      })
      for (const key of keys) {
        const candidate = value[key]
        const next = Array.isArray(candidate)
          ? compactToolData(candidate, Math.max(200, Math.floor(maxChars * 0.85)))
          : typeof candidate === 'string' && candidate.length > 2000
          ? `${candidate.slice(0, 2000)}…[字段已截断]`
          : candidate
        output[key] = next
        try {
          if (JSON.stringify(output).length > maxChars - 80) {
            delete output[key]
            output[key] = '[字段已截断]'
          }
        } catch {
          output[key] = '[字段不可序列化]'
        }
      }
      output.truncated = true
      return output
    }
    return { preview: serialized.slice(0, Math.max(0, maxChars - 80)), truncated: true }
  }

  function normalizeModelOutput(output) {
    if (!output) return { text: '', toolCalls: [] }
    if (typeof output === 'string') return { text: output, toolCalls: [] }
    return {
      text: output.text ? String(output.text) : '',
      toolCalls: Array.isArray(output.toolCalls) ? output.toolCalls : []
    }
  }

  function formatToolResultForHistory(toolCall) {
    const payload = toolCall.ok
      ? { ok: true, data: toolCall.data }
      : { ok: false, error: toolCall.error }
    return `工具 ${toolCall.name} 调用结果：${JSON.stringify(payload).slice(0, 1500)}`
  }

  function summarizeArguments(args) {
    try {
      const text = JSON.stringify(args || {})
      return text.length > 300 ? `${text.slice(0, 300)}...` : text
    } catch {
      return '[unserializable arguments]'
    }
  }

  function stableSerialize(value) {
    if (value === null || typeof value !== 'object') {
      try { return JSON.stringify(value) } catch { return String(value) }
    }
    if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
  }

  function toolCallKey(toolCall) {
    return `${String(toolCall && toolCall.name || '')}:${stableSerialize(toolCall && toolCall.arguments || {})}`
  }

  function buildToolBudgets(tools) {
    const budgets = new Map()
    const limits = {
      web_search: 2,
      web_fetch: 2,
      list_stickers: 2,
      collect_sticker: 1,
      annotate_sticker: 1,
      send_sticker: 1
    }
    for (const tool of tools || []) {
      if (!tool || !tool.name) continue
      budgets.set(tool.name, limits[tool.name] || 1)
    }
    return budgets
  }

  async function run(input) {
    const tools = toolRegistry ? toolRegistry.list().filter((tool) => !toolExecutor || typeof toolExecutor.isAllowed !== 'function' || toolExecutor.isAllowed(tool.name, input.runtime || {})).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    })) : []

    const agentInput = {
      message: input.message || '',
      media: Array.isArray(input.media) ? input.media : [],
      history: Array.isArray(input.history) ? input.history : [],
      contextImage: Boolean(input.contextImage),
      memoryContext: String(input.memoryContext || ''),
      session: input.session || null,
      runtime: input.runtime || null,
      toolResults: [],
      tools
    }

    const executedToolCalls = []
    let finalText = ''
    const toolBudgets = buildToolBudgets(agentInput.tools)
    const executionCounts = new Map()
    const completedCalls = new Map()
    const inFlightCalls = new Map()

    function copyToolEntry(entry, call, batchId, deduplicated = false) {
      return {
        ...entry,
        id: call.id || call.name,
        name: call.name,
        arguments: call.arguments || {},
        batchId,
        ...(deduplicated ? { deduplicated: true } : {})
      }
    }

    function skippedToolEntry(call, error, batchId) {
      return {
        id: call.id || call.name,
        name: call.name,
        arguments: call.arguments || {},
        batchId,
        ok: false,
        data: null,
        error
      }
    }

    async function executeToolCall(call, batchId) {
      const key = toolCallKey(call)
      const completed = completedCalls.get(key)
      if (completed) return copyToolEntry(completed, call, batchId, true)
      const inFlight = inFlightCalls.get(key)
      if (inFlight) return copyToolEntry(await inFlight, call, batchId, true)

      const usedCount = executionCounts.get(call.name) || 0
      const toolBudget = toolBudgets.get(call.name)
      if (typeof toolBudget === 'number' && usedCount >= toolBudget) {
        return skippedToolEntry(call, `${call.name} 工具已超限，请直接基于现有上下文回答，不要继续调用该工具`, batchId)
      }
      executionCounts.set(call.name, usedCount + 1)

      const promise = (async () => {
        console.log(`Agent step ${batchId}: 调用工具 ${call.name} args=${summarizeArguments(call.arguments || {})}`)
        const toolResult = await toolExecutor.execute(call.name, call.arguments || {}, agentInput.runtime || {})
        const toolEntry = {
          id: call.id || call.name,
          name: call.name,
          arguments: call.arguments || {},
          batchId,
          ok: Boolean(toolResult && toolResult.ok),
          data: toolResult && Object.prototype.hasOwnProperty.call(toolResult, 'data') ? compactToolData(toolResult.data) : null,
          error: toolResult && toolResult.error ? String(toolResult.error) : ''
        }
        console.log(`Agent step ${batchId}: 工具 ${call.name} ${toolEntry.ok ? '成功' : '失败'}`)
        completedCalls.set(key, toolEntry)
        return toolEntry
      })()
      inFlightCalls.set(key, promise)
      try {
        return await promise
      } finally {
        if (inFlightCalls.get(key) === promise) inFlightCalls.delete(key)
      }
    }

    function removeExhaustedTools() {
      agentInput.tools = agentInput.tools.filter((tool) => {
        const budget = toolBudgets.get(tool.name)
        return typeof budget !== 'number' || (executionCounts.get(tool.name) || 0) < budget
      })
    }

    for (let step = 0; step < maxSteps; step += 1) {
      console.log(`Agent step ${step + 1}/${maxSteps}: 调用模型`)
      const output = normalizeModelOutput(
        step === 0 || !invokeModelWithToolResult
          ? await invokeModel(agentInput)
          : await invokeModelWithToolResult(agentInput, {
              latest: executedToolCalls[executedToolCalls.length - 1] || null,
              all: executedToolCalls.slice()
            })
      )

      if (!output.toolCalls.length || !toolExecutor) {
        return {
          text: output.text || finalText,
          toolCalls: executedToolCalls,
          steps: step + 1,
          stoppedReason: 'final'
        }
      }

      if (output.text) finalText = output.text

      const calls = output.toolCalls.filter((call) => call && call.name)
      const batchId = `${step + 1}/${maxSteps}`
      const canParallelize = calls.length > 1
        && typeof toolExecutor.isReadOnly === 'function'
        && calls.every((call) => toolExecutor.isReadOnly(call.name, call.arguments || {}))
      console.log(`Agent ${batchId}: ${canParallelize ? '并行执行' : '顺序执行'} ${calls.length} 个工具调用`)
      const toolEntries = canParallelize
        ? await Promise.all(calls.map((call) => executeToolCall(call, batchId)))
        : await calls.reduce(async (promise, call) => {
            const entries = await promise
            entries.push(await executeToolCall(call, batchId))
            return entries
          }, Promise.resolve([]))

      executedToolCalls.push(...toolEntries)
      agentInput.toolResults = executedToolCalls.slice()
      removeExhaustedTools()
    }

    return {
      text: finalText || '工具调用步数已达上限，请简化问题后重试',
      toolCalls: executedToolCalls,
      steps: maxSteps,
      stoppedReason: 'max_steps'
    }
  }

  return { run }
}

module.exports = { createAgentRunner }
