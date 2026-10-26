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
  if (options.webSearch === true) {
    registry.register({
      name: 'web_search',
      description: '联网查询实时信息、新闻、价格、天气、赛事、软件版本、公开资料或需要核验的事实。仅在当前知识不足或用户明确要求查询最新信息时调用；不要把普通闲聊、已有确定答案或需要登录的私人数据交给搜索。',
      inputSchema: objectSchema({
        query: stringField('简洁、具体的搜索关键词；包含必要的对象、时间和限定条件'),
        max_results: { type: 'integer', description: '最多返回几条网页来源，默认使用服务配置，最多8条', minimum: 1, maximum: 8 }
      }, ['query'])
    })
  }
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
    description: '仅向当前对话所在群发送消息，不能向其他群发送',
    inputSchema: objectSchema({
      group_id: stringField('群号'),
      message: messageArraySchema('OneBot 消息段数组')
    }, ['group_id', 'message'])
  })
  registry.register({
    name: 'send_private_msg',
    description: '仅在私聊中向当前对话用户发送消息，群聊中不可调用',
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
    registry.register({
      name: 'group_member_directory',
      description: '按需获取当前群的成员身份目录，包含 QQ 号、昵称、群名片、群头衔和群角色。仅当用户询问群主、管理员、某个群头衔对应谁，或当前成员指代无法仅靠已有缓存确定时调用；普通聊天不要调用。结果仅用于理解指代，不要向用户暴露QQ号、工具或缓存机制。',
      inputSchema: objectSchema({
        refresh: { type: 'boolean', description: '是否强制刷新群成员目录；通常不需要' }
      }, [])
    })
    registry.register({
      name: 'memory_append',
      description: '记录当前群某位成员值得长期保留的印象，例如稳定说话风格、长期兴趣、常用梗、明确关系或长期雷点。只记录以后与该成员交流可能用得上的信息，不记录一次性事件、临时话题或普通寒暄；必须有明确 user_id。',
      inputSchema: objectSchema({
        user_id: stringField('目标成员 QQ 号，必须来自当前消息、成员目录或身份解析结果'),
        content: stringField('一条长期印象，最多120字'),
        name: stringField('目标成员当前昵称，可选')
      }, ['user_id', 'content'])
    })
    registry.register({
      name: 'memory_query',
      description: '按需查询当前群的长期成员印象。只有当前问题确实需要了解某个成员时调用；查询结果只作为内部参考，不要向用户说明工具或记忆机制。',
      inputSchema: objectSchema({
        user_id: stringField('目标成员 QQ 号，可选；不传返回当前群少量成员印象')
      }, [])
    })
    registry.register({
      name: 'memory_remove',
      description: '删除当前群中某位成员过时或错误的一条长期印象。只有确认记忆已不准确时调用。',
      inputSchema: objectSchema({
        user_id: stringField('目标成员 QQ 号'),
        content: stringField('要删除的完整印象内容')
      }, ['user_id', 'content'])
    })
    registry.register({
      name: 'get_recent_messages',
      description: '查询当前群最近的历史消息。当当前提示中的相邻消息不足以理解上下文，或用户明确追问更早内容时调用；普通回复无需调用。',
      inputSchema: objectSchema({
        limit: { type: 'integer', description: '返回条数，默认20，最多100', minimum: 1 },
        max_chars: { type: 'integer', description: '返回总字符数，默认6000，最多12000', minimum: 500 }
      }, [])
    })
  }
  if (options.fileToolsEnabled === true) {
    registry.register({
      name: 'read_file',
      description: '读取独立工具工作区中的普通文件，最多256 KiB；仅允许已配置的可信管理员使用',
      inputSchema: objectSchema({
        path: stringField('独立工具工作区内的相对文件路径'),
        limit: integerField('最多返回的行数；不传则读取全文', 1)
      }, ['path'])
    })
    registry.register({
      name: 'write_file',
      description: '在独立工具工作区中创建或覆盖普通文件，最多256 KiB；仅允许已配置的可信管理员使用',
      inputSchema: objectSchema({
        path: stringField('独立工具工作区内的相对文件路径'),
        content: stringField('要写入的完整文件内容')
      }, ['path', 'content'])
    })
    registry.register({
      name: 'edit_file',
      description: '在独立工具工作区中用 old_text 精确替换为 new_text，文件最多256 KiB；仅允许已配置的可信管理员使用',
      inputSchema: objectSchema({
        path: stringField('独立工具工作区内的相对文件路径'),
        old_text: stringField('要被替换的原始文本'),
        new_text: stringField('替换后的新文本')
      }, ['path', 'old_text', 'new_text'])
    })
    registry.register({
      name: 'list_dir',
      description: '列出独立工具工作区内的目录，最多500项；仅允许已配置的可信管理员使用',
      inputSchema: objectSchema({
        path: stringField('独立工具工作区内的相对目录路径；传空字符串表示工作区根目录')
      }, ['path'])
    })
  }
  return registry
}

module.exports = { createToolRegistry, createDefaultToolRegistry }
