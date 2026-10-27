function parseOpenAIStringPayload(value) {
  const text = String(value || '').trim()
  if (!text) return { json: null, events: [] }
  try {
    const parsed = JSON.parse(text)
    return { json: parsed && typeof parsed === 'object' ? parsed : null, events: [] }
  } catch {}
  const events = []
  let currentEvent = ''
  const dataLines = []
  const flush = () => {
    if (dataLines.length === 0) return
    const rawData = dataLines.join('\n').trim()
    dataLines.length = 0
    if (!rawData || rawData === '[DONE]') return
    try {
      const parsed = JSON.parse(rawData)
      if (parsed && typeof parsed === 'object') {
        if (currentEvent && !parsed.event) parsed.event = currentEvent
        events.push(parsed)
      }
    } catch {}
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      currentEvent = ''
      continue
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  flush()
  return { json: null, events }
}

function collectTextFromContent(content, out) {
  if (!Array.isArray(content)) return
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (typeof part.text === 'string' && part.text.trim()) out.push(part.text.trim())
  }
}

function extractTextFromObject(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim()
  if (data.type === 'response.output_text.done' && typeof data.text === 'string' && data.text.trim()) return data.text.trim()
  if (data.type === 'response.content_part.done' && data.part && typeof data.part.text === 'string' && data.part.text.trim()) return data.part.text.trim()
  const parts = []
  if (data.type === 'response.output_item.done' && data.item) collectTextFromContent(data.item.content, parts)
  const chatContent = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
  if (typeof chatContent === 'string' && chatContent.trim()) return chatContent.trim()
  collectTextFromContent(chatContent, parts)
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!item || !Array.isArray(item.content)) continue
      collectTextFromContent(item.content, parts)
    }
  }
  return parts.length > 0 ? parts.join('\n') : ''
}

function extractOpenAIText(data) {
  if (typeof data === 'string') {
    const parsed = parseOpenAIStringPayload(data)
    if (parsed.json) return extractOpenAIText(parsed.json)
    const doneParts = []
    const deltaParts = []
    for (const event of parsed.events) {
      const doneText = extractTextFromObject(event)
      if (doneText) doneParts.push(doneText)
      if (event && event.type === 'response.output_text.delta' && typeof event.delta === 'string') deltaParts.push(event.delta)
    }
    if (doneParts.length > 0) return [...new Set(doneParts)].join('\n')
    return deltaParts.join('').trim()
  }
  return extractTextFromObject(data)
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
  if (typeof data === 'string') {
    const parsed = parseOpenAIStringPayload(data)
    if (parsed.json) return extractOpenAIToolCalls(parsed.json)
    const out = []
    for (const event of parsed.events) {
      const item = event && event.item
      if (!item || item.type !== 'function_call' || !item.name) continue
      out.push({
        id: item.call_id || item.id || item.name,
        name: item.name,
        arguments: safeParseJsonObject(item.arguments)
      })
    }
    return out
  }
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

function extractOpenAIImages(data) {
  if (typeof data === 'string') {
    const parsed = parseOpenAIStringPayload(data)
    if (parsed.json) return extractOpenAIImages(parsed.json)
    const out = []
    for (const event of parsed.events) {
      const item = event && event.item
      if (!item || item.type !== 'image_generation_call') continue
      const result = typeof item.result === 'string' ? item.result.trim() : ''
      if (!result) continue
      out.push({
        id: item.id || item.call_id || `image_${out.length + 1}`,
        b64: result
      })
    }
    return out
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.output)) return []
  const out = []
  for (const item of data.output) {
    if (!item || item.type !== 'image_generation_call') continue
    const result = typeof item.result === 'string' ? item.result.trim() : ''
    if (!result) continue
    out.push({
      id: item.id || item.call_id || `image_${out.length + 1}`,
      b64: result
    })
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

module.exports = { extractOpenAIText, extractOpenAIToolCalls, extractOpenAIImages, formatOpenAITools }
