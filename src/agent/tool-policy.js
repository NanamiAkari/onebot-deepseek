const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir'])

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
    return true
  }

  return { isAllowed }
}

module.exports = { createToolPolicy }
