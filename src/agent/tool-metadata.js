// 工具并发元数据的唯一事实来源。
//
// 这里只回答三件事，不涉及权限（权限仍由 tool-policy 负责）：
//   safety  —— read | send | write | admin
//              read 允许同批并行；其余三类都要独占一波、逐个执行
//   budget  —— 单次 agent run 内允许执行的次数上限（去重命中不计数）
//   lockKey —— 副作用工具互斥的资源域；同键串行，异键并行

const READ = 'read'
const SEND = 'send'
const WRITE = 'write'
const ADMIN = 'admin'

// bot_feature 用 action 区分读写；管理类动作同时是写操作。
const FEATURE_ACTION_SAFETY = {
  list_poke_replies: READ,
  add_poke_reply: WRITE,
  remove_poke_reply: ADMIN,
  clear_poke_replies: ADMIN,
  dedupe_poke_replies: ADMIN,
  send_poke: SEND,
  list_custom_replies: READ,
  get_custom_reply: READ,
  add_custom_reply: ADMIN,
  remove_custom_reply: ADMIN,
  clear_custom_replies: ADMIN,
  list_scheduled_tasks: READ,
  add_scheduled_task: ADMIN,
  remove_scheduled_task: ADMIN,
  clear_scheduled_tasks: ADMIN
}

const FEATURE_ACTION_LOCK = {
  list_poke_replies: 'poke-replies',
  add_poke_reply: 'poke-replies',
  remove_poke_reply: 'poke-replies',
  clear_poke_replies: 'poke-replies',
  dedupe_poke_replies: 'poke-replies',
  list_custom_replies: 'custom-replies',
  get_custom_reply: 'custom-replies',
  add_custom_reply: 'custom-replies',
  remove_custom_reply: 'custom-replies',
  clear_custom_replies: 'custom-replies',
  list_scheduled_tasks: 'scheduled-tasks',
  add_scheduled_task: 'scheduled-tasks',
  remove_scheduled_task: 'scheduled-tasks',
  clear_scheduled_tasks: 'scheduled-tasks'
}

function normalizeAction(args) {
  return String((args && args.action) || '').trim()
}

function groupKey(runtime) {
  const payload = runtime && runtime.payload
  return payload && payload.group_id != null ? String(payload.group_id) : 'unknown'
}

function chatKeyFromPayload(payload) {
  if (!payload) return 'chat:unknown'
  if (payload.message_type === 'group' && payload.group_id != null) return `group:${payload.group_id}`
  if (payload.user_id != null) return `private:${payload.user_id}`
  return 'chat:unknown'
}

function sendLock(args, runtime) {
  return `send:${chatKeyFromPayload(runtime && runtime.payload)}`
}

function fileLock(args) {
  const raw = String((args && args.path) || '').trim().replace(/\\/g, '/')
  return `file:${raw || 'unknown'}`
}

const TOOLS = {
  web_search: { safety: READ, budget: 3 },
  web_fetch: { safety: READ, budget: 3 },
  list_stickers: { safety: READ, budget: 3 },
  collect_sticker: { safety: WRITE, budget: 2, lockKey: () => 'sticker:store' },
  annotate_sticker: { safety: WRITE, budget: 2, lockKey: () => 'sticker:store' },
  send_sticker: { safety: SEND, budget: 2, lockKey: sendLock },
  get_msg: { safety: READ, budget: 5 },
  get_image: { safety: READ, budget: 4 },
  send_group_msg: { safety: SEND, budget: 3, lockKey: sendLock },
  send_private_msg: { safety: SEND, budget: 3, lockKey: sendLock },
  history: { safety: READ, budget: 3 },
  member_memory: { safety: READ, budget: 3 },
  resolve_group_member: { safety: READ, budget: 4 },
  group_memory: { safety: READ, budget: 3 },
  // 会写成员目录缓存，但对用户仍是只读查询；缓存写入是同步的读改写，不存在撕裂读。
  group_member_directory: { safety: READ, budget: 3 },
  memory_append: { safety: WRITE, budget: 2, lockKey: (args, runtime) => `memory:impressions:${groupKey(runtime)}` },
  memory_query: { safety: READ, budget: 3 },
  memory_remove: { safety: WRITE, budget: 2, lockKey: (args, runtime) => `memory:impressions:${groupKey(runtime)}` },
  get_recent_messages: { safety: READ, budget: 3 },
  read_file: { safety: READ, budget: 4 },
  list_dir: { safety: READ, budget: 2 },
  write_file: { safety: WRITE, budget: 2, lockKey: fileLock },
  edit_file: { safety: WRITE, budget: 2, lockKey: fileLock }
}

const UNKNOWN_META = Object.freeze({
  safety: WRITE,
  budget: 2,
  lockKey: () => 'tool:unknown'
})

const BOT_FEATURE_META = Object.freeze({
  safety: WRITE,
  budget: 4,
  lockKey: () => 'feature:unknown'
})

function getToolMeta(name, args) {
  if (name === 'bot_feature') {
    const action = normalizeAction(args)
    const safety = FEATURE_ACTION_SAFETY[action]
    if (!safety) return BOT_FEATURE_META
    return {
      safety,
      budget: 4,
      lockKey: safety === SEND
        ? sendLock
        : (argsAgain, runtime) => `feature:${FEATURE_ACTION_LOCK[action] || 'unknown'}:${groupKey(runtime)}`
    }
  }
  return TOOLS[name] || UNKNOWN_META
}

function isReadOnlyTool(name, args) {
  return getToolMeta(name, args).safety === READ
}

function toolBudget(name, args) {
  return getToolMeta(name, args).budget
}

function toolSafety(name, args) {
  return getToolMeta(name, args).safety
}

// 只读工具不参与互斥；副作用工具按资源域取锁，未知工具的锁最保守。
function toolLockKey(name, args, runtime) {
  const meta = getToolMeta(name, args)
  if (meta.safety === READ) return ''
  try {
    const key = typeof meta.lockKey === 'function' ? meta.lockKey(args, runtime) : ''
    return String(key || `tool:${name}`)
  } catch {
    return `tool:${name}`
  }
}

module.exports = {
  SAFETY: { READ, SEND, WRITE, ADMIN },
  FEATURE_ACTION_SAFETY,
  chatKeyFromPayload,
  getToolMeta,
  isReadOnlyTool,
  toolBudget,
  toolSafety,
  toolLockKey
}
