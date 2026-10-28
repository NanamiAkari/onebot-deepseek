const test = require('node:test')
const assert = require('node:assert/strict')
const { extractContent, parseCQMedia } = require('../src/app/inbound-content')

test('market-face stickers are kept as images with a visible placeholder', () => {
  const content = extractContent([
    { type: 'text', data: { text: '看看这个' } },
    { type: 'mface', data: { summary: '[动画表情]', url: 'https://gchat.qpic.cn/a.gif', file: 'abc123' } }
  ])
  assert.equal(content.text, '看看这个[表情包]')
  assert.deepEqual(content.media, [{ kind: 'image', url: 'https://gchat.qpic.cn/a.gif', file: 'abc123' }])
})

test('a sticker without a usable url or file still produces the placeholder', () => {
  const content = extractContent([{ type: 'mface', data: { summary: '[动画表情]' } }])
  assert.equal(content.text, '[表情包]')
  assert.deepEqual(content.media, [])
})

test('CQ string stickers are parsed into both text and media', () => {
  const content = extractContent('看看[CQ:mface,url=https://gchat.qpic.cn/b.gif]')
  assert.equal(content.text, '看看[表情包]')
  assert.deepEqual(content.media, [{ kind: 'image', url: 'https://gchat.qpic.cn/b.gif', file: '' }])
})

test('ordinary images and mentions keep working alongside stickers', () => {
  const content = extractContent([
    { type: 'at', data: { qq: '1000' } },
    { type: 'text', data: { text: '这俩' } },
    { type: 'image', data: { file: 'normal.jpg', url: 'https://example.com/a.jpg' } },
    { type: 'mface', data: { file: 'sticker.gif' } },
    { type: 'reply', data: { id: '88' } }
  ])
  assert.equal(content.replyId, '88')
  assert.equal(content.text, '这俩[表情包]')
  assert.deepEqual(content.media, [
    { kind: 'image', url: 'https://example.com/a.jpg', file: 'normal.jpg' },
    { kind: 'image', url: '', file: 'sticker.gif' }
  ])
})

test('face and emoji stay textual placeholders without media', () => {
  const content = extractContent([
    { type: 'face', data: { id: '14' } },
    { type: 'emoji', data: { id: '270' } }
  ])
  assert.equal(content.text, '[表情][emoji:270]')
  assert.deepEqual(content.media, [])
})

test('CQ media parsing covers image, sticker, audio and video', () => {
  const media = parseCQMedia('[CQ:image,file=a.jpg][CQ:mface,url=https://x/b.gif][CQ:record,file=c.amr][CQ:video,file=d.mp4]')
  assert.deepEqual(media, [
    { kind: 'image', url: 'a.jpg', file: 'a.jpg' },
    { kind: 'image', url: 'https://x/b.gif', file: '' },
    { kind: 'audio', url: 'c.amr', file: 'c.amr' },
    { kind: 'video', url: 'd.mp4', file: 'd.mp4' }
  ])
})

test('forward ids and plain text are unaffected', () => {
  const content = extractContent([
    { type: 'text', data: { text: '转发记录' } },
    { type: 'forward', data: { id: 'forward-1' } }
  ])
  assert.deepEqual(content.forwardIds, ['forward-1'])
  assert.equal(content.text, '转发记录')
})
