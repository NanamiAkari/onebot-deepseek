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

module.exports = { extractOpenAIText }
