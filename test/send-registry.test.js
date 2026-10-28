const test = require('node:test')
const assert = require('node:assert/strict')
const { createSendRegistry } = require('../src/app/send-registry')

test('tool sends and the final reply text share one fingerprint', () => {
  const registry = createSendRegistry({ ttlMs: 9000 })
  const segments = [{ type: 'text', data: { text: '在呢' } }]
  const fromTool = registry.fingerprint('group:10', segments)
  const fromReply = registry.fingerprint('group:10', '在呢')
  assert.equal(fromTool, fromReply)
  assert.equal(registry.isDuplicate(fromTool), false)
  registry.markSent(fromTool)
  assert.equal(registry.isDuplicate(fromReply), true)
})

test('quote and at segments do not change the content fingerprint', () => {
  const registry = createSendRegistry({ ttlMs: 9000 })
  const plain = registry.fingerprint('group:10', [{ type: 'text', data: { text: '好的' } }])
  const quoted = registry.fingerprint('group:10', [
    { type: 'reply', data: { id: '88' } },
    { type: 'at', data: { qq: '20' } },
    { type: 'text', data: { text: '好的' } }
  ])
  assert.equal(plain, quoted)
})

test('whitespace and split text segments normalize to the same content', () => {
  const registry = createSendRegistry({ ttlMs: 9000 })
  const split = registry.fingerprint('group:10', [
    { type: 'text', data: { text: '你' } },
    { type: 'text', data: { text: '好' } }
  ])
  const padded = registry.fingerprint('group:10', '  你好\n')
  assert.equal(split, padded)
  const collapsed = registry.fingerprint('group:10', [{ type: 'text', data: { text: '你  好' } }])
  assert.equal(collapsed, registry.fingerprint('group:10', '你 好'))
})

test('different conversations and different images are not duplicates', () => {
  const registry = createSendRegistry({ ttlMs: 9000 })
  const groupOne = registry.fingerprint('group:10', [{ type: 'text', data: { text: '收到' } }])
  const groupTwo = registry.fingerprint('group:11', [{ type: 'text', data: { text: '收到' } }])
  assert.notEqual(groupOne, groupTwo)
  const imageOne = registry.fingerprint('group:10', [{ type: 'image', data: { file: 'a.jpg' } }])
  const imageTwo = registry.fingerprint('group:10', [{ type: 'image', data: { file: 'b.jpg' } }])
  assert.notEqual(imageOne, imageTwo)
  const stickerOne = registry.fingerprint('group:10', { sticker: 'st_1' })
  const stickerTwo = registry.fingerprint('group:10', { sticker: 'st_2' })
  assert.notEqual(stickerOne, stickerTwo)
})

test('entries expire after the window and ttl=0 disables dedupe', async () => {
  const registry = createSendRegistry({ ttlMs: 25 })
  const print = registry.fingerprint('group:10', '好')
  registry.markSent(print)
  assert.equal(registry.isDuplicate(print), true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(registry.isDuplicate(print), false)

  const disabled = createSendRegistry({ ttlMs: 0 })
  const other = disabled.fingerprint('group:10', '好')
  disabled.markSent(other)
  assert.equal(disabled.isDuplicate(other), false)
})

test('empty content never becomes a fingerprint', () => {
  const registry = createSendRegistry()
  assert.equal(registry.fingerprint('group:10', ''), '')
  assert.equal(registry.fingerprint('group:10', []), '')
  assert.equal(registry.isDuplicate(''), false)
})
