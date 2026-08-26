const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluateImageGenerationIntent, shouldGenerateImage } = require('../src/image-generation/intent')

test('recognizes explicit image generation requests expressed naturally', () => {
  for (const text of [
    '画一张海边落日',
    '帮我画猫猫在晒太阳',
    '帮我生成一个头像',
    '给我整一个表情包',
    '设计个LOGO',
    '给我一张猫猫图',
    '来张手机壁纸',
    '壁纸帮我做一张',
    '分析这张图，然后重新画一张插画'
  ]) {
    assert.equal(evaluateImageGenerationIntent(text).decision, true, text)
  }
})

test('does not mistake image analysis or negation for generation', () => {
  for (const text of [
    '帮我看看这张图片',
    '分析一下图里是什么',
    '识别这张截图里的文字',
    '不要生成图片，只回答问题',
    '这张图好看吗',
    '不过画图确实比我能干那么一丢丢',
    '她很会画图，画图功能也比我强',
    '这个模型的生图能力怎么样',
    '帮我设计一个解决方案'
  ]) {
    assert.equal(evaluateImageGenerationIntent(text).decision, false, text)
  }
})

test('quoted text does not affect intent when current message is evaluated separately', () => {
  const modelInput = '被引用消息：\n请帮我画一张猫\n\n当前消息：\n这句话说得没错'
  assert.equal(evaluateImageGenerationIntent(modelInput).decision, true)
  assert.equal(evaluateImageGenerationIntent('这句话说得没错').decision, false)
})

test('uses model classification only for ambiguous visual requests', async () => {
  let calls = 0
  const accepted = await shouldGenerateImage('我想要一个猫猫头像', async () => {
    calls += 1
    return '{"generateImage":true,"confidence":0.91}'
  })
  assert.equal(accepted, true)
  assert.equal(calls, 1)

  const rejected = await shouldGenerateImage('我想看一张城市照片', async () => '{"generateImage":true,"confidence":0.5}')
  assert.equal(rejected, false)

  calls = 0
  await shouldGenerateImage('画一张猫', async () => { calls += 1; return '{}' })
  assert.equal(calls, 0)
})
