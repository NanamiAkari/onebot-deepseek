function createAgentRunner(deps) {
  const { toolRegistry, toolExecutor, invokeModel, invokeModelWithToolResult, maxSteps = 5 } = deps

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

  function buildToolBudgets(tools) {
    const budgets = new Map()
    for (const tool of tools || []) {
      if (!tool || !tool.name) continue
      budgets.set(tool.name, 1)
    }
    return budgets
  }

  async function run(input) {
    const tools = toolRegistry ? toolRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    })) : []

    const agentInput = {
      message: input.message || '',
      media: Array.isArray(input.media) ? input.media : [],
      history: Array.isArray(input.history) ? input.history : [],
      contextImage: Boolean(input.contextImage),
      session: input.session || null,
      runtime: input.runtime || null,
      toolResults: [],
      tools
    }

    const executedToolCalls = []
    let finalText = ''
    const toolBudgets = buildToolBudgets(agentInput.tools)

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

      const currentCall = output.toolCalls[0]
      const usedCount = executedToolCalls.filter((x) => x.name === currentCall.name).length
      const toolBudget = toolBudgets.get(currentCall.name)
      if (typeof toolBudget === 'number' && usedCount >= toolBudget) {
        console.log(`Agent step ${step + 1}/${maxSteps}: 工具 ${currentCall.name} 已达到调用上限，跳过该工具并继续让模型回答`)
        const toolEntry = {
          id: currentCall.id || currentCall.name,
          name: currentCall.name,
          arguments: currentCall.arguments || {},
          ok: false,
          data: null,
          error: `${currentCall.name} 工具已超限，请直接基于现有上下文回答，不要继续调用该工具`
        }
        executedToolCalls.push(toolEntry)
        agentInput.toolResults = executedToolCalls.slice()
        agentInput.history = agentInput.history.concat([
          { role: 'system', content: formatToolResultForHistory(toolEntry) }
        ])
        agentInput.tools = agentInput.tools.filter((tool) => tool.name !== currentCall.name)
        continue
      }
      console.log(`Agent step ${step + 1}/${maxSteps}: 调用工具 ${currentCall.name} args=${summarizeArguments(currentCall.arguments || {})}`)
      const toolResult = await toolExecutor.execute(currentCall.name, currentCall.arguments || {}, agentInput.runtime || {})
      const toolEntry = {
        id: currentCall.id || currentCall.name,
        name: currentCall.name,
        arguments: currentCall.arguments || {},
        ok: Boolean(toolResult && toolResult.ok),
        data: toolResult && Object.prototype.hasOwnProperty.call(toolResult, 'data') ? toolResult.data : null,
        error: toolResult && toolResult.error ? String(toolResult.error) : ''
      }
      console.log(`Agent step ${step + 1}/${maxSteps}: 工具 ${currentCall.name} ${toolEntry.ok ? '成功' : '失败'}`)

      executedToolCalls.push(toolEntry)
      agentInput.toolResults = executedToolCalls.slice()
      agentInput.history = agentInput.history.concat([
        { role: 'system', content: formatToolResultForHistory(toolEntry) }
      ])
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
