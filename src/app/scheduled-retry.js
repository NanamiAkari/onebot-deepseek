// 定时任务失败后的重试/放弃决策（纯函数，便于测试）。
//
// 旧行为：一次性任务发送失败也直接删除，循环任务失败也立刻推进到下一次。
// 一次 OneBot 抖动就会永久丢一条消息。现在的约定是：
//   · 失败保留任务，按固定间隔重试，最多 3 次；
//   · 一次性任务 3 次都失败才删除；
//   · 循环任务 3 次都失败就跳过本次、推进到下一个周期（避免卡在同一个时间点刷屏）。

const DEFAULT_RETRY_DELAY_MS = 60000
const DEFAULT_MAX_ATTEMPTS = 3

function planScheduledFailure(options = {}) {
  const maxAttempts = Math.max(1, Math.min(10, Math.floor(Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS)))
  const attempts = Math.max(0, Math.floor(Number(options.attempts) || 0)) + 1
  const recurring = options.recurring === true
  const gaveUp = attempts >= maxAttempts
  return {
    attempts,
    gaveUp,
    action: gaveUp ? (recurring ? 'advance' : 'drop') : 'retry'
  }
}

function isScheduledRetryDue(lastAttemptAt, now, retryDelayMs = DEFAULT_RETRY_DELAY_MS) {
  const last = Number(lastAttemptAt) || 0
  if (!last) return true
  const delay = Math.max(0, Number(retryDelayMs) || 0)
  return Number(now) - last >= delay
}

module.exports = { DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_DELAY_MS, isScheduledRetryDue, planScheduledFailure }
