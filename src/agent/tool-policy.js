const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir'])
const GROUP_FEATURE_TOOLS = new Set([
  'bot_feature',
  'list_poke_replies', 'add_poke_reply', 'remove_poke_reply', 'clear_poke_replies', 'dedupe_poke_replies', 'send_poke',
  'list_custom_replies', 'get_custom_reply', 'add_custom_reply', 'remove_custom_reply', 'clear_custom_replies',
  'list_scheduled_tasks', 'add_scheduled_task', 'remove_scheduled_task', 'clear_scheduled_tasks'
])

function normalizeUserIds(value) {
  const values = value instanceof Set || Array.isArray(value)
    ? Array.from(value)
    : String(value || '').split(',')
  return new Set(values.map((item) => String(item).trim()).filter((item) => /^\d+$/.test(item)))
}

function createToolPolicy(options = {}) {
  const fileToolsEnabled = options.fileToolsEnabled === true
  const trustedUserIds = normalizeUserIds(options.fileToolAdminUserIds)

  function isAllowed(name, runtime) {
    const payload = runtime && runtime.payload
    if (FILE_TOOLS.has(name)) {
      return fileToolsEnabled && Boolean(payload && trustedUserIds.has(String(payload.user_id || '')))
    }
    if (name === 'send_group_msg') return Boolean(payload && payload.message_type === 'group' && payload.group_id)
    if (name === 'send_private_msg') return Boolean(payload && payload.message_type === 'private' && payload.user_id)
    if (GROUP_FEATURE_TOOLS.has(name)) return Boolean(payload && payload.message_type === 'group' && payload.group_id)
    return true
  }

  return { isAllowed }
}

module.exports = { createToolPolicy }
