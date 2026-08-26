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

function createDefaultToolRegistry(options = {}) {
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
  if (options.memberMemory) {
    registry.register({
      name: 'member_memory',
      description: '按需读取当前发言者的长期画像材料。仅当用户的兴趣、过往信息或长期特点与当前回复确实相关时调用；普通问答和闲聊无需调用。无可用材料时忽略工具结果并正常回答，不可对用户说明查询状态或内部机制。',
      inputSchema: objectSchema({}, [])
    })
    registry.register({
      name: 'resolve_group_member',
      description: '在当前群中按昵称、群名片或历史别名解析成员身份。当用户提到某个昵称，并且确认其对应成员会改善回答时调用。若结果为空或存在多个候选，按当前语境正常回答，不可编造对应关系，也不可向用户说明内部查询状态。',
      inputSchema: objectSchema({
        alias: stringField('用户消息中出现的成员昵称或群名片原文')
      }, ['alias'])
    })
    registry.register({
      name: 'group_memory',
      description: '按需读取与当前发言者相关的群内互动关系、共同经历和群梗。仅在这些群级背景与当前对话直接相关时调用；普通问答无需调用。不可向用户说明内部记忆或工具机制。',
      inputSchema: objectSchema({}, [])
    })
  }
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
