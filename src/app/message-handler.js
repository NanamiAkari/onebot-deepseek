const { chatKeyFromPayload } = require('../agent/tool-metadata')

function createMessageHandler(deps) {
  const {
    pending,
    pokeCooldown,
    mediaCache,
    sendRegistry,
    getKey,
    pushHistory,
    recordGroupMessage,
    getRecentGroupContext,
    getHistoryRaw,
    sendAction,
    extractContent,
    resolveMediaSources,
    checkMention,
    checkModeration,
    classifyAddressing,
    handleCommands,
    isCommandMessage,
    handleImageGenerationRequest,
    handleScheduleTaskDraftInput,
    handleCustomReplyDraftInput,
    handleCustomReplyMatch,
    hasCustomReplyTrigger,
    shouldIgnoreText,
    GROUP_REQUIRE_MENTION,
    REQUIRE_PREFIX,
    PREFIXES,
    shouldRespond,
    stripPrefix,
    AI_NAME_INTENT_ENABLE,
    AI_NAME_INTENT_THRESHOLD,
    getContext,
    memberMemory,
    agentRunner,
    aiRequestQueue,
    buildReplySegments,
    AI_POKE_ENABLE,
    AI_POKE_COOLDOWN,
    AI_POKE_REPLY_TEXT,
    AI_POKE_REPLY_TEXTS,
    getPokeReplyTexts,
    AI_POKE_ONLY_SELF,
    buildPokeReplyMessageSegments,
    rememberPokeReplyMessage,
    AI_REPLY_CHUNK_CHARS,
    AI_IMAGE_CONTEXT_TTL,
    AI_IMAGE_CONTEXT_REQUIRE_HINTS,
    AI_IMAGE_HINT_REGEX,
    AI_IMAGE_CONTEXT_MODE,
    AI_IMAGE_CONTEXT_REQUIRE_SAME_USER,
    AI_IMAGE_CONTEXT_MAX,
    AI_IMAGE_ONLY_NO_CALL
  } = deps
  let sendGroupPokeSupported = true
  const handledMessageIds = new Map()
  const handledMessageTtlMs = 10 * 60 * 1000
  const handledMessageMax = 2000
  const queueNoticeTimes = new Map()

  function normalizePokeReplyItem(item) {
    if (typeof item === 'string') {
      const content = String(item || '').replace(/\r/g, '').trim()
      return content ? { type: 'text', content } : null
    }
    if (!item || typeof item !== 'object') return null
    if (item.type === 'image') {
      const source = String(item.source || item.file || item.url || item.localPath || '').trim()
      return source ? { type: 'image', source } : null
    }
    const content = String(item.content || item.text || '').replace(/\r/g, '').trim()
    return content ? { type: 'text', content } : null
  }

  function pickPokeReply() {
    const dynamicList = typeof getPokeReplyTexts === 'function' ? getPokeReplyTexts() : null
    const list = Array.isArray(dynamicList) && dynamicList.length > 0
      ? dynamicList
      : Array.isArray(AI_POKE_REPLY_TEXTS) && AI_POKE_REPLY_TEXTS.length > 0
      ? AI_POKE_REPLY_TEXTS
      : [AI_POKE_REPLY_TEXT]
    return normalizePokeReplyItem(list[Math.floor(Math.random() * list.length)] || AI_POKE_REPLY_TEXT) || { type: 'text', content: AI_POKE_REPLY_TEXT }
  }

  function extractTextFromSegments(segments) {
    if (!Array.isArray(segments)) return ''
    return segments
      .filter((seg) => seg && seg.type === 'text' && seg.data && typeof seg.data.text === 'string')
      .map((seg) => seg.data.text)
      .join('')
  }

  function extractRemainingText(batches, startIndex) {
    if (!Array.isArray(batches)) return ''
    return batches
      .slice(startIndex)
      .map((segments) => extractTextFromSegments(segments))
      .filter(Boolean)
      .join('\n')
      .trim()
  }

  function normalizeMessageVariants(message) {
    if (!Array.isArray(message)) return [[{ type: 'text', data: { text: String(message || '') } }]]
    if (message.length > 0 && Array.isArray(message[0])) return message
    return [message]
  }

  async function sendReplyBatches(ws, action, payload, batches) {
    const sentTexts = []
    const chatKey = chatKeyFromPayload(payload)
    for (let index = 0; index < batches.length; index += 1) {
      const messageSegments = batches[index]
      const params = action === 'send_group_msg'
        ? { group_id: payload.group_id, message: messageSegments }
        : { user_id: payload.user_id, message: messageSegments }
      // 发送指纹与工具发送共用：模型已经用工具发过的同一段内容，不再由最终文本重发一遍。
      const print = sendRegistry && typeof sendRegistry.fingerprint === 'function'
        ? sendRegistry.fingerprint(chatKey, messageSegments)
        : ''
      if (print && typeof sendRegistry.isDuplicate === 'function' && sendRegistry.isDuplicate(print)) {
        console.log(`AI回复去重：${String(print).slice(0, 120)}`)
        const textPart = extractTextFromSegments(messageSegments)
        if (textPart) sentTexts.push(textPart)
        continue
      }
      let sendResult
      try {
        sendResult = await sendAction(ws, action, params)
      } catch (error) {
        if (error && error.message === 'timeout') return { ok: false, uncertain: true, failedIndex: index, sentTexts }
        return { ok: false, uncertain: false, failedIndex: index, sentTexts }
      }
      if (!(sendResult && sendResult.status === 'ok')) {
        return { ok: false, failedIndex: index, sentTexts }
      }
      // 只有协议端确认成功后才记账，失败和超时都保留正常重试的机会。
      if (print && typeof sendRegistry.markSent === 'function') sendRegistry.markSent(print)
      const textPart = extractTextFromSegments(messageSegments)
      if (textPart) sentTexts.push(textPart)
    }
    return { ok: true, failedIndex: -1, sentTexts }
  }

  function extractMentionedUserIds(message) {
    if (Array.isArray(message)) {
      return Array.from(new Set(message
        .filter((segment) => segment && segment.type === 'at' && segment.data && segment.data.qq)
        .map((segment) => String(segment.data.qq))))
    }
    const ids = []
    const regex = /\[CQ:at,qq=(\d+)\]/g
    let match
    while ((match = regex.exec(String(message || '')))) ids.push(match[1])
    return Array.from(new Set(ids))
  }

  function formatConversationText(originalText, strippedText, addressedByPrefix) {
    const original = String(originalText || '').trim()
    const actual = String(strippedText || '').trim()
    if (!addressedByPrefix || !original) return actual
    return [
      `用户原话：${original}`,
      '语义说明：句首“阿卡林”是用户对你的称呼和AI触发词，不默认充当后续内容的主语，也不要与紧随其后的成员昵称连成一个名字。',
      `实际话题：${actual || '用户只是在称呼你'}`
    ].join('\n')
  }

  async function resolveForwardedRecords(ws, forwardIds) {
    const records = []
    let chars = 0
    for (const forwardId of Array.isArray(forwardIds) ? forwardIds.slice(0, 3) : []) {
      const response = await sendAction(ws, 'get_forward_msg', { id: forwardId, message_id: forwardId }).catch(() => null)
      const nodes = response && response.status === 'ok' && response.data
        ? (response.data.messages || response.data.message || [])
        : []
      for (const node of Array.isArray(nodes) ? nodes.slice(0, 50) : []) {
        if (chars >= 5000) break
        const nodeMessage = node && (node.content || node.message)
        const extracted = extractContent(nodeMessage)
        const text = String(extracted.text || '').slice(0, 5000 - chars)
        chars += text.length
        records.push({
          userId: String(node.user_id || (node.sender && node.sender.user_id) || ''),
          nickname: String(node.nickname || (node.sender && (node.sender.card || node.sender.nickname)) || '').slice(0, 80),
          text,
          mediaTypes: Array.from(new Set((extracted.media || []).map((item) => item.kind))).slice(0, 10)
        })
      }
    }
    return records
  }

  return async function onMessage(ws, data) {
    try {
      let payload
      try {
        payload = JSON.parse(data.toString())
      } catch {
        return
      }
      if (payload && payload.echo && pending.has(payload.echo)) {
        const r = pending.get(payload.echo)
        pending.delete(payload.echo)
        r(payload)
        return
      }
      if (payload.post_type === 'notice' && payload.notice_type === 'notify' && payload.sub_type === 'poke') {
        if (!AI_POKE_ENABLE) return
        if (AI_POKE_ONLY_SELF) {
          const tgt = payload.target_id || payload.target || payload.receiver_id || payload.to_id
          if (tgt && String(tgt) !== String(payload.self_id)) return
        }
        const gid = payload.group_id
        const uid = payload.user_id
        const key = `${gid || 'priv'}:${uid}`
        const now = Date.now()
        const last = pokeCooldown.get(key) || 0
        if (now - last < AI_POKE_COOLDOWN * 1000) return
        pokeCooldown.set(key, now)
        const pokeReply = pickPokeReply()
        if (gid) {
          try {
            if (sendGroupPokeSupported) {
              const pokeResult = await sendAction(ws, 'send_group_poke', { group_id: gid, user_id: uid }).catch(() => null)
              if (!(pokeResult && pokeResult.status === 'ok')) sendGroupPokeSupported = false
            }
            const built = typeof buildPokeReplyMessageSegments === 'function'
              ? await buildPokeReplyMessageSegments(pokeReply)
              : [{ type: 'text', data: { text: pokeReply && pokeReply.content ? pokeReply.content : AI_POKE_REPLY_TEXT } }]
            const variants = normalizeMessageVariants(built)
            for (const msg of variants) {
              const result = await sendAction(ws, 'send_group_msg', { group_id: gid, message: msg }).catch(() => null)
              if (result && result.status === 'ok') {
                if (typeof rememberPokeReplyMessage === 'function') rememberPokeReplyMessage(result, pokeReply)
                break
              }
            }
          } catch {}
        } else {
          try {
            const built = typeof buildPokeReplyMessageSegments === 'function'
              ? await buildPokeReplyMessageSegments(pokeReply)
              : [{ type: 'text', data: { text: pokeReply && pokeReply.content ? pokeReply.content : AI_POKE_REPLY_TEXT } }]
            const variants = normalizeMessageVariants(built)
            for (const msg of variants) {
              const result = await sendAction(ws, 'send_private_msg', { user_id: uid, message: msg }).catch(() => null)
              if (result && result.status === 'ok') {
                if (typeof rememberPokeReplyMessage === 'function') rememberPokeReplyMessage(result, pokeReply)
                break
              }
            }
          } catch {}
        }
        return
      }
      if (payload.post_type !== 'message') return
      if (payload.self_id && String(payload.user_id) === String(payload.self_id)) return
      const incomingMessageId = String(payload.message_id || payload.messageId || '')
      if (incomingMessageId) {
        const now = Date.now()
        for (const [key, expiresAt] of handledMessageIds.entries()) {
          if (expiresAt <= now) handledMessageIds.delete(key)
        }
        const eventKey = `${payload.message_type || ''}:${payload.group_id || payload.user_id || ''}:${incomingMessageId}`
        if (handledMessageIds.has(eventKey)) return
        handledMessageIds.set(eventKey, now + handledMessageTtlMs)
        while (handledMessageIds.size > handledMessageMax) handledMessageIds.delete(handledMessageIds.keys().next().value)
      }
      const isGroup = payload.message_type === 'group'
      const raw = extractContent(payload.message)
      const originalText = raw.text
      if (typeof recordGroupMessage === 'function') recordGroupMessage(payload, raw.text)
      const memoryRelations = { mentionedUserIds: extractMentionedUserIds(payload.message), replyToUserId: '', media: [], forwarded: [] }
      raw.media = await resolveMediaSources(ws, raw.media)
      // 排查「机器人说没收到图片」：打印段类型、图片来源字段名和可用数量，不打印内容。
      const PLAIN_SEGMENTS = new Set(['text', 'at', 'reply', 'face', 'emoji'])
      const richSegments = Array.isArray(payload.message)
        ? payload.message.filter((seg) => seg && !PLAIN_SEGMENTS.has(seg.type))
        : (/\[CQ:(?:image|mface|video|record|audio|forward|json|xml)/.test(String(payload.message || '')) ? [{ type: 'cq-string' }] : [])
      if (richSegments.length > 0) {
        const describe = richSegments
          .map((seg) => (seg.type === 'cq-string' ? 'cq-string' : `${seg.type}:${Object.keys(seg.data || {}).join('+') || '-'}`))
          .join(',')
        const images = (raw.media || []).filter((item) => item && item.kind === 'image')
        const usable = images.filter((item) => item.localPath || item.url || item.inlineBase64).length
        console.log(`入站段=${describe} 图片=${images.length} 可用=${usable}`)
      }
      memoryRelations.media = (raw.media || []).map((item) => ({
        kind: String(item.kind || ''),
        file: String(item.file || '').slice(0, 200),
        duration: Math.max(0, Number(item.duration || 0))
      })).filter((item) => item.kind).slice(0, 20)
      memoryRelations.forwarded = await resolveForwardedRecords(ws, raw.forwardIds)
      const key = getKey(payload)
      let ctxImgUsed = false
      // 当前消息本身就是表情包但没取到图时，不要把缓存里上一张图塞进来——
      // 模型会去描述那张旧图，看起来像“读到了表情包”，实际是拿错图。
      const stickerWithoutImage = /\[表情包\]/.test(String(raw.text || '')) && !(raw.media && raw.media.length > 0)
      if (raw.media && raw.media.length > 0) {
        mediaCache.set(key, { media: raw.media.slice(0, AI_IMAGE_CONTEXT_MAX), ts: Date.now(), userId: payload.user_id })
      } else if (stickerWithoutImage) {
        console.log('上下文图片：当前是表情包但没有取到图，跳过缓存避免拿错图')
      } else {
        const cached = mediaCache.get(key)
        if (cached && Date.now() - cached.ts <= AI_IMAGE_CONTEXT_TTL * 1000) {
          const textNow = String(raw.text || '')
          let hintsOk = !AI_IMAGE_CONTEXT_REQUIRE_HINTS || AI_IMAGE_HINT_REGEX.test(textNow)
          if (AI_IMAGE_CONTEXT_MODE === 'ai') hintsOk = true
          const userOk = !AI_IMAGE_CONTEXT_REQUIRE_SAME_USER || String(payload.user_id) === String(cached.userId)
          console.log(`上下文图片：age=${Math.round((Date.now() - cached.ts) / 1000)}s hints=${hintsOk} sameUser=${userOk} 采用=${hintsOk && userOk}`)
          if (hintsOk && userOk) {
            raw.media = (raw.media || []).concat(cached.media).slice(0, AI_IMAGE_CONTEXT_MAX)
            ctxImgUsed = true
          }
        } else if (cached) {
          console.log(`上下文图片：已过期 age=${Math.round((Date.now() - cached.ts) / 1000)}s ttl=${AI_IMAGE_CONTEXT_TTL}s`)
        }
      }
      const content = raw
      if (content.replyId) {
        const resp = await sendAction(ws, 'get_msg', { message_id: content.replyId }).catch(() => null)
        if (resp && resp.status === 'ok' && resp.data && resp.data.message) {
          const q = extractContent(resp.data.message)
          const quotedText = String(q.text || '').trim()
          q.media = await resolveMediaSources(ws, q.media)
          if (q.media && q.media.length > 0) {
            const quotedImages = q.media.filter((item) => item && item.kind === 'image')
            if (quotedImages.length > 0) {
              const usable = quotedImages.filter((item) => item.localPath || item.url || item.inlineBase64).length
              const types = Array.isArray(resp.data.message)
                ? resp.data.message.map((seg) => (seg && seg.type) || 'unknown').join(',')
                : 'cq-string'
              console.log(`引用图片=${quotedImages.length} 可用=${usable} 段=${types}`)
            }
          }
          const merged = content.media ? content.media.slice() : []
          if (q.media && q.media.length) {
            for (const m of q.media) {
              merged.push(m)
              if (merged.length >= AI_IMAGE_CONTEXT_MAX) break
            }
            content.media = merged
          }
          if (quotedText) content.quotedText = quotedText
          // 引用的是纯图片/表情包时补一个占位，至少让模型知道引用的东西里有图。
          else if ((q.media || []).some((item) => item && item.kind === 'image')) content.quotedText = '[图片]'
          memoryRelations.replyToUserId = String(resp.data.user_id || (resp.data.sender && resp.data.sender.user_id) || '')
        } else {
          console.log(`引用消息读取失败 id=${content.replyId}`)
        }
      }
      // 表情包的图实在取不到时，明确告诉模型“图片未能加载”，避免它假装看见或去描述缓存里的旧图。
      if (/\[表情包\]/.test(String(content.text || '')) && !(content.media && content.media.length > 0)) {
        content.text = String(content.text).replace(/\[表情包\]/g, '[表情包（图片未能加载）]')
      }
      if (memberMemory && typeof memberMemory.recordMessage === 'function') {
        try { memberMemory.recordMessage(payload, originalText, memoryRelations) } catch (error) {
          console.log('成员消息归档失败', error && error.message ? error.message : error)
        }
      }
      const scheduleDraftHandled = await handleScheduleTaskDraftInput(ws, payload).catch(() => false)
      if (scheduleDraftHandled) return
      const customDraftHandled = await handleCustomReplyDraftInput(ws, payload).catch(() => false)
      if (customDraftHandled) return
      const mentioned = !isGroup || checkMention(payload.message, payload.self_id)
      const rawText = String(raw.text || '').trim()
      let prefixTriggered = shouldRespond(rawText)
      const requirePrefix = REQUIRE_PREFIX !== false
      const prefixMentioned = Array.isArray(PREFIXES) && PREFIXES.some((prefix) => prefix && rawText.includes(String(prefix)))
      const customReplyTriggered = isGroup && typeof hasCustomReplyTrigger === 'function'
        ? hasCustomReplyTrigger(payload.group_id, raw.text)
        : false
      if (isGroup) {
        const ban = await checkModeration(ws, payload.group_id, payload.user_id, payload.self_id, content.text).catch(() => false)
        if (ban) return
      }
      // 命令优先：命中命令就直接执行，跳过名称意图分类（一次模型调用）和后面的 AI/tool 选择。
      let commandAttempted = false
      if ((mentioned || prefixTriggered) && typeof isCommandMessage === 'function' && isCommandMessage(content.text)) {
        commandAttempted = true
        console.log('命令命中，直接执行（跳过意图分类和 AI）')
        const cmdHandled = await handleCommands(ws, payload, content.text).catch(() => false)
        if (cmdHandled) return
      }
      // A configured prefix at the beginning is already an explicit address. Keep
      // the model classifier for ambiguous in-message or trailing mentions so a
      // normal reply does not pay for two sequential model requests.
      if (isGroup && requirePrefix && AI_NAME_INTENT_ENABLE !== false && prefixMentioned && !prefixTriggered && typeof classifyAddressing === 'function') {
        try {
          const intentContext = {
            recentGroupMessages: typeof getRecentGroupContext === 'function'
              ? getRecentGroupContext(payload, rawText).map((item) => String(item.content || '')).filter(Boolean).slice(-8)
              : [],
            recentConversation: typeof getHistoryRaw === 'function'
              ? getHistoryRaw(payload).map((item) => `${item.role === 'assistant' ? '机器人' : '用户'}：${String(item.content || '')}`).filter(Boolean).slice(-8)
              : [],
            quotedText: String(content.quotedText || '').trim(),
            senderName: String((payload.sender && (payload.sender.card || payload.sender.nickname)) || '').trim().slice(0, 80)
          }
          const decision = await classifyAddressing(rawText, payload, intentContext)
          prefixTriggered = Boolean(decision && decision.addressed && Number(decision.confidence) >= Number(AI_NAME_INTENT_THRESHOLD))
        } catch (error) {
          prefixTriggered = false
          console.log('阿卡林意图判断失败', error && error.message ? error.message : 'unknown')
        }
      }
      const addressedByPrefix = prefixTriggered && stripPrefix(rawText) !== rawText
      const aiExplicitlyTriggered = isGroup && (mentioned || prefixTriggered)
      if (isGroup && GROUP_REQUIRE_MENTION && !mentioned && !customReplyTriggered) return
      if (isGroup && !GROUP_REQUIRE_MENTION && !mentioned && !prefixTriggered && !customReplyTriggered) return
      const cmdHandled = commandAttempted ? false : await handleCommands(ws, payload, content.text).catch(() => false)
      if (cmdHandled) return
      if (!aiExplicitlyTriggered) {
        const customMatched = await handleCustomReplyMatch(ws, payload, content.text).catch(() => false)
        if (customMatched) return
      }
      const hasText = Boolean(String(content.text || '').trim())
      const hasMedia = Array.isArray(content.media) && content.media.length > 0
      if (hasText && shouldIgnoreText(content.text)) return
      if (!hasText) {
        if (AI_IMAGE_ONLY_NO_CALL && hasMedia) return
        if (!hasMedia) return
      }
      const wantsReply = isGroup ? (aiExplicitlyTriggered || shouldRespond(content.text)) : hasText
      if (!wantsReply) return
      const stripped = stripPrefix(content.text || '') || (hasMedia ? '请描述这张图片' : '')
      const originalConversationText = addressedByPrefix
        ? (String(content.text || '').trim() || stripped)
        : stripped
      const conversationText = formatConversationText(originalConversationText, stripped, addressedByPrefix)
      const quotedText = String(content.quotedText || '').trim()
      const modelInput = quotedText && quotedText !== conversationText
        ? `被引用消息：\n${quotedText}\n\n当前消息：\n${conversationText || '请结合被引用消息继续回答'}`
        : conversationText
      const reply = async () => {
      if (typeof ws.readyState === 'number' && ws.readyState !== 1) return
      // Context is read when the queued turn starts, after the previous reply is saved.
      const hist = getContext(payload, stripped)
      const adjacentContext = typeof getRecentGroupContext === 'function'
        ? getRecentGroupContext(payload, stripped)
        : []
      const combinedHistory = hist
      const memoryContext = memberMemory && typeof memberMemory.buildStyleContext === 'function'
        ? memberMemory.buildStyleContext(payload)
        : ''
      const identityContext = memberMemory && typeof memberMemory.buildIdentityContext === 'function'
        ? memberMemory.buildIdentityContext(payload, stripped)
        : ''
      const adjacentText = adjacentContext.length
        ? adjacentContext.map((item) => String(item.content || '')).join('\n')
        : ''
      const promptParts = []
      if (identityContext) promptParts.push(`【记忆中的确定身份】\n${identityContext}`)
      if (adjacentText) promptParts.push(`【相邻群聊】\n${adjacentText}`)
      if (quotedText) promptParts.push(`【引用消息】\n${quotedText}`)
      promptParts.push(`【当前消息】\n${conversationText}`)
      const modelMessage = promptParts.join('\n\n')
      const combinedMemoryContext = memoryContext
      if (typeof handleImageGenerationRequest === 'function') {
        const imageGeneration = await handleImageGenerationRequest(ws, payload, modelInput, hist, stripped).catch((error) => {
          const message = error && error.message ? String(error.message) : String(error)
          console.log('生图处理异常', message)
          return { handled: false }
        })
        if (imageGeneration && imageGeneration.handled) {
          pushHistory(payload, originalConversationText, imageGeneration.deliveredText || '[已处理生图请求]')
          return
        }
      }
      const result = await agentRunner.run({
        message: modelMessage,
        media: content.media,
        history: combinedHistory,
        contextImage: ctxImgUsed,
        memoryContext: combinedMemoryContext,
        runtime: { ws, payload },
        session: {
          key,
          isGroup,
          groupId: payload.group_id || null,
          userId: payload.user_id || null
        }
      })
      const aiText = result && result.text
      if (!aiText) return
      const action = isGroup ? 'send_group_msg' : 'send_private_msg'
      const sentTexts = []
      const messageBatches = buildReplySegments(payload.message_id, aiText, { includeReply: Boolean(content.replyId) })
      const firstAttempt = await sendReplyBatches(ws, action, payload, messageBatches)
      sentTexts.push(...firstAttempt.sentTexts)
      if (!firstAttempt.ok) {
        if (firstAttempt.uncertain) {
          console.log(`AI回复发送状态未知，停止重发以避免重复发送 index=${firstAttempt.failedIndex + 1}/${messageBatches.length}`)
          pushHistory(payload, originalConversationText, sentTexts.join('\n').trim() || String(aiText || '').trim())
          return
        }
        console.log(`AI回复发送失败，尝试去掉引用重发 index=${firstAttempt.failedIndex + 1}/${messageBatches.length}`)
        const remainingText = extractRemainingText(messageBatches, firstAttempt.failedIndex)
        if (remainingText) {
          const retryBatches = buildReplySegments(payload.message_id, remainingText, {
            includeReply: false,
            maxChars: Math.max(remainingText.length + 32, 64),
            chunkSize: AI_REPLY_CHUNK_CHARS
          })
          const secondAttempt = await sendReplyBatches(ws, action, payload, retryBatches)
          sentTexts.push(...secondAttempt.sentTexts)
          if (!secondAttempt.ok) {
            if (secondAttempt.uncertain) {
              console.log(`AI回复重发状态未知，停止继续重发以避免重复发送 index=${secondAttempt.failedIndex + 1}/${retryBatches.length}`)
              pushHistory(payload, originalConversationText, sentTexts.join('\n').trim() || String(aiText || '').trim())
              return
            }
            const fallbackText = extractRemainingText(retryBatches, secondAttempt.failedIndex)
            const smallerChunkChars = Math.max(250, Math.min(AI_REPLY_CHUNK_CHARS - 1, Math.floor(AI_REPLY_CHUNK_CHARS * 0.6)))
            console.log(`AI回复发送失败，尝试更小分段重发 chunk=${smallerChunkChars}`)
            if (fallbackText) {
              const thirdBatches = buildReplySegments(payload.message_id, fallbackText, {
                includeReply: false,
                maxChars: Math.max(fallbackText.length + 32, 64),
                chunkSize: smallerChunkChars
              })
              const thirdAttempt = await sendReplyBatches(ws, action, payload, thirdBatches)
              sentTexts.push(...thirdAttempt.sentTexts)
              if (!thirdAttempt.ok) {
                console.log(`AI回复发送最终失败 index=${thirdAttempt.failedIndex + 1}/${thirdBatches.length}`)
              }
            }
          }
        } else {
          console.log('AI回复发送失败，未提取到可重发的剩余文本')
        }
      }
      const deliveredText = sentTexts.join('\n').trim() || String(aiText || '').trim()
      pushHistory(payload, originalConversationText, deliveredText)
      }
      try {
        if (aiRequestQueue) await aiRequestQueue.enqueue(key, reply)
        else await reply()
      } catch (error) {
        if (!error || !['QUEUE_FULL', 'QUEUE_EXPIRED', 'QUEUE_CLOSED'].includes(error.code)) throw error
        if (error.code === 'QUEUE_CLOSED' || (typeof ws.readyState === 'number' && ws.readyState !== 1)) return
        const now = Date.now()
        const last = queueNoticeTimes.get(key)
        if (last !== undefined && now - last < 30000) return
        queueNoticeTimes.delete(key)
        queueNoticeTimes.set(key, now)
        while (queueNoticeTimes.size > 1000) queueNoticeTimes.delete(queueNoticeTimes.keys().next().value)
        const text = error.code === 'QUEUE_EXPIRED'
          ? '这条请求等待太久了，请稍后重新发送。'
          : '现在等待回复的请求有点多，请稍后再试。'
        await sendReplyBatches(ws, isGroup ? 'send_group_msg' : 'send_private_msg', payload, buildReplySegments(payload.message_id, text))
      }
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error)
      console.log('onMessage异常', message)
    }
  }
}

module.exports = { createMessageHandler }
