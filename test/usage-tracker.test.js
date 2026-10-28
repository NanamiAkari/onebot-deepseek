const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createUsageTracker, localDateKey } = require('../src/usage/tracker')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('usage is aggregated per day and persisted to disk', (t) => {
  const dir = tempDir(t)
  let now = new Date(2026, 9, 28, 12, 0, 0).getTime()
  const tracker = createUsageTracker({ dir, now: () => now })
  tracker.record({ promptTokens: 100, completionTokens: 50 }, { model: 'model-a' })
  tracker.record({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, { model: 'model-a' })
  tracker.record({ input_tokens: 7, output_tokens: 3 }, { model: 'model-b' })

  const summary = tracker.summary()
  assert.equal(summary.date, '2026-10-28')
  assert.equal(summary.calls, 3)
  assert.equal(summary.promptTokens, 117)
  assert.equal(summary.completionTokens, 58)
  assert.equal(summary.totalTokens, 175)
  assert.equal(summary.byModel['model-a'].calls, 2)
  assert.equal(summary.byModel['model-a'].totalTokens, 165)
  assert.equal(summary.byModel['model-b'].promptTokens, 7)

  const file = path.join(dir, 'usage-2026-10-28.json')
  assert.equal(fs.existsSync(file), true)
  const reloaded = createUsageTracker({ dir, now: () => now })
  assert.equal(reloaded.summary().calls, 3)
  assert.equal(reloaded.summary().totalTokens, 175)
})

test('a new day starts a fresh bucket without touching the old file', (t) => {
  const dir = tempDir(t)
  let now = new Date(2026, 9, 28, 23, 0, 0).getTime()
  const tracker = createUsageTracker({ dir, now: () => now })
  tracker.record({ promptTokens: 30, completionTokens: 20 })
  now = new Date(2026, 9, 29, 1, 0, 0).getTime()
  const nextDay = tracker.summary()
  assert.equal(nextDay.date, '2026-10-29')
  assert.equal(nextDay.calls, 0)
  assert.equal(fs.existsSync(path.join(dir, 'usage-2026-10-28.json')), true)
})

test('cost is estimated from configured per-million prices', (t) => {
  const dir = tempDir(t)
  const tracker = createUsageTracker({
    dir,
    priceInputPer1M: 2,
    priceOutputPer1M: 4,
    now: () => new Date(2026, 9, 28, 12, 0, 0).getTime()
  })
  tracker.record({ promptTokens: 1_000_000, completionTokens: 500_000 })
  const summary = tracker.summary()
  assert.equal(summary.cost, 4)
})

test('invalid usage is ignored and disabled tracking writes nothing', (t) => {
  const dir = tempDir(t)
  const tracker = createUsageTracker({ dir })
  assert.equal(tracker.record({}), null)
  assert.equal(tracker.record(null), null)
  assert.equal(tracker.summary().calls, 0)

  const disabledDir = path.join(dir, 'disabled')
  const disabled = createUsageTracker({ dir: disabledDir, enabled: false })
  assert.equal(disabled.record({ promptTokens: 5, completionTokens: 5 }), null)
  assert.equal(fs.existsSync(disabledDir), false)
})

test('date keys are local dates', () => {
  assert.equal(localDateKey(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02')
})
