function createAgentRunner(deps) {
  const { toolRegistry, toolExecutor, invokeModel, invokeModelWithToolResult } = deps

  function normalizeModelOutput(output) {
    if (!output) return { text: '', toolCalls: [] }
    if (typeof output === 'string') return { text: output, toolCalls: [] }
    return {
      text: output.text ? String(output.text) : '',
      toolCalls: Array.isArray(output.toolCalls) ? output.toolCalls : []
    }
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
      tools
    }

    const firstOutput = normalizeModelOutput(await invokeModel(agentInput))
    if (!firstOutput.toolCalls.length || !toolExecutor) return firstOutput

    const firstToolCall = firstOutput.toolCalls[0]
    const toolResult = await toolExecutor.execute(firstToolCall.name, firstToolCall.arguments || {}, input.runtime || {})
    if (!invokeModelWithToolResult) {
      return {
        text: firstOutput.text || '',
        toolCalls: firstOutput.toolCalls,
        toolResult
      }
    }

    const secondOutput = normalizeModelOutput(await invokeModelWithToolResult(agentInput, {
      name: firstToolCall.name,
      arguments: firstToolCall.arguments || {},
      result: toolResult
    }))
    return {
      ...secondOutput,
      toolCalls: firstOutput.toolCalls
    }
  }

  return { run }
}

module.exports = { createAgentRunner }
