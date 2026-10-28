// 把一批工具调用切成「波次」：
//   相邻的只读调用合进同一波并行执行；
//   发送、写入、删除、管理类调用各自独占一波，严格按模型返回顺序逐个执行。
// 这样混合批次不会退化成全串行，同时保留「读后写、写后读」的先后语义。

function createToolScheduler(options = {}) {
  const maxParallel = Math.max(1, Math.min(16, Math.floor(Number(options.maxParallel) || 4)))
  const isReadOnly = typeof options.isReadOnly === 'function' ? options.isReadOnly : () => false

  function plan(calls) {
    const waves = []
    let current = null
    for (const call of Array.isArray(calls) ? calls : []) {
      let readOnly = false
      try {
        readOnly = Boolean(isReadOnly(call))
      } catch {
        readOnly = false
      }
      if (readOnly) {
        if (!current) {
          current = { parallel: true, calls: [] }
          waves.push(current)
        }
        current.calls.push(call)
        continue
      }
      waves.push({ parallel: false, calls: [call] })
      current = null
    }
    return waves
  }

  async function runLimited(items, limit, execute) {
    const results = new Array(items.length)
    let next = 0
    async function worker() {
      while (next < items.length) {
        const index = next
        next += 1
        results[index] = await execute(items[index], index)
      }
    }
    const workers = []
    for (let index = 0; index < Math.min(limit, items.length); index += 1) workers.push(worker())
    await Promise.all(workers)
    return results
  }

  function deadlineEntry(call, batchId) {
    return {
      id: call.id || call.name,
      name: call.name,
      arguments: call.arguments || {},
      batchId,
      ok: false,
      data: null,
      error: '本轮处理时间预算已用尽，本次工具调用被跳过',
      kind: 'fatal',
      skipped: true
    }
  }

  async function run(calls, execute, runOptions = {}) {
    const list = Array.isArray(calls) ? calls : []
    const waves = plan(list)
    const deadlineAt = Number(runOptions.deadlineAt) || 0
    const batchId = runOptions.batchId
    const entries = []
    const summary = []
    for (const wave of waves) {
      if (deadlineAt && Date.now() >= deadlineAt) {
        entries.push(...wave.calls.map((call) => deadlineEntry(call, batchId)))
        summary.push({ parallel: false, size: wave.calls.length, expired: true })
        continue
      }
      if (wave.parallel && wave.calls.length > 1) {
        entries.push(...await runLimited(wave.calls, maxParallel, execute))
        summary.push({ parallel: true, size: wave.calls.length })
        continue
      }
      for (const call of wave.calls) entries.push(await execute(call))
      summary.push({ parallel: false, size: wave.calls.length })
    }
    return { entries, waves: summary }
  }

  return { plan, run, maxParallel }
}

module.exports = { createToolScheduler }
