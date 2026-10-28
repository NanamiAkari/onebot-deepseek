const test = require('node:test')
const assert = require('node:assert/strict')
const { isScheduledRetryDue, planScheduledFailure } = require('../src/app/scheduled-retry')

test('failures retry until the attempt limit, then drop or advance', () => {
  assert.equal(planScheduledFailure({ attempts: 0, recurring: false, maxAttempts: 3 }).action, 'retry')
  assert.equal(planScheduledFailure({ attempts: 1, recurring: false, maxAttempts: 3 }).action, 'retry')
  const dropped = planScheduledFailure({ attempts: 2, recurring: false, maxAttempts: 3 })
  assert.equal(dropped.action, 'drop')
  assert.equal(dropped.gaveUp, true)
  assert.equal(dropped.attempts, 3)

  const advanced = planScheduledFailure({ attempts: 2, recurring: true, maxAttempts: 3 })
  assert.equal(advanced.action, 'advance')
})

test('attempts increase from the stored value and clamp the risk of runaway retries', () => {
  assert.equal(planScheduledFailure({ attempts: 0 }).attempts, 1)
  assert.equal(planScheduledFailure({ attempts: '2' }).attempts, 3)
  assert.equal(planScheduledFailure({ attempts: 99, maxAttempts: 3 }).attempts, 100)
  assert.equal(planScheduledFailure({ maxAttempts: 1 }).action, 'drop')
})

test('retry timing respects the configured delay', () => {
  const now = 1_000_000
  assert.equal(isScheduledRetryDue(0, now, 60000), true)
  assert.equal(isScheduledRetryDue(now - 1000, now, 60000), false)
  assert.equal(isScheduledRetryDue(now - 61000, now, 60000), true)
  assert.equal(isScheduledRetryDue(null, now, 60000), true)
})
