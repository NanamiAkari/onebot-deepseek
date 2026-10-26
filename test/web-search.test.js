const test = require('node:test')
const assert = require('node:assert/strict')
const { createWebSearch } = require('../src/web-search')
const { createDefaultToolRegistry } = require('../src/agent/tools')

test('web_search is exposed only when a search provider is available', () => {
  assert.equal(createDefaultToolRegistry().get('web_search'), undefined)
  assert.ok(createDefaultToolRegistry({ webSearch: true }).get('web_search'))
})

test('DeepSeek search sends the native web tool and extracts answer and citations', async () => {
  let captured = null
  const service = createWebSearch({
    provider: 'deepseek',
    deepseekApiKey: 'test-key',
    deepseekApiUrl: 'https://api.deepseek.test/responses',
    deepseekModel: 'search-model',
    request: {
      post: async (url, body, config) => {
        captured = { url, body, config }
        return {
          data: {
            output_text: '<b>最新结论</b>',
            output: [{
              type: 'message',
              content: [{
                type: 'output_text',
                text: '补充说明',
                annotations: [{ type: 'url_citation', url_citation: { title: '官方来源', url: 'https://example.com/news' } }]
              }]
            }]
          }
        }
      }
    }
  })
  const result = await service.search('  2026 年  最新版本  ', { maxResults: 3 })
  assert.equal(captured.url, 'https://api.deepseek.test/responses')
  assert.equal(captured.body.model, 'search-model')
  assert.equal(captured.body.input, '2026 年 最新版本')
  assert.deepEqual(captured.body.tools, [{ type: 'web_search' }])
  assert.equal(captured.config.headers.authorization, 'Bearer test-key')
  assert.equal(result.provider, 'deepseek')
  assert.match(result.answer, /最新结论/)
  assert.match(result.answer, /补充说明/)
  assert.deepEqual(result.results, [{ title: '官方来源', url: 'https://example.com/news', snippet: '' }])
})

test('auto mode prefers structured search providers and bounds result count', async () => {
  let captured = null
  const service = createWebSearch({
    provider: 'auto',
    tavilyApiKey: 'tavily-key',
    bochaApiKey: 'bocha-key',
    maxResults: 2,
    request: {
      post: async (url, body) => {
        captured = { url, body }
        return { data: { answer: '答案', results: Array.from({ length: 8 }, (_, index) => ({ title: `结果${index}`, url: `https://example.com/${index}`, content: '摘要' })) } }
      }
    }
  })
  assert.equal(service.resolveProvider(), 'tavily')
  const result = await service.search('测试查询', { maxResults: 99 })
  assert.equal(captured.url, 'https://api.tavily.com/search')
  assert.equal(captured.body.max_results, 8)
  assert.equal(result.results.length, 8)
  assert.equal(result.answer, '答案')
})

test('search is unavailable without a configured provider and rejects empty queries', async () => {
  const service = createWebSearch({ provider: 'auto' })
  assert.equal(service.available(), false)
  await assert.rejects(() => service.search('测试'), /未配置/)
  const configured = createWebSearch({ provider: 'deepseek', deepseekApiKey: 'key', request: { post: async () => ({ data: { output_text: 'ok' } }) } })
  await assert.rejects(() => configured.search('   '), /不能为空/)
})

test('provider errors are bounded and do not expose credentials or response bodies', async () => {
  const service = createWebSearch({
    provider: 'deepseek',
    deepseekApiKey: 'secret-key',
    request: {
      post: async () => {
        const error = new Error('upstream response contained secret-key')
        error.response = { status: 401, data: { message: 'secret-key' } }
        throw error
      }
    }
  })
  await assert.rejects(() => service.search('测试'), (error) => {
    assert.match(error.message, /HTTP 401/)
    assert.equal(error.message.includes('secret-key'), false)
    return true
  })
})
