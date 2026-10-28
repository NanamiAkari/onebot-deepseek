const test = require('node:test')
const assert = require('node:assert/strict')
const { isSafeImageSource, MAX_AT_SEGMENTS, MAX_SEGMENTS, sanitizeOutboundSegments } = require('../src/outbound/segments')

test('@all and non-numeric targets are dropped', () => {
  const result = sanitizeOutboundSegments([
    { type: 'at', data: { qq: 'all' } },
    { type: 'at', data: { qq: 'ALL' } },
    { type: 'at', data: { qq: '20' } },
    { type: 'text', data: { text: '在吗' } }
  ])
  assert.deepEqual(result, [
    { type: 'at', data: { qq: '20' } },
    { type: 'text', data: { text: '在吗' } }
  ])
})

test('at segments are capped', () => {
  const result = sanitizeOutboundSegments(
    Array.from({ length: MAX_AT_SEGMENTS + 3 }, (_, index) => ({ type: 'at', data: { qq: String(index + 1) } }))
  )
  assert.equal(result.length, MAX_AT_SEGMENTS)
})

test('unknown segment types and over-long batches are dropped', () => {
  const segments = [
    { type: 'music', data: { id: '1' } },
    { type: 'forward', data: { id: 'x' } },
    ...Array.from({ length: MAX_SEGMENTS + 5 }, (_, index) => ({ type: 'text', data: { text: `${index}` } }))
  ]
  const result = sanitizeOutboundSegments(segments)
  assert.equal(result.length, MAX_SEGMENTS)
  assert.equal(result.every((segment) => segment.type === 'text'), true)
})

test('text segments have CQ codes neutralized', () => {
  const result = sanitizeOutboundSegments([{ type: 'text', data: { text: '[CQ:at,qq=all] 你好' } }])
  assert.deepEqual(result, [{ type: 'text', data: { text: '[CQ：at,qq=all] 你好' } }])
})

test('reply segments are limited to the current message or its quoted message', () => {
  const segments = [
    { type: 'reply', data: { id: '88' } },
    { type: 'reply', data: { id: '999' } },
    { type: 'text', data: { text: '收到' } }
  ]
  const allowed = sanitizeOutboundSegments(segments, { allowedReplyIds: new Set(['88']) })
  assert.deepEqual(allowed, [
    { type: 'reply', data: { id: '88' } },
    { type: 'text', data: { text: '收到' } }
  ])
})

test('images may be inline, public, or a protocol file id, never a host path', () => {
  assert.equal(isSafeImageSource('base64://iVBORw0KGgo='), true)
  assert.equal(isSafeImageSource('https://example.com/a.png'), true)
  assert.equal(isSafeImageSource('abc.jpg'), true)
  assert.equal(isSafeImageSource('file:///etc/passwd'), false)
  assert.equal(isSafeImageSource('/etc/passwd'), false)
  assert.equal(isSafeImageSource('../../secret.jpg'), false)
  const result = sanitizeOutboundSegments([
    { type: 'image', data: { file: '/etc/passwd' } },
    { type: 'image', data: { file: 'base64://aGVsbG8=' } }
  ])
  assert.deepEqual(result, [{ type: 'image', data: { file: 'base64://aGVsbG8=' } }])
})

test('everything rejected yields an empty batch for the caller to handle', () => {
  assert.deepEqual(sanitizeOutboundSegments([{ type: 'at', data: { qq: 'all' } }]), [])
  assert.deepEqual(sanitizeOutboundSegments([]), [])
  assert.deepEqual(sanitizeOutboundSegments(null), [])
})
