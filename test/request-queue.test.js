const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequestQueue } = require('../src/app/request-queue')

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

test('serializes requests for one session and limits global concurrency', async () => {
  const queue = createRequestQueue({ maxConcurrent: 2, maxPendingPerKey: 4, maxPendingTotal: 10, waitTimeoutMs: 1000 })
  let active = 0
  let peak = 0
  const starts = []
  const task = (name, ms) => queue.enqueue(name, async () => {
    active += 1
    peak = Math.max(peak, active)
    starts.push(name)
    await wait(ms)
    active -= 1
    return name
  })
  const results = await Promise.all([task('group:1', 20), task('group:1', 1), task('group:2', 10)])
  assert.deepEqual(results, ['group:1', 'group:1', 'group:2'])
  assert.equal(peak, 2)
  assert.deepEqual(starts.slice(0, 2).sort(), ['group:1', 'group:2'])
  assert.equal(starts.filter((name) => name === 'group:1').length, 2)
  queue.close()
})

test('rejects excess work and expires stale queued requests', async () => {
  const queue = createRequestQueue({ maxConcurrent: 1, maxPendingPerKey: 1, maxPendingTotal: 1, waitTimeoutMs: 20 })
  let release
  const first = queue.enqueue('group:1', () => new Promise((resolve) => { release = resolve }))
  const second = queue.enqueue('group:1', async () => 'second')
  const secondRejection = assert.rejects(second, (error) => error.code === 'QUEUE_EXPIRED')
  await assert.rejects(queue.enqueue('group:1', async () => 'third'), (error) => error.code === 'QUEUE_FULL')
  await wait(35)
  await secondRejection
  release('first')
  assert.equal(await first, 'first')
  queue.close()
})
