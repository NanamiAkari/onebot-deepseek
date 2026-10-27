function queueError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// A running session owns one slot until its entire reply (including sends) finishes.
// Ready sessions rotate after each job, so a busy group cannot monopolize a slot.
function createRequestQueue(options = {}) {
  const bounded = (value, fallback, max) => Math.max(1, Math.min(max, Math.floor(Number(value) || fallback)))
  const maxConcurrent = bounded(options.maxConcurrent, 2, 8)
  const maxPendingPerKey = bounded(options.maxPendingPerKey, 10, 100)
  const maxPendingTotal = bounded(options.maxPendingTotal, 50, 500)
  const waitTimeoutMs = bounded(options.waitTimeoutMs, 120000, 600000)
  const waiting = new Map()
  const active = new Set()
  const ready = []
  let pendingCount = 0
  let closed = false

  function removeWaiting(key, job) {
    const list = waiting.get(key)
    const index = list ? list.indexOf(job) : -1
    if (index < 0) return false
    list.splice(index, 1)
    pendingCount -= 1
    clearTimeout(job.timer)
    if (!list.length) {
      waiting.delete(key)
      const readyIndex = ready.indexOf(key)
      if (readyIndex >= 0) ready.splice(readyIndex, 1)
    }
    return true
  }

  function drain() {
    while (!closed && active.size < maxConcurrent && ready.length) {
      const key = ready.shift()
      const list = waiting.get(key)
      if (!list || !list.length || active.has(key)) continue
      const job = list[0]
      removeWaiting(key, job)
      active.add(key)
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
        active.delete(key)
        if (waiting.has(key) && !ready.includes(key)) ready.push(key)
        drain()
      })
    }
  }

  function enqueue(key, task) {
    if (closed) return Promise.reject(queueError('QUEUE_CLOSED', '回复队列已关闭'))
    if (!key || typeof task !== 'function') return Promise.reject(new TypeError('queue requires a session key and task'))
    const list = waiting.get(key) || []
    if (list.length >= maxPendingPerKey || pendingCount >= maxPendingTotal) {
      return Promise.reject(queueError('QUEUE_FULL', '等待回复的请求过多'))
    }
    const promise = new Promise((resolve, reject) => {
      const job = { task, resolve, reject, timer: null }
      job.timer = setTimeout(() => {
        if (removeWaiting(key, job)) reject(queueError('QUEUE_EXPIRED', '等待回复超时'))
      }, waitTimeoutMs)
      if (typeof job.timer.unref === 'function') job.timer.unref()
      list.push(job)
      waiting.set(key, list)
      pendingCount += 1
      if (!active.has(key) && !ready.includes(key)) ready.push(key)
    })
    drain()
    return promise
  }

  function close() {
    closed = true
    for (const jobs of waiting.values()) {
      for (const job of jobs) {
        clearTimeout(job.timer)
        job.reject(queueError('QUEUE_CLOSED', '回复队列已关闭'))
      }
    }
    waiting.clear()
    ready.length = 0
    pendingCount = 0
  }

  return { enqueue, close, stats: () => ({ active: active.size, pending: pendingCount, sessions: waiting.size, closed }) }
}

module.exports = { createRequestQueue }
