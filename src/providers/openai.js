function extractOpenAIText(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim()
  const chatContent = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
  if (typeof chatContent === 'string' && chatContent.trim()) return chatContent.trim()
  if (Array.isArray(chatContent)) {
    const chatParts = []
    for (const item of chatContent) {
      if (item && typeof item.text === 'string' && item.text.trim()) chatParts.push(item.text.trim())
    }
    if (chatParts.length > 0) return chatParts.join('\n')
  }
  if (Array.isArray(data.output)) {
    const outputParts = []
    for (const item of data.output) {
      if (!item || !Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (part && typeof part.text === 'string' && part.text.trim()) outputParts.push(part.text.trim())
      }
    }
    if (outputParts.length > 0) return outputParts.join('\n')
  }
  return ''
}

function safeParseJsonObject(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function extractOpenAIToolCalls(data) {
  if (!data || typeof data !== 'object') return []
  const out = []
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!item || item.type !== 'function_call' || !item.name) continue
      out.push({
        id: item.call_id || item.id || item.name,
        name: item.name,
        arguments: safeParseJsonObject(item.arguments)
      })
    }
  }
  const chatToolCalls = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.tool_calls
  if (Array.isArray(chatToolCalls)) {
    for (const item of chatToolCalls) {
      const fn = item && item.function
      if (!fn || !fn.name) continue
      out.push({
        id: item.id || fn.name,
        name: fn.name,
        arguments: safeParseJsonObject(fn.arguments)
      })
    }
  }
  return out
}

function formatOpenAITools(tools, useResponses) {
  if (!Array.isArray(tools) || tools.length === 0) return []
  return tools.map((tool) => {
    const parameters = tool.inputSchema || { type: 'object', properties: {} }
    if (useResponses) {
      return {
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters
      }
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters
      }
    }
  })
}

module.exports = { extractOpenAIText, extractOpenAIToolCalls, formatOpenAITools }
