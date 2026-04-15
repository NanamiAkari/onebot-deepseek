const fs = require('fs')
const path = require('path')

function createToolExecutor(deps) {
  const { sendAction, getHistoryRaw, workspaceRoot } = deps

  function safePath(relativePath) {
    const normalized = String(relativePath || '').trim()
    const fullPath = path.resolve(workspaceRoot, normalized || '.')
    const relative = path.relative(workspaceRoot, fullPath)
    const escapes = relative.startsWith('..') || path.isAbsolute(relative)
    if (escapes) throw new Error(`path escapes workspace: ${relativePath}`)
    return fullPath
  }

  function runReadFile(args) {
    if (!args.path) throw new Error('read_file requires path')
    const fullPath = safePath(args.path)
    const text = fs.readFileSync(fullPath, 'utf8')
    const lines = text.split(/\r?\n/)
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : null
    const sliced = limit ? lines.slice(0, limit) : lines
    return { path: args.path, content: sliced.join('\n') }
  }

  function runWriteFile(args) {
    if (!args.path) throw new Error('write_file requires path')
    if (typeof args.content !== 'string') throw new Error('write_file requires content')
    const fullPath = safePath(args.path)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, args.content, 'utf8')
    return { path: args.path, bytes: Buffer.byteLength(args.content, 'utf8') }
  }

  function runEditFile(args) {
    if (!args.path) throw new Error('edit_file requires path')
    if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') throw new Error('edit_file requires old_text and new_text')
    const fullPath = safePath(args.path)
    const text = fs.readFileSync(fullPath, 'utf8')
    if (!text.includes(args.old_text)) throw new Error('old_text not found in file')
    const updated = text.replace(args.old_text, args.new_text)
    fs.writeFileSync(fullPath, updated, 'utf8')
    return { path: args.path, replaced: true }
  }

  function runListDir(args) {
    const fullPath = safePath(args.path || '.')
    const entries = fs.readdirSync(fullPath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file'
    }))
    return { path: args.path || '.', entries }
  }

  async function runGetMsg(args, runtime) {
    const ws = runtime && runtime.ws
    if (!ws || !args.message_id) throw new Error('get_msg requires ws and message_id')
    return sendAction(ws, 'get_msg', { message_id: args.message_id })
  }

  async function runGetImage(args, runtime) {
    const ws = runtime && runtime.ws
    if (!ws || !args.file) throw new Error('get_image requires ws and file')
    return sendAction(ws, 'get_image', { file: args.file })
  }

  async function runSendGroupMsg(args, runtime) {
    const ws = runtime && runtime.ws
    if (!ws || !args.group_id || !args.message) throw new Error('send_group_msg requires ws, group_id and message')
    return sendAction(ws, 'send_group_msg', { group_id: args.group_id, message: args.message })
  }

  async function runSendPrivateMsg(args, runtime) {
    const ws = runtime && runtime.ws
    if (!ws || !args.user_id || !args.message) throw new Error('send_private_msg requires ws, user_id and message')
    return sendAction(ws, 'send_private_msg', { user_id: args.user_id, message: args.message })
  }

  async function runHistory(args, runtime) {
    const payload = runtime && runtime.payload
    if (!payload) throw new Error('history requires payload')
    return { session_key: args.session_key || '', items: getHistoryRaw(payload) }
  }

  const handlers = {
    get_msg: runGetMsg,
    get_image: runGetImage,
    send_group_msg: runSendGroupMsg,
    send_private_msg: runSendPrivateMsg,
    history: runHistory,
    read_file: async (args) => runReadFile(args),
    write_file: async (args) => runWriteFile(args),
    edit_file: async (args) => runEditFile(args),
    list_dir: async (args) => runListDir(args)
  }

  async function execute(name, args, runtime) {
    const safeArgs = args && typeof args === 'object' ? args : {}
    const handler = handlers[name]
    if (!handler) throw new Error(`unknown tool: ${name}`)
    return handler(safeArgs, runtime)
  }

  return { execute, handlers, safePath }
}

module.exports = { createToolExecutor }
