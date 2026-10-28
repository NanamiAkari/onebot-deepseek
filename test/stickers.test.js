const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createStickerStore, detectImageType } = require('../src/stickers')
const { createDefaultToolRegistry } = require('../src/agent/tools')

test('sticker tools are exposed together for model-selected use', () => {
  const registry = createDefaultToolRegistry({ stickers: true })
  for (const name of ['list_stickers', 'collect_sticker', 'annotate_sticker', 'send_sticker']) {
    assert.ok(registry.get(name), name)
  }
})

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')

function fixture(t, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-stickers-'))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  return { rootDir, store: createStickerStore({ rootDir, ...options }) }
}

test('sticker store collects, searches, annotates and reads controlled images', async (t) => {
  const { rootDir, store } = fixture(t)
  const collected = await store.collect({
    key: 'group:1:message:2:image:1',
    note: '开心点赞',
    tags: ['开心', '点赞'],
    usage: '赞同群友时使用',
    getBytes: async () => PNG
  })
  assert.match(collected.id, /^st_[a-f0-9]{20}$/)
  assert.equal(collected.note, '开心点赞')
  assert.equal(store.list('点赞').matched, 1)
  assert.equal(store.list('赞同').stickers[0].id, collected.id)
  assert.equal(store.list().stickers[0].file, undefined)
  const annotated = store.annotate(collected.id, { note: '点赞支持', tags: ['赞同'] })
  assert.equal(annotated.note, '点赞支持')
  const image = store.readForSend(collected.id)
  assert.equal(image.mime, 'image/png')
  assert.deepEqual(image.buffer, PNG)
  assert.ok(fs.existsSync(path.join(rootDir, 'stickers.json')))
  assert.ok(fs.existsSync(path.join(rootDir, 'images', `${collected.id}.png`)))
  store.markUsed(collected.id, '赞同')
  assert.equal(store.get(collected.id).useCount, 1)
})

test('sticker collection is idempotent for the same source and rejects non-images', async (t) => {
  const { store } = fixture(t)
  const first = await store.collect({ key: 'same-source', note: '第一版', getBytes: async () => PNG })
  const second = await store.collect({ key: 'same-source', note: '更新备注', getBytes: async () => PNG })
  assert.equal(second.id, first.id)
  assert.equal(store.list().total, 1)
  assert.equal(second.note, '更新备注')
  await assert.rejects(() => store.collect({ key: 'html', note: '错误', getBytes: async () => Buffer.from('<html>not image</html>') }), /图片格式/)
})

test('sticker store enforces collection frequency and safe stored paths', async (t) => {
  const { rootDir, store } = fixture(t, { maxCollectPerHour: 1 })
  await store.collect({ key: 'one', note: '第一张', getBytes: async () => PNG })
  await assert.rejects(() => store.collect({ key: 'two', note: '第二张', getBytes: async () => PNG }), /太频繁/)
  fs.writeFileSync(path.join(rootDir, 'stickers.json'), JSON.stringify([{
    id: 'st_0123456789abcdef0123',
    file: '../../outside.png',
    note: 'unsafe'
  }]))
  const reloaded = createStickerStore({ rootDir })
  assert.equal(reloaded.list().total, 0)
  assert.throws(() => reloaded.readForSend('st_0123456789abcdef0123'), /找不到/)
})

test('image type detection only accepts supported real image signatures', () => {
  assert.deepEqual(detectImageType(PNG), { ext: '.png', mime: 'image/png' })
  assert.equal(detectImageType(Buffer.from('not an image')), null)
})

test('the same image collected from different messages reuses one entry', async (t) => {
  const { rootDir, store } = fixture(t)
  const first = await store.collect({
    key: 'group:1:message:2:image:1',
    note: '第一张',
    getBytes: async () => PNG
  })
  const second = await store.collect({
    key: 'group:1:message:99:image:1',
    note: '同一张图',
    getBytes: async () => PNG
  })
  assert.equal(second.id, first.id)
  assert.equal(store.list().total, 1)
  assert.equal(store.list().stickers[0].note, '同一张图')
  const index = JSON.parse(fs.readFileSync(path.join(rootDir, 'stickers.json'), 'utf8'))
  assert.equal(index[0].contentHash.length, 64)
  assert.equal(fs.readdirSync(path.join(rootDir, 'images')).length, 1)
})
