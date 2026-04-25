function createMessageHandler(deps) {
  const {
    pending,
    pokeCooldown,
    mediaCache,
    getKey,
    pushHistory,
    sendAction,
    extractContent,
    resolveMediaSources,
    checkMention,
    checkModeration,
    handleCommands,
    shouldIgnoreText,
    GROUP_REQUIRE_MENTION,
    shouldRespond,
    stripPrefix,
    getContext,
    agentRunner,
    buildReplySegments,
    AI_POKE_ENABLE,
    AI_POKE_COOLDOWN,
    AI_POKE_REPLY_TEXT,
    AI_POKE_REPLY_TEXTS,
    getPokeReplyTexts,
    AI_POKE_ONLY_SELF,
    buildPokeReplyMessageSegments,
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

  async function sendReplyBatches(ws, action, payload, batches) {
    const sentTexts = []
    for (let index = 0; index < batches.length; index += 1) {
      const messageSegments = batches[index]
      const params = action === 'send_group_msg'
        ? { group_id: payload.group_id, message: messageSegments }
        : { user_id: payload.user_id, message: messageSegments }
      const sendResult = await sendAction(ws, action, params).catch(() => null)
      if (!(sendResult && sendResult.status === 'ok')) {
        return { ok: false, failedIndex: index, sentTexts }
      }
      const textPart = extractTextFromSegments(messageSegments)
      if (textPart) sentTexts.push(textPart)
    }
    return { ok: true, failedIndex: -1, sentTexts }
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
            const msg = typeof buildPokeReplyMessageSegments === 'function'
              ? await buildPokeReplyMessageSegments(pokeReply)
              : [{ type: 'text', data: { text: pokeReply && pokeReply.content ? pokeReply.content : AI_POKE_REPLY_TEXT } }]
            await sendAction(ws, 'send_group_msg', { group_id: gid, message: msg }).catch(() => {})
          } catch {}
        } else {
          try {
            const msg = typeof buildPokeReplyMessageSegments === 'function'
              ? await buildPokeReplyMessageSegments(pokeReply)
              : [{ type: 'text', data: { text: pokeReply && pokeReply.content ? pokeReply.content : AI_POKE_REPLY_TEXT } }]
            await sendAction(ws, 'send_private_msg', { user_id: uid, message: msg })
          } catch {}
        }
        return
      }
      if (payload.post_type !== 'message') return
      const isGroup = payload.message_type === 'group'
      const raw = extractContent(payload.message)
      raw.media = await resolveMediaSources(ws, raw.media)
      const key = getKey(payload)
      let ctxImgUsed = false
      if (raw.media && raw.media.length > 0) {
        mediaCache.set(key, { media: raw.media.slice(0, AI_IMAGE_CONTEXT_MAX), ts: Date.now(), userId: payload.user_id })
      } else {
        const cached = mediaCache.get(key)
        if (cached && Date.now() - cached.ts <= AI_IMAGE_CONTEXT_TTL * 1000) {
          const textNow = String(raw.text || '')
          let hintsOk = !AI_IMAGE_CONTEXT_REQUIRE_HINTS || AI_IMAGE_HINT_REGEX.test(textNow)
          if (AI_IMAGE_CONTEXT_MODE === 'ai') hintsOk = true
          const userOk = !AI_IMAGE_CONTEXT_REQUIRE_SAME_USER || String(payload.user_id) === String(cached.userId)
          if (hintsOk && userOk) {
            raw.media = (raw.media || []).concat(cached.media).slice(0, AI_IMAGE_CONTEXT_MAX)
            ctxImgUsed = true
          }
        }
      }
      const mentioned = !isGroup || checkMention(payload.message, payload.self_id)
      const prefixTriggered = shouldRespond(raw.text)
      if (isGroup && GROUP_REQUIRE_MENTION && !mentioned) return
      if (isGroup && !GROUP_REQUIRE_MENTION && !mentioned && !prefixTriggered) return
      const content = raw
      if ((!content.media || content.media.length === 0) && content.replyId) {
        const resp = await sendAction(ws, 'get_msg', { message_id: content.replyId }).catch(() => null)
        if (resp && resp.status === 'ok' && resp.data && resp.data.message) {
          const q = extractContent(resp.data.message)
          q.media = await resolveMediaSources(ws, q.media)
          const merged = content.media ? content.media.slice() : []
          if (q.media && q.media.length) {
            for (const m of q.media) {
              merged.push(m)
              if (merged.length >= AI_IMAGE_CONTEXT_MAX) break
            }
            content.media = merged
          }
          if (!content.text && q.text) content.text = q.text
        }
      }
      if (isGroup) {
        const ban = await checkModeration(ws, payload.group_id, payload.user_id, payload.self_id, content.text).catch(() => false)
        if (ban) return
      }
      const cmdHandled = await handleCommands(ws, payload, content.text).catch(() => false)
      if (cmdHandled) return
      const hasText = Boolean(String(content.text || '').trim())
      const hasMedia = Array.isArray(content.media) && content.media.length > 0
      if (hasText && shouldIgnoreText(content.text)) return
      if (!hasText) {
        if (AI_IMAGE_ONLY_NO_CALL && hasMedia) return
        if (!hasMedia) return
      }
      const wantsReply = isGroup ? shouldRespond(content.text) : hasText
      if (!wantsReply) return
      const stripped = stripPrefix(content.text || '') || (hasMedia ? '请描述这张图片' : '')
      const hist = getContext(payload, stripped)
      const result = await agentRunner.run({
        message: stripped,
        media: content.media,
        history: hist,
        contextImage: ctxImgUsed,
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
      const messageBatches = buildReplySegments(payload.message_id, aiText)
      const firstAttempt = await sendReplyBatches(ws, action, payload, messageBatches)
      sentTexts.push(...firstAttempt.sentTexts)
      if (!firstAttempt.ok) {
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
      pushHistory(payload, stripped, deliveredText)
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error)
      console.log('onMessage异常', message)
    }
  }
}

module.exports = { createMessageHandler }
