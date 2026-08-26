const VISUAL_NOUN = '(?:图|图片|图像|照片|配图|插图|壁纸|头像|表情包|插画|海报|logo|LOGO|徽标|封面|立绘|图标|贴纸|梗图|像素画)'

const explicitIntentPatterns = [
  /^(?:请|麻烦)?(?:帮我|给我|替我|为我)?(?:画|绘制|生成|创作)(?!图功能|图能力|图水平|图技术).{1,80}$/i,
  /(?:请|麻烦|给我|帮我|替我|为我)?(?:画|绘制|生成|创作|制作|设计)(?:一下)?(?:一张|一幅|张|幅).{0,60}/i,
  new RegExp(`(?:请|麻烦|给我|帮我|替我|为我)?(?:画|绘制|生成|创作|制作|设计)(?:一下|一个|个)?[\\s\\S]{0,40}${VISUAL_NOUN}`, 'i'),
  /(?:文生图|生图|出图)(?:一下|一个|一张|一幅|吧|呗|好吗|可以吗|行吗)/i,
  new RegExp(`(?:生成|画|绘制|创作|设计|制作|做|整|弄|搞|来)(?:一下|一个|一张|一幅|个|张)?[\\s\\S]{0,60}${VISUAL_NOUN}`, 'i'),
  new RegExp(`(?:给我|帮我)[\\s\\S]{0,15}(?:生成|画|绘制|创作|设计|制作|做|整|弄|搞|来)[\\s\\S]{0,60}${VISUAL_NOUN}`, 'i'),
  new RegExp(`(?:给我|来)(?:一张|一个|一幅|张|个)[\\s\\S]{0,20}${VISUAL_NOUN}`, 'i'),
  new RegExp(`${VISUAL_NOUN}[\\s\\S]{0,30}(?:生成|画|绘制|创作|设计|制作|做|整|弄|搞)(?:一下|一个|一张|一幅)?`, 'i')
]

const discussionPatterns = [
  /(?:会|不会|能|不能|擅长|善于|学会|尝试|喜欢|讨厌).{0,20}(?:画图|绘图|作图|生图|出图|生成图片)/i,
  /(?:画图|绘图|作图|生图|出图|生成图片).{0,25}(?:功能|能力|水平|技术|模型|确实|厉害|很强|更强|比较|怎么样|好用|不好用|能干)/i,
  /(?:画图|绘图|作图|生图|出图).{0,20}(?:比|不如).{0,20}(?:我|你|他|她|它|谁)/i,
  /(?:我|你|他|她|它|谁).{0,20}(?:比|不如).{0,20}(?:会|能|擅长)?.{0,12}(?:画图|绘图|作图|生图|出图)/i
]

const deniedIntentPatterns = [
  new RegExp(`(?:不要|不用|别|无需|不需要)[\\s\\S]{0,20}(?:生成|画|绘制|创作|设计|制作|生图|出图)`, 'i'),
  new RegExp(`(?:不是|并非)[\\s\\S]{0,12}(?:要|想)[\\s\\S]{0,12}(?:生成|画|生图|出图)`, 'i')
]

const analysisPatterns = [
  new RegExp(`(?:看看|看一下|分析|识别|描述|解释|评价|点评|翻译|提取|读取|总结|判断)[\\s\\S]{0,30}(?:这张|这个|上面|刚才|发的)?${VISUAL_NOUN}`, 'i'),
  /(?:图里|图中|图片里|图片中|截图里|截图中).{0,30}(?:是什么|有什么|写了什么|什么意思|怎么了|是谁)/i,
  /(?:这张图|这个图|这幅图|这张图片|这张照片).{0,30}(?:是什么|怎么样|好看吗|什么意思|写了什么)/i
]

const ambiguousPatterns = [
  new RegExp(`(?:想要|想看|需要|希望|能否|能不能|可不可以|可以不可以|可以给我|麻烦)[\\s\\S]{0,60}${VISUAL_NOUN}`, 'i'),
  new RegExp(`${VISUAL_NOUN}[\\s\\S]{0,40}(?:想要|需要|安排|来一个|来一张)`, 'i'),
  /(?:文生图|生图|出图|画图|绘图|作图|生成图片|生成图像)/i
]

function evaluateImageGenerationIntent(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return { decision: false, reason: 'empty' }
  if (deniedIntentPatterns.some((pattern) => pattern.test(value))) return { decision: false, reason: 'denied' }
  if (discussionPatterns.some((pattern) => pattern.test(value))) return { decision: false, reason: 'discussion' }
  if (explicitIntentPatterns.some((pattern) => pattern.test(value))) return { decision: true, reason: 'explicit' }
  if (analysisPatterns.some((pattern) => pattern.test(value))) return { decision: false, reason: 'analysis' }
  if (ambiguousPatterns.some((pattern) => pattern.test(value))) return { decision: null, reason: 'ambiguous' }
  return { decision: false, reason: 'unrelated' }
}

function parseClassifierResult(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed
  try { parsed = JSON.parse(text) } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { return null }
  }
  if (!parsed || typeof parsed.generateImage !== 'boolean') return null
  return {
    generateImage: parsed.generateImage,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0)))
  }
}

async function shouldGenerateImage(text, classify, threshold = 0.75) {
  const evaluated = evaluateImageGenerationIntent(text)
  if (evaluated.decision !== null) return evaluated.decision
  if (typeof classify !== 'function') return false
  try {
    const result = parseClassifierResult(await classify(String(text || '').trim()))
    return Boolean(result && result.generateImage && result.confidence >= threshold)
  } catch {
    return false
  }
}

module.exports = { evaluateImageGenerationIntent, parseClassifierResult, shouldGenerateImage }
