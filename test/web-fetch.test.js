const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { createWebFetch, extractReadablePage, isPrivateIp } = require('../src/web-fetch')
const { createDefaultToolRegistry } = require('../src/agent/tools')

test('web_fetch is exposed as an on-demand model tool', () => {
  assert.equal(createDefaultToolRegistry().get('web_fetch'), undefined)
  assert.ok(createDefaultToolRegistry({ webFetch: true }).get('web_fetch'))
})

test('web fetch rejects localhost, private, mapped and credential URLs', async () => {
  let requests = 0
  const service = createWebFetch({
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request: async () => {
      requests += 1
      throw new Error('must not request')
    }
  })
  assert.equal(isPrivateIp('127.0.0.1'), true)
  assert.equal(isPrivateIp('::ffff:7f00:1'), true)
  assert.equal(isPrivateIp('192.0.2.1'), true)
  assert.equal(isPrivateIp('198.51.100.1'), true)
  assert.equal(isPrivateIp('203.0.113.1'), true)
  assert.equal(isPrivateIp('64:ff9b::7f00:1'), true)
  assert.equal(isPrivateIp('2001:db8::1'), true)
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false)
  assert.equal(isPrivateIp('8.8.8.8'), false)
  await assert.rejects(() => service.fetch('http://localhost/'), /内网/)
  await assert.rejects(() => service.fetch('http://private.test/'), /内网/)
  await assert.rejects(() => service.fetch('https://user:pass@example.com/'), /账号或密码/)
  await assert.rejects(() => service.fetch('file:///etc/passwd'), /http/)
  assert.equal(requests, 0)
})

test('web fetch accepts a direct public IPv6 URL without treating brackets as DNS', async () => {
  const requested = []
  const service = createWebFetch({
    request: async (url, address) => {
      requested.push({ url: url.toString(), address })
      return { statusCode: 200, contentType: 'text/plain', body: Buffer.from('IPv6 public text'), truncated: false }
    }
  })
  const result = await service.fetch('https://[2606:4700:4700::1111]/')
  assert.equal(result.content, 'IPv6 public text')
  assert.deepEqual(requested, [{ url: 'https://[2606:4700:4700::1111]/', address: '2606:4700:4700::1111' }])
})

test('web fetch validates every redirect target before requesting it', async () => {
  const requested = []
  const service = createWebFetch({
    lookup: async (hostname) => hostname === 'public.test'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '10.0.0.1', family: 4 }],
    request: async (url) => {
      requested.push(url.toString())
      return { statusCode: 302, redirect: 'http://private.test/secret', contentType: 'text/html', body: Buffer.alloc(0), truncated: false }
    }
  })
  await assert.rejects(() => service.fetch('https://public.test/start'), /内网/)
  assert.deepEqual(requested, ['https://public.test/start'])
})

test('web fetch extracts readable article text and drops executable page content', async () => {
  const service = createWebFetch({
    maxChars: 500,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({
      statusCode: 200,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from('<html><head><title>测试标题</title><script>steal()</script></head><body><nav>菜单</nav><article><h1>正文标题</h1><p>第一段&nbsp;内容。</p><p>第二段内容。</p></article><footer>页脚</footer></body></html>'),
      truncated: false
    })
  })
  const result = await service.fetch('https://example.com/article')
  assert.equal(result.title, '测试标题')
  assert.match(result.content, /正文标题/)
  assert.match(result.content, /第一段 内容/)
  assert.equal(result.content.includes('steal'), false)
  assert.equal(result.content.includes('菜单'), false)
  assert.match(result.instruction, /不可信/)
})

test('web fetch safely decodes compressed pages', async () => {
  const html = '<html><head><title>压缩页面</title></head><body><main>压缩后的正文内容。</main></body></html>'
  const service = createWebFetch({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({
      statusCode: 200,
      contentType: 'text/html; charset=utf-8',
      contentEncoding: 'gzip',
      body: zlib.gzipSync(Buffer.from(html)),
      truncated: false
    })
  })
  const result = await service.fetch('https://example.com/compressed')
  assert.equal(result.title, '压缩页面')
  assert.match(result.content, /压缩后的正文内容/)
})

test('readable page extraction reports character truncation', () => {
  const result = extractReadablePage('<html><body><main>${word}</main></body></html>'.replace('${word}', '内容'.repeat(500)), { maxChars: 500 })
  assert.equal(result.content.length, 500)
  assert.equal(result.truncated, true)
})
