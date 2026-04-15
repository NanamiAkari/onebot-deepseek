function createAgentRunner(deps) {
  const { toolRegistry, invokeModel } = deps

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

    const output = await invokeModel(agentInput)
    return {
      text: output ? String(output) : '',
      toolCalls: []
    }
  }

  return { run }
}

module.exports = { createAgentRunner }
