const { toolBudget } = require('./tool-metadata')
const { createToolScheduler } = require('./tool-scheduler')
const { parseInlineToolCalls } = require('./inline-tools')

function createAgentRunner(deps) {
  const {
    toolRegistry,
    toolExecutor,
    invokeModel,
    invokeModelWithToolResult,
    maxSteps = 10,
    deadlineMs = 60000,
    parallelLimit = 4,
    // 同一个调用最多尝试几次：2 表示允许一次自动重试（只针对 retryable 失败）。
    maxAttemptsPerCall = 2
  } = deps

  const scheduler = createToolScheduler({
    maxParallel: parallelLimit,
    isReadOnly: (call) => Boolean(
      toolExecutor
      && typeof toolExecutor.isReadOnly === 'function'
      && toolExecutor.isReadOnly(call.name, call.arguments || {})
    )
  })

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
    if (!output) return { text: '', toolCalls: [], usage: null }
    if (typeof output === 'string') return { text: output, toolCalls: [], usage: null }
    return {
      text: output.text ? String(output.text) : '',
      toolCalls: Array.isArray(output.toolCalls) ? output.toolCalls : [],
      usage: output.usage && typeof output.usage === 'object' ? output.usage : null
    }
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

  async function run(input) {
    const startedAt = Date.now()
    const deadlineAt = deadlineMs > 0 ? startedAt + deadlineMs : 0
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
    // 内联解析只认已注册的工具名，避免把用户要求的 JSON 误当成调用。
    const knownToolNames = new Set(tools.map((tool) => tool.name))
    const budgetUsed = new Map()
    // 只有成功或确定性失败会进入 completedCalls；可重试失败和状态未知单独记录。
    const completedCalls = new Map()
    const failedCalls = new Map()
    const inFlightCalls = new Map()
    const metrics = {
      steps: 0,
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      inlineCalls: 0,
      toolCalls: 0,
      executed: 0,
      retried: 0,
      deduplicated: 0,
      skipped: 0,
      parallelWaves: 0,
      serialCalls: 0
    }

    function reportStopped(reason) {
      const tokens = metrics.totalTokens ? ` tokens=${metrics.promptTokens}+${metrics.completionTokens}` : ''
      console.log(`Agent 结束：${reason} steps=${metrics.steps}/${maxSteps} 模型=${metrics.modelCalls} 工具=${metrics.toolCalls} 执行=${metrics.executed} 重试=${metrics.retried} 去重=${metrics.deduplicated} 超限=${metrics.skipped} 并行波次=${metrics.parallelWaves}${tokens} 耗时=${Date.now() - startedAt}ms`)
    }

    function dedupeEntry(entry, call, batchId, note) {
      return {
        ...entry,
        id: call.id || entry.id || call.name,
        name: call.name,
        arguments: call.arguments || {},
        batchId,
        deduplicated: true,
        ...(note ? { note } : {})
      }
    }

    function skippedToolEntry(call, batchId) {
      // 超限只是不再执行，不对外输出任何“已达上限”的说法：
      // 结果照常回给模型（保证 tool_calls 协议完整），用户侧只看模型的最终文本。
      return {
        id: call.id || call.name,
        name: call.name,
        arguments: call.arguments || {},
        batchId,
        ok: false,
        data: null,
        error: '调用未执行',
        kind: 'fatal',
        skipped: true,
        note: '本轮不再执行这个调用；不要向用户提及工具次数、调用上限或跳过原因，直接基于已有信息回答'
      }
    }

    async function executeToolCall(call, batchId) {
      const key = toolCallKey(call)
      const completed = completedCalls.get(key)
      if (completed) return dedupeEntry(completed, call, batchId, '该调用本轮已执行过，结果同上，不要重复调用')

      const inFlight = inFlightCalls.get(key)
      if (inFlight) return dedupeEntry(await inFlight, call, batchId, '该调用本轮已执行过，结果同上，不要重复调用')

      const previousFailure = failedCalls.get(key)
      const attempts = previousFailure && previousFailure.attempts ? previousFailure.attempts : 0
      const retrying = Boolean(previousFailure && previousFailure.kind === 'retryable' && attempts < maxAttemptsPerCall)
      if (previousFailure && !retrying) {
        return dedupeEntry(previousFailure, call, batchId, previousFailure.kind === 'uncertain'
          ? '上次调用状态未知，可能已经生效，为避免重复已禁止重试'
          : '上次调用已失败且不会自动重试')
      }

      const budget = toolBudget(call.name, call.arguments || {})
      const used = budgetUsed.get(call.name) || 0
      if (!retrying && used >= budget) {
        return skippedToolEntry(call, batchId)
      }
      if (!retrying) budgetUsed.set(call.name, used + 1)

      const attempt = attempts + 1
      const promise = (async () => {
        const startedCallAt = Date.now()
        console.log(`Agent step ${batchId}: 调用工具 ${call.name}${attempt > 1 ? `（第${attempt}次尝试）` : ''} args=${summarizeArguments(call.arguments || {})}`)
        let toolResult
        try {
          toolResult = await toolExecutor.execute(call.name, call.arguments || {}, agentInput.runtime || {})
        } catch (error) {
          toolResult = { ok: false, error: error && error.message ? String(error.message) : '工具执行异常', kind: 'fatal' }
        }
        const entry = {
          id: call.id || call.name,
          name: call.name,
          arguments: call.arguments || {},
          batchId,
          ok: Boolean(toolResult && toolResult.ok),
          data: toolResult && Object.prototype.hasOwnProperty.call(toolResult, 'data') ? compactToolData(toolResult.data) : null,
          error: toolResult && toolResult.error ? String(toolResult.error) : '',
          kind: (toolResult && toolResult.kind) || (toolResult && toolResult.ok ? 'ok' : 'fatal'),
          durationMs: Date.now() - startedCallAt,
          attempts: attempt
        }
        if (entry.ok || entry.kind === 'fatal') {
          completedCalls.set(key, entry)
          failedCalls.delete(key)
        } else {
          failedCalls.set(key, entry)
        }
        console.log(`Agent step ${batchId}: 工具 ${call.name} ${entry.ok ? '成功' : `失败(${entry.kind})`} ${entry.durationMs}ms`)
        return entry
      })()
      inFlightCalls.set(key, promise)
      try {
        return await promise
      } finally {
        if (inFlightCalls.get(key) === promise) inFlightCalls.delete(key)
      }
    }

    function removeExhaustedTools() {
      agentInput.tools = agentInput.tools.filter((tool) => (budgetUsed.get(tool.name) || 0) < toolBudget(tool.name))
    }

    function finish(reason, text, steps) {
      metrics.steps = steps
      reportStopped(reason)
      return {
        text: text || '',
        toolCalls: executedToolCalls,
        steps,
        stoppedReason: reason,
        metrics: { ...metrics }
      }
    }

    let stallCount = 0
    for (let step = 0; step < maxSteps; step += 1) {
      if (deadlineAt && Date.now() >= deadlineAt) {
        // 不再用兜底话术替模型发言：有最终文本就发，没有就保持沉默。
        return finish('deadline', finalText, step)
      }
      console.log(`Agent step ${step + 1}/${maxSteps}: 调用模型`)
      const output = normalizeModelOutput(
        step === 0 || !invokeModelWithToolResult
          ? await invokeModel(agentInput)
          : await invokeModelWithToolResult(agentInput, {
              latest: executedToolCalls[executedToolCalls.length - 1] || null,
              all: executedToolCalls.slice()
            })
      )
      metrics.modelCalls += 1
      if (output.usage) {
        const prompt = Math.max(0, Number(output.usage.promptTokens ?? output.usage.prompt_tokens) || 0)
        const completion = Math.max(0, Number(output.usage.completionTokens ?? output.usage.completion_tokens) || 0)
        metrics.promptTokens += prompt
        metrics.completionTokens += completion
        metrics.totalTokens += Math.max(0, Number(output.usage.totalTokens ?? output.usage.total_tokens) || (prompt + completion))
      }

      // 少数模型会把工具调用写进正文；解析成真正的调用，并删掉协议残片。
      const inline = parseInlineToolCalls(output.text, knownToolNames)
      const cleanText = inline.cleanedText
      let calls = output.toolCalls.filter((call) => call && call.name)
      if (!calls.length && inline.calls.length && toolExecutor) {
        calls = inline.calls.map((call, index) => ({ id: `inline-${step + 1}-${index}`, name: call.name, arguments: call.arguments }))
        metrics.inlineCalls += calls.length
        console.log(`Agent step ${step + 1}: 从正文恢复 ${inline.calls.length} 个内联工具调用`)
      }
      if (!calls.length || !toolExecutor) {
        return finish('final', cleanText || finalText, step + 1)
      }

      if (cleanText) finalText = cleanText

      const batchId = `${step + 1}/${maxSteps}`
      const { entries, waves } = await scheduler.run(calls, (call) => executeToolCall(call, batchId), { batchId, deadlineAt })
      for (const wave of waves) {
        if (wave.parallel) metrics.parallelWaves += 1
        else metrics.serialCalls += wave.size
      }
      let productive = 0
      for (const entry of entries) {
        if (entry.deduplicated) metrics.deduplicated += 1
        else if (entry.skipped) metrics.skipped += 1
        else if (entry.attempts > 1) metrics.retried += 1
        else metrics.executed += 1
        if (!entry.deduplicated && !entry.skipped) productive += 1
      }
      metrics.toolCalls += entries.length
      executedToolCalls.push(...entries)
      agentInput.toolResults = executedToolCalls.slice()
      removeExhaustedTools()

      // 整批调用都被去重或超限跳过，说明模型在原地打转；连续两次就收尾，
      // 不再为重复调用多付一次模型请求。
      stallCount = productive === 0 ? stallCount + 1 : 0
      if (stallCount >= 2) {
        return finish('stalled', finalText, step + 1)
      }
    }

    return finish('max_steps', finalText, maxSteps)
  }

  return { run }
}

module.exports = { createAgentRunner }
