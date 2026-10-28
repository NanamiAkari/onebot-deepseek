// 模型请求的重试策略。
//
// 只重试“等一会儿自己就好了”的错误：429 限流、5xx 网关抖动、连接层失败。
// 参数错误（400/422）、鉴权失败（401/403）和超时都不重试：
//   · 4xx 重打只会浪费配额；
//   · 超时重试会把一次慢请求变成两次，聊天场景里延迟比成功率更伤。

function statusOf(error) {
  const status = error && error.response && error.response.status
  const number = Number(status)
  return Number.isFinite(number) ? number : 0
}

function isRetryableModelError(error) {
  if (!error) return false
  const status = statusOf(error)
  if (status === 408 || status === 425 || status === 429) return true
  if (status >= 500 && status <= 599) return true
  if (status) return false
  const code = String(error.code || '')
  const message = String(error.message || '')
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPIPE/i.test(code)) return true
  if (/socket hang up|network error|connection reset|fetch failed|other side closed/i.test(message)) return true
  return false
}

async function withModelRetry(task, options = {}) {
  const retries = Math.max(0, Math.min(5, Math.floor(Number(options.retries ?? 2))))
  const baseDelayMs = Math.max(0, Math.min(10000, Number(options.baseDelayMs ?? 1000)))
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= retries || isAborted() || !isRetryableModelError(error)) throw error
      const wait = Math.round(baseDelayMs * Math.pow(2, attempt) + Math.random() * 200)
      if (typeof options.onRetry === 'function') {
        try { options.onRetry(error, attempt + 1, wait) } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError
}

module.exports = { isRetryableModelError, withModelRetry, statusOf }
