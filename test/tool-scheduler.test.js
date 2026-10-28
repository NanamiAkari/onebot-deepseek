const test = require('node:test')
const assert = require('node:assert/strict')
const { createToolScheduler } = require('../src/agent/tool-scheduler')

function call(name, args = {}) {
  return { id: `${name}-${Math.random().toString(36).slice(2, 7)}`, name, arguments: args }
}

test('adjacent read-only calls share a wave while side effects stay isolated', () => {
  const scheduler = createToolScheduler({ isReadOnly: (item) => item.name.startsWith('read') })
  const waves = scheduler.plan([call('read_a'), call('read_b'), call('write_a'), call('read_c'), call('read_d')])
  assert.deepEqual(waves.map((wave) => [wave.parallel, wave.calls.length]), [[true, 2], [false, 1], [true, 2]])
})

test('parallel waves respect the concurrency cap and keep result order', async () => {
  let active = 0
  let maxActive = 0
  const scheduler = createToolScheduler({ maxParallel: 2, isReadOnly: () => true })
  const calls = [call('read_1'), call('read_2'), call('read_3'), call('read_4'), call('read_5')]
  const { entries, waves } = await scheduler.run(calls, async (item) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return { ok: true, name: item.name }
  }, { batchId: '1/3' })
  assert.equal(maxActive, 2)
  assert.equal(waves.length, 1)
  assert.deepEqual(entries.map((entry) => entry.name), ['read_1', 'read_2', 'read_3', 'read_4', 'read_5'])
})

test('side-effect calls are executed one at a time in model order', async () => {
  const order = []
  const scheduler = createToolScheduler({ isReadOnly: () => false })
  await scheduler.run([call('write_a'), call('write_b'), call('send_c')], async (item) => {
    order.push(`start:${item.name}`)
    await new Promise((resolve) => setTimeout(resolve, 3))
    order.push(`end:${item.name}`)
    return { ok: true }
  }, { batchId: '1/3' })
  assert.deepEqual(order, ['start:write_a', 'end:write_a', 'start:write_b', 'end:write_b', 'start:send_c', 'end:send_c'])
})

test('calls left after the deadline are skipped instead of executed', async () => {
  let executed = 0
  const scheduler = createToolScheduler({ isReadOnly: () => false })
  const { entries } = await scheduler.run([call('write_a'), call('write_b')], async () => {
    executed += 1
    return { ok: true }
  }, { batchId: '1/3', deadlineAt: Date.now() })
  assert.equal(executed, 0)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].skipped, true)
  assert.match(entries[0].error, /时间预算/)
})

test('an isReadOnly that throws is treated as a side effect instead of crashing the batch', () => {
  const scheduler = createToolScheduler({
    isReadOnly: () => { throw new Error('boom') }
  })
  const waves = scheduler.plan([call('a'), call('b')])
  assert.deepEqual(waves.map((wave) => wave.parallel), [false, false])
})
