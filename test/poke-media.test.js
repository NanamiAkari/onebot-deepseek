const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { portablePokeSource, resolvePokeSource } = require('../src/app/poke-media')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-media-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'poke_media')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'abc.jpg'), 'x')
  return { root, dir }
}

test('sources inside poke_media are stored as project-relative paths', (t) => {
  const { root, dir } = fixture(t)
  assert.equal(portablePokeSource(path.join(dir, 'abc.jpg'), { dir }), 'poke_media/abc.jpg')
  assert.equal(portablePokeSource(`file://${dir}/abc.jpg`, { dir }), 'poke_media/abc.jpg')
  assert.equal(portablePokeSource('https://gchat.qpic.cn/a.gif', { dir }), 'https://gchat.qpic.cn/a.gif')
  assert.equal(portablePokeSource('base64://AAAA', { dir }), 'base64://AAAA')
  assert.equal(portablePokeSource(path.join(root, 'outside.jpg'), { dir }), path.join(root, 'outside.jpg'))
})

test('relative paths resolve against the project root', (t) => {
  const { root, dir } = fixture(t)
  assert.equal(resolvePokeSource('poke_media/abc.jpg', { dir, projectRoot: root }), path.join(dir, 'abc.jpg'))
})

test('a moved deployment heals by file name', (t) => {
  const { root, dir } = fixture(t)
  // 旧机器上的绝对路径已经不存在，但同名文件在新的 poke_media 里。
  const stale = '/old/machine/poke_media/abc.jpg'
  assert.equal(resolvePokeSource(stale, { dir, projectRoot: root }), path.join(dir, 'abc.jpg'))
  assert.equal(resolvePokeSource('poke_media/abc.jpg', { dir, projectRoot: '/missing/root' }), path.join(dir, 'abc.jpg'))
})

test('missing files and remote sources are returned unchanged', (t) => {
  const { root, dir } = fixture(t)
  assert.equal(resolvePokeSource('poke_media/nope.jpg', { dir, projectRoot: root }), 'poke_media/nope.jpg')
  assert.equal(resolvePokeSource('https://example.com/a.jpg', { dir, projectRoot: root }), 'https://example.com/a.jpg')
  assert.equal(resolvePokeSource('', { dir, projectRoot: root }), '')
})
