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

function stringField(description) {
  return { type: 'string', description }
}

function integerField(description, minimum) {
  const out = { type: 'integer', description }
  if (typeof minimum === 'number') out.minimum = minimum
  return out
}

function objectSchema(properties, required) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required
  }
}

function messageArraySchema(description) {
  return {
    type: 'array',
    description,
    items: {
      type: 'object',
      additionalProperties: true
    }
  }
}

function createDefaultToolRegistry() {
  const registry = createToolRegistry()
  registry.register({
    name: 'get_msg',
    description: '按 message_id 读取被引用消息内容',
    inputSchema: objectSchema({
      message_id: stringField('OneBot 消息 ID')
    }, ['message_id'])
  })
  registry.register({
    name: 'get_image',
    description: '按 OneBot 图片 file 标识解析图片本地路径与下载地址',
    inputSchema: objectSchema({
      file: stringField('OneBot 图片的 file 标识')
    }, ['file'])
  })
  registry.register({
    name: 'send_group_msg',
    description: '发送群消息',
    inputSchema: objectSchema({
      group_id: stringField('群号'),
      message: messageArraySchema('OneBot 消息段数组')
    }, ['group_id', 'message'])
  })
  registry.register({
    name: 'send_private_msg',
    description: '发送私聊消息',
    inputSchema: objectSchema({
      user_id: stringField('用户 QQ 号'),
      message: messageArraySchema('OneBot 消息段数组')
    }, ['user_id', 'message'])
  })
  registry.register({
    name: 'history',
    description: '读取当前会话的短期上下文摘要',
    inputSchema: objectSchema({
      session_key: stringField('会话唯一键；当前实现会忽略该值并从运行时 payload 读取')
    }, ['session_key'])
  })
  registry.register({
    name: 'read_file',
    description: '读取工作区内文件内容，可限制返回的最大行数',
    inputSchema: objectSchema({
      path: stringField('工作区内的相对文件路径'),
      limit: integerField('最多返回的行数；不传则读取全文', 1)
    }, ['path'])
  })
  registry.register({
    name: 'write_file',
    description: '写入工作区内文件内容；若文件不存在则创建，若目录不存在则自动创建',
    inputSchema: objectSchema({
      path: stringField('工作区内的相对文件路径'),
      content: stringField('要写入的完整文件内容')
    }, ['path', 'content'])
  })
  registry.register({
    name: 'edit_file',
    description: '在工作区内编辑文件，用 old_text 精确替换为 new_text',
    inputSchema: objectSchema({
      path: stringField('工作区内的相对文件路径'),
      old_text: stringField('要被替换的原始文本'),
      new_text: stringField('替换后的新文本')
    }, ['path', 'old_text', 'new_text'])
  })
  registry.register({
    name: 'list_dir',
    description: '列出工作区内目录内容，便于模型先浏览再读写文件',
    inputSchema: objectSchema({
      path: stringField('工作区内的相对目录路径；传空字符串表示工作区根目录')
    }, ['path'])
  })
  return registry
}

module.exports = { createToolRegistry, createDefaultToolRegistry }
