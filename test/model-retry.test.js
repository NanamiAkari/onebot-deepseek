const test = require('node:test')
const assert = require('node:assert/strict')
const { isRetryableModelError, withModelRetry } = require('../src/providers/retry')

function httpError(status, message = '') {
  const error = new Error(message || `Request failed with status code ${status}`)
  error.response = { status }
  return error
}

test('rate limits, gateway hiccups and connection resets are retryable', () => {
  assert.equal(isRetryableModelError(httpError(429)), true)
  assert.equal(isRetryableModelError(httpError(503)), true)
  assert.equal(isRetryableModelError(httpError(502)), true)
  assert.equal(isRetryableModelError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true)
  assert.equal(isRetryableModelError(Object.assign(new Error('boom'), { code: 'EAI_AGAIN' })), true)
})

test('bad requests, auth failures and timeouts are not retried', () => {
  assert.equal(isRetryableModelError(httpError(400)), false)
  assert.equal(isRetryableModelError(httpError(401)), false)
  assert.equal(isRetryableModelError(httpError(422)), false)
  assert.equal(isRetryableModelError(Object.assign(new Error('timeout of 12000ms exceeded'), { code: 'ECONNABORTED' })), false)
  assert.equal(isRetryableModelError(new Error('timeout')), false)
})

test('a retryable failure is retried and then succeeds', async () => {
  let attempts = 0
  const seen = []
  const value = await withModelRetry(async () => {
    attempts += 1
    if (attempts === 1) throw httpError(429)
    return 'ok'
  }, { retries: 2, baseDelayMs: 1, onRetry: (_error, tried) => seen.push(tried) })
  assert.equal(value, 'ok')
  assert.equal(attempts, 2)
  assert.deepEqual(seen, [1])
})

test('a non-retryable failure fails on the first attempt', async () => {
  let attempts = 0
  await assert.rejects(
    withModelRetry(async () => {
      attempts += 1
      throw httpError(400)
    }, { retries: 3, baseDelayMs: 1 }),
    /status code 400/
  )
  assert.equal(attempts, 1)
})

test('retries stop at the configured limit and keep the last error', async () => {
  let attempts = 0
  await assert.rejects(
    withModelRetry(async () => {
      attempts += 1
      throw httpError(503)
    }, { retries: 1, baseDelayMs: 1 }),
    /status code 503/
  )
  assert.equal(attempts, 2)
})

test('an aborted retry loop stops immediately', async () => {
  let attempts = 0
  let aborted = false
  await assert.rejects(
    withModelRetry(async () => {
      attempts += 1
      aborted = true
      throw httpError(503)
    }, { retries: 3, baseDelayMs: 1, isAborted: () => aborted }),
    /status code 503/
  )
  assert.equal(attempts, 1)
})
