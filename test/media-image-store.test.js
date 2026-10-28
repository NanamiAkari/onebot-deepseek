const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readSourceBuffer, writeContentAddressedImage, detectMime, gifToStaticPng } = require('../src/media/image-store')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('source buffers are read from base64, data URIs and local files', async (t) => {
  const dir = tempDir(t)
  const base64 = await readSourceBuffer(`base64://${PNG.toString('base64')}`)
  assert.equal(base64.mime, 'image/png')
  assert.deepEqual(base64.buf, PNG)

  const dataUri = await readSourceBuffer(`data:image/png;base64,${PNG.toString('base64')}`)
  assert.deepEqual(dataUri.buf, PNG)

  const filePath = path.join(dir, 'a.png')
  fs.writeFileSync(filePath, PNG)
  const local = await readSourceBuffer(filePath)
  assert.deepEqual(local.buf, PNG)
  const asUri = await readSourceBuffer(`file://${filePath}`)
  assert.deepEqual(asUri.buf, PNG)
})

test('oversized sources are rejected before being kept', async (t) => {
  const dir = tempDir(t)
  const filePath = path.join(dir, 'big.png')
  fs.writeFileSync(filePath, Buffer.concat([PNG, Buffer.alloc(4096)]))
  await assert.rejects(() => readSourceBuffer(filePath, { maxBytes: 1024 }), /大小上限/)
})

test('images are stored by content hash and identical bytes are written once', (t) => {
  const dir = tempDir(t)
  const first = writeContentAddressedImage(dir, PNG, { maxBytes: 1024 * 1024 })
  const second = writeContentAddressedImage(dir, PNG, { maxBytes: 1024 * 1024 })
  assert.equal(first.path, second.path)
  assert.match(path.basename(first.path), /^[a-f0-9]{40}\.png$/)
  assert.equal(fs.readdirSync(dir).length, 1)
})

test('non-image and oversized buffers are rejected', (t) => {
  const dir = tempDir(t)
  assert.throws(() => writeContentAddressedImage(dir, Buffer.from('not an image')), /受支持的图片格式/)
  assert.throws(() => writeContentAddressedImage(dir, PNG, { maxBytes: 32 }), /MB 上限/)
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0)
})

test('mime detection falls back to the provided content type', () => {
  assert.equal(detectMime(PNG), 'image/png')
  assert.equal(detectMime(Buffer.from('xxxx'), 'audio/mpeg'), 'audio/mpeg')
})

test('animated gifs are flattened to a middle-frame png', async () => {
  const calls = []
  const fakeSharp = (_buffer, options = {}) => {
    calls.push(options)
    return {
      metadata: async () => ({ pages: 3, width: 10, height: 10 }),
      resize() { return this },
      png() { return this },
      toBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])
    }
  }
  const png = await gifToStaticPng(Buffer.from('GIF89a fake'), { sharp: fakeSharp })
  assert.deepEqual(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.equal(calls.some((call) => call.page === 1), true)
})
