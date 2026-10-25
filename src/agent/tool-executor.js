const fs = require('fs')
const path = require('path')
const { createToolPolicy } = require('./tool-policy')

const MAX_FILE_BYTES = 256 * 1024
const MAX_DIRECTORY_ENTRIES = 500

class ToolError extends Error {}

function createToolExecutor(deps) {
  const { sendAction, getHistoryRaw, workspaceRoot, memberMemory } = deps
  const policy = createToolPolicy(deps)

  function ensureWorkspace() {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw new ToolError('File workspace is unavailable')
    const root = path.resolve(workspaceRoot)
    try {
      const stat = fs.lstatSync(root)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ToolError('File workspace must be a regular directory')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      const stat = fs.lstatSync(root)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ToolError('File workspace must be a regular directory')
    }
    return fs.realpathSync(root)
  }

  function safePath(relativePath, createParents = false) {
    if (typeof relativePath !== 'string' || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
      throw new ToolError('Only relative workspace paths are allowed')
    }
    const normalized = relativePath.trim()
    if (normalized.split(/[\\/]/).includes('..')) throw new ToolError('Path traversal is not allowed')
    const root = ensureWorkspace()
    const fullPath = path.resolve(root, normalized || '.')
    const relative = path.relative(root, fullPath)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ToolError('Path traversal is not allowed')
    }
    const parts = relative.split(path.sep).filter(Boolean)
    let current = root
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index])
      const isParent = index < parts.length - 1
      let stat
      try {
        stat = fs.lstatSync(current)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (isParent && createParents) {
          fs.mkdirSync(current, { mode: 0o700 })
          stat = fs.lstatSync(current)
        } else if (isParent) {
          throw new ToolError('Workspace directory does not exist')
        } else {
          continue
        }
      }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new ToolError('Symbolic links and special files are not allowed')
      }
      if (isParent && !stat.isDirectory()) throw new ToolError('Workspace parent must be a directory')
      if (stat.isFile() && stat.nlink > 1) throw new ToolError('Hard-linked files are not allowed')
    }
    return fullPath
  }

  function checkFile(stat) {
    if (!stat.isFile() || stat.nlink > 1) throw new ToolError('Only regular unlinked workspace files are allowed')
    if (stat.size > MAX_FILE_BYTES) throw new ToolError(`File exceeds the ${MAX_FILE_BYTES}-byte limit`)
  }

  function readFile(fullPath) {
    const fd = fs.openSync(fullPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      checkFile(fs.fstatSync(fd))
      // Read a bounded buffer even if another process grows the file after fstat.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const bytes = fs.readSync(fd, buffer, length, buffer.length - length, null)
        if (!bytes) break
        length += bytes
      }
      if (length > MAX_FILE_BYTES) throw new ToolError(`File exceeds the ${MAX_FILE_BYTES}-byte limit`)
      return buffer.toString('utf8', 0, length)
    } finally {
      fs.closeSync(fd)
    }
  }

  function writeFile(fullPath, content) {
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new ToolError(`File exceeds the ${MAX_FILE_BYTES}-byte limit`)
    const fd = fs.openSync(fullPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600)
    try {
      checkFile(fs.fstatSync(fd))
      fs.ftruncateSync(fd, 0)
      fs.writeFileSync(fd, content, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
  }

  function runReadFile(args) {
    if (!args.path) throw new ToolError('read_file requires path')
    const fullPath = safePath(args.path)
    const text = readFile(fullPath)
    const lines = text.split(/\r?\n/)
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : null
    const sliced = limit ? lines.slice(0, limit) : lines
    return { path: args.path, content: sliced.join('\n') }
  }

  function runWriteFile(args) {
    if (!args.path) throw new ToolError('write_file requires path')
    if (typeof args.content !== 'string') throw new ToolError('write_file requires content')
    if (Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) throw new ToolError(`File exceeds the ${MAX_FILE_BYTES}-byte limit`)
    const fullPath = safePath(args.path, true)
    writeFile(fullPath, args.content)
    return { path: args.path, bytes: Buffer.byteLength(args.content, 'utf8') }
  }

  function runEditFile(args) {
    if (!args.path) throw new ToolError('edit_file requires path')
    if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') throw new ToolError('edit_file requires old_text and new_text')
    const fullPath = safePath(args.path)
    const text = readFile(fullPath)
    if (!text.includes(args.old_text)) throw new ToolError('old_text not found in file')
    const updated = text.replace(args.old_text, args.new_text)
    writeFile(fullPath, updated)
    return { path: args.path, replaced: true }
  }

  function runListDir(args) {
    const fullPath = safePath(args.path || '.')
    const directory = fs.opendirSync(fullPath)
    const entries = []
    let truncated = false
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (entries.length >= MAX_DIRECTORY_ENTRIES) {
          truncated = true
          break
        }
        entries.push({ name: entry.name, type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'blocked' })
      }
    } finally {
      directory.closeSync()
    }
    return { path: args.path || '.', entries, truncated }
  }

  async function oneBotAction(ws, action, params) {
    const response = await sendAction(ws, action, params)
    if (!response || response.status !== 'ok' || (response.retcode !== undefined && Number(response.retcode) !== 0)) {
      throw new ToolError('OneBot action failed')
    }
    return response
  }

  async function runGetMsg(args, runtime) {
    const ws = runtime && runtime.ws
    if (!ws || !args.message_id) throw new ToolError('get_msg requires ws and message_id')
    return oneBotAction(ws, 'get_msg', { message_id: args.message_id })
  }

  async function runGetImage(args, runtime) {
    const ws = runtime && runtime.ws
    if (!ws || !args.file) throw new ToolError('get_image requires ws and file')
    return oneBotAction(ws, 'get_image', { file: args.file })
  }

  async function runSendGroupMsg(args, runtime) {
    const ws = runtime && runtime.ws
    const payload = runtime && runtime.payload
    if (!ws || !Array.isArray(args.message) || !args.message.length) throw new ToolError('send_group_msg requires a connection and message segments')
    if (String(args.group_id || '') !== String(payload.group_id)) throw new ToolError('Messages can only be sent to the current conversation')
    return oneBotAction(ws, 'send_group_msg', { group_id: payload.group_id, message: args.message })
  }

  async function runSendPrivateMsg(args, runtime) {
    const ws = runtime && runtime.ws
    const payload = runtime && runtime.payload
    if (!ws || !Array.isArray(args.message) || !args.message.length) throw new ToolError('send_private_msg requires a connection and message segments')
    if (String(args.user_id || '') !== String(payload.user_id)) throw new ToolError('Messages can only be sent to the current conversation')
    return oneBotAction(ws, 'send_private_msg', { user_id: payload.user_id, message: args.message })
  }

  async function runHistory(args, runtime) {
    const payload = runtime && runtime.payload
    if (!payload) throw new ToolError('history requires payload')
    return { session_key: args.session_key || '', items: getHistoryRaw(payload) }
  }

  async function runMemberMemory(_args, runtime) {
    const payload = runtime && runtime.payload
    if (!payload || !memberMemory || typeof memberMemory.getReplyMaterial !== 'function') {
      return { available: false, instruction: '忽略本工具结果，仅依据当前消息正常回答。' }
    }
    const result = memberMemory.getReplyMaterial(payload)
    if (!result || !result.available) {
      return { available: false, instruction: '忽略本工具结果，仅依据当前消息正常回答。' }
    }
    return {
      available: true,
      material: result.material,
      instruction: '材料仅用于辅助当前回复；当前消息优先，不要向用户提及画像、记忆、材料或工具。'
    }
  }

  async function runResolveGroupMember(args, runtime) {
    const payload = runtime && runtime.payload
    if (!payload || payload.message_type !== 'group' || !memberMemory || typeof memberMemory.findMembersByAlias !== 'function') {
      return { matches: [], instruction: '忽略本工具结果，仅依据当前消息正常回答。' }
    }
    const matches = memberMemory.findMembersByAlias(payload.group_id, args.alias, 5)
    return matches.length > 0
      ? { matches, instruction: '仅用于理解当前消息中的成员指代；不要主动暴露 QQ 号、别名目录或工具机制。多个候选时不得擅自确定。' }
      : { matches: [], instruction: '忽略本工具结果，仅依据当前消息正常回答。' }
  }

  async function runGroupMemory(_args, runtime) {
    const payload = runtime && runtime.payload
    if (!payload || !memberMemory || typeof memberMemory.getGroupMemoryMaterial !== 'function') {
      return { available: false, instruction: '忽略本工具结果，仅依据当前消息正常回答。' }
    }
    const result = memberMemory.getGroupMemoryMaterial(payload)
    return result && result.available
      ? { available: true, material: result.material, instruction: '仅用于辅助当前回复，不要主动提及内部记忆或工具。' }
      : { available: false, instruction: '忽略本工具结果，仅依据当前消息正常回答。' }
  }

  async function runGroupMemberDirectory(args, runtime) {
    const payload = runtime && runtime.payload
    const ws = runtime && runtime.ws
    if (!payload || payload.message_type !== 'group' || !ws || !memberMemory || typeof memberMemory.getGroupMemberDirectory !== 'function') {
      return { available: false, members: [], instruction: '忽略本工具结果，仅依据当前消息正常回答。' }
    }
    const members = await memberMemory.getGroupMemberDirectory(payload.group_id, async () => {
      const response = await oneBotAction(ws, 'get_group_member_list', { group_id: payload.group_id })
      if (!Array.isArray(response.data)) throw new ToolError('OneBot returned an invalid member directory')
      return response.data
    }, Boolean(args && args.refresh))
    return {
      available: members.length > 0,
      members,
      instruction: '仅用于理解当前对话中的群成员指代；不要向用户展示QQ号或说明内部查询过程。'
    }
  }

  async function runMemoryAppend(args, runtime) {
    const payload = runtime && runtime.payload
    if (!payload || payload.message_type !== 'group' || !memberMemory || typeof memberMemory.appendImpression !== 'function') {
      return { ok: false, error: '当前不是群聊或记忆能力不可用' }
    }
    return memberMemory.appendImpression(payload.group_id, args.user_id, args.content, args.name)
  }

  async function runMemoryQuery(args, runtime) {
    const payload = runtime && runtime.payload
    if (!payload || payload.message_type !== 'group' || !memberMemory || typeof memberMemory.queryImpressions !== 'function') {
      return { ok: true, members: [] }
    }
    return memberMemory.queryImpressions(payload.group_id, args.user_id)
  }

  async function runMemoryRemove(args, runtime) {
    const payload = runtime && runtime.payload
    if (!payload || payload.message_type !== 'group' || !memberMemory || typeof memberMemory.removeImpression !== 'function') {
      return { ok: false, error: '当前不是群聊或记忆能力不可用' }
    }
    return memberMemory.removeImpression(payload.group_id, args.user_id, args.content)
  }

  async function runRecentMessages(args, runtime) {
    const payload = runtime && runtime.payload
    if (!payload || payload.message_type !== 'group' || !memberMemory || typeof memberMemory.getRecentGroupMessages !== 'function') {
      return { messages: [] }
    }
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
    const maxChars = Math.max(500, Math.min(12000, Number(args.max_chars) || 6000))
    const messages = await memberMemory.getRecentGroupMessages(payload.group_id, limit, maxChars)
    const scanTruncated = Boolean(messages.scanTruncated)
    return {
      messages,
      scan_truncated: scanTruncated,
      ...(scanTruncated ? { instruction: '只返回了本次扫描范围内的消息，未扫描完整历史；不要据此声称某人没有发言或更早没有相关消息。' } : {})
    }
  }

  const handlers = {
    get_msg: runGetMsg,
    get_image: runGetImage,
    send_group_msg: runSendGroupMsg,
    send_private_msg: runSendPrivateMsg,
    history: runHistory,
    member_memory: runMemberMemory,
    resolve_group_member: runResolveGroupMember,
    group_memory: runGroupMemory,
    group_member_directory: runGroupMemberDirectory,
    memory_append: runMemoryAppend,
    memory_query: runMemoryQuery,
    memory_remove: runMemoryRemove,
    get_recent_messages: runRecentMessages,
    read_file: async (args) => runReadFile(args),
    write_file: async (args) => runWriteFile(args),
    edit_file: async (args) => runEditFile(args),
    list_dir: async (args) => runListDir(args)
  }

  async function execute(name, args, runtime) {
    const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (!Object.prototype.hasOwnProperty.call(handlers, name)) return { ok: false, error: 'Unknown tool' }
    if (!isAllowed(name, runtime)) return { ok: false, error: 'Tool is not allowed for this user or conversation' }
    try {
      const data = await handlers[name](safeArgs, runtime)
      if (data && data.ok === false) return { ok: false, error: 'Tool operation was not completed' }
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: error instanceof ToolError ? error.message : 'Tool operation failed' }
    }
  }

  function isAllowed(name, runtime) {
    return Object.prototype.hasOwnProperty.call(handlers, name) && policy.isAllowed(name, runtime)
  }

  return { execute, isAllowed }
}

module.exports = { createToolExecutor }
