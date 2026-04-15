function createToolExecutor(deps) {
  const { sendAction, getHistoryRaw } = deps

  async function execute(name, args, runtime) {
    const safeArgs = args && typeof args === 'object' ? args : {}
    const ws = runtime && runtime.ws
    const payload = runtime && runtime.payload

    if (name === 'get_msg') {
      if (!ws || !safeArgs.message_id) throw new Error('get_msg requires ws and message_id')
      return sendAction(ws, 'get_msg', { message_id: safeArgs.message_id })
    }

    if (name === 'get_image') {
      if (!ws || !safeArgs.file) throw new Error('get_image requires ws and file')
      return sendAction(ws, 'get_image', { file: safeArgs.file })
    }

    if (name === 'send_group_msg') {
      if (!ws || !safeArgs.group_id || !safeArgs.message) throw new Error('send_group_msg requires ws, group_id and message')
      return sendAction(ws, 'send_group_msg', { group_id: safeArgs.group_id, message: safeArgs.message })
    }

    if (name === 'send_private_msg') {
      if (!ws || !safeArgs.user_id || !safeArgs.message) throw new Error('send_private_msg requires ws, user_id and message')
      return sendAction(ws, 'send_private_msg', { user_id: safeArgs.user_id, message: safeArgs.message })
    }

    if (name === 'history') {
      if (!payload) throw new Error('history requires payload')
      return { items: getHistoryRaw(payload) }
    }

    throw new Error(`unknown tool: ${name}`)
  }

  return { execute }
}

module.exports = { createToolExecutor }
