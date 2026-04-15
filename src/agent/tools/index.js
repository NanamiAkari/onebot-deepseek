function createToolRegistry() {
  const tools = new Map()

  function register(tool) {
    if (!tool || !tool.name) throw new Error('tool.name is required')
    tools.set(tool.name, tool)
  }

  function list() {
    return Array.from(tools.values())
  }

  function get(name) {
    return tools.get(name)
  }

  return { register, list, get }
}

function createDefaultToolRegistry() {
  const registry = createToolRegistry()
  registry.register({
    name: 'get_msg',
    description: '按 message_id 读取被引用消息内容',
    inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] }
  })
  registry.register({
    name: 'get_image',
    description: '按 OneBot 图片 file 标识解析图片本地路径与下载地址',
    inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }
  })
  registry.register({
    name: 'send_group_msg',
    description: '发送群消息',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' }, message: { type: 'array' } }, required: ['group_id', 'message'] }
  })
  registry.register({
    name: 'send_private_msg',
    description: '发送私聊消息',
    inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, message: { type: 'array' } }, required: ['user_id', 'message'] }
  })
  registry.register({
    name: 'history',
    description: '读取当前会话的短期上下文摘要',
    inputSchema: { type: 'object', properties: { session_key: { type: 'string' } }, required: ['session_key'] }
  })
  return registry
}

module.exports = { createToolRegistry, createDefaultToolRegistry }
