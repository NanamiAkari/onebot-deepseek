const test = require('node:test')
const assert = require('node:assert/strict')
const { escapeCqText, sanitizeModelText, splitForQQ } = require('../src/outbound/text')

function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

test('markdown is flattened into QQ-friendly plain text', () => {
  const input = [
    '## 标题',
    '**重点**和*强调*，还有 `代码`。',
    '- 第一项',
    '- 第二项',
    '> 引用一句',
    '[文档](https://example.com/doc)',
    '![图](https://example.com/a.png)'
  ].join('\n')
  const output = sanitizeModelText(input)
  assert.equal(/\*\*|`|^#|^- |^> /m.test(output), false)
  assert.match(output, /标题/)
  assert.match(output, /重点和强调，还有 代码。/)
  assert.match(output, /文档 \(https:\/\/example\.com\/doc\)/)
  assert.match(output, /图/)
})

test('thinking blocks never reach the reply text', () => {
  assert.equal(sanitizeModelText('<thinking>我在推理</thinking>说重点'), '说重点')
  assert.equal(sanitizeModelText('前半句<analysis>没闭合的推理'), '前半句')
  assert.equal(sanitizeModelText('正文<reasoning>tail'), '正文')
})

test('CQ codes are neutralized so text cannot become a protocol segment', () => {
  assert.equal(escapeCqText('[CQ:at,qq=all] 大家好'), '[CQ：at,qq=all] 大家好')
  assert.equal(escapeCqText('[cq:image,file=a.jpg]'), '[CQ：image,file=a.jpg]')
  assert.equal(escapeCqText('普通文本'), '普通文本')
})

test('splitting never cuts an emoji in half', () => {
  const emoji = '😀'
  const text = `${'a'.repeat(9)}${emoji}${'b'.repeat(40)}`
  const parts = splitForQQ(text, 10)
  assert.ok(parts.length > 1)
  assert.equal(parts.join(''), text)
  for (const part of parts) assert.equal(hasLoneSurrogate(part), false, part)
})

test('splitting prefers line breaks and keeps every character', () => {
  const text = `第一行\n${'x'.repeat(30)}\n最后一行`
  const parts = splitForQQ(text, 12)
  assert.ok(parts.length > 1)
  assert.equal(parts.join('').replace(/\n/g, ''), text.replace(/\n/g, ''))
  assert.equal(parts[0], '第一行')
  for (const part of parts) assert.ok(part.length <= 12)
})

test('empty content produces no parts', () => {
  assert.deepEqual(splitForQQ(''), [])
  assert.deepEqual(splitForQQ('   '), [])
})
