/**
 * IndexTTS 语音朗读 —— Client 半部（code.client）
 *
 * 功能：
 *   1. 设置页（settings.section「语音朗读」）：API Key、音色上传/列表/删除/选择、语速、
 *      采样率、增益、试听。
 *   2. 播放按钮（conversation.chat.assistant-actions「朗读」）：在每条 agent 回复末尾的
 *      操作栏加一个喇叭按钮，点击朗读该条回复的正文（text 块；排除 reasoning 思考块与
 *      tool 块）。
 *   3. 文本过滤：清洗颜文字/装饰符号（移植自 skills/index-tts-compshare 的 text.py）、
 *      剔除 emoji、剥离常见 markdown 语法。
 *   4. 分段合成：块大小渐增 100→200→400→600（首段小=快速开播，前几段播放时间为后续大段
 *      合成留足提前量）；按段落 → 句子贪心切割。点击播放后按段序并发合成（每会话有界并发
 *      上限 2），第一段返回即播，播放期间预载下一段到第二个 <audio> 元素（main/aux 交替）
 *      实现近零延迟切换。
 *   5. 浏览器音频缓存：以「请求参数（model/input/voice/speed/sample_rate/gain + apiKey 指纹）
 *      参数字符串」为 key，合成音频（blob URL）缓存于浏览器内存，重复播放同段文本不再重复调
 *      API；停止后未播出的在途合成仍写入缓存，未开始的段不再启动。
 *   6. 优先级重试：当前播放会话（high）短退避优先重试，后台/残留会话（low）让路。
 *
 * 网络：全部通过浏览器 XMLHttpRequest 直连 https://api.modelverse.cn/v1
 * （GET/POST JSON/FormData 上传均已实测通过 CORS）。
 *
 * 加载方式：作为 cordis_define 的 code.client 参数内容（async 函数体，return 插件对象）。
 * 约束：纯 JavaScript，无 JSX / TypeScript / import；React 一律 React.createElement。
 */

return {
  inject: ['timer'],
  apply(ctx) {
    styles.insert([
      '.itts-action{display:inline-flex;align-items:center;gap:4px;margin-left:2px}',
      '.itts-btn{all:unset;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;color:var(--dsw-text-secondary,#8a8f98);cursor:pointer;box-sizing:border-box}',
      '.itts-btn:hover{background:rgba(127,127,127,.14);color:var(--dsw-text-primary,#1f2329)}',
      '.itts-btn[data-active="true"]{color:var(--dsw-accent,#4f7cff)}',
      '.itts-status{font-size:11px;line-height:1;color:var(--dsw-text-tertiary,#9aa0a6);margin-left:4px;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}',
      '.itts-status[data-error="true"]{color:var(--dsw-danger,#d93026)}',
      '.itts-settings{display:flex;flex-direction:column;gap:14px;padding:4px 2px;font-size:13px;color:var(--dsw-text-primary,#1f2329)}',
      '.itts-field{display:flex;flex-direction:column;gap:6px}',
      '.itts-input{box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-border,#d0d4da);border-radius:6px;background:var(--dsw-bg-input,#fff);color:inherit;font-size:13px;min-width:0}',
      '.itts-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.itts-inline{flex:1;min-width:120px}',
      '.itts-btn-action{padding:6px 12px;border:1px solid var(--dsw-border,#d0d4da);border-radius:6px;background:var(--dsw-bg-raised,#fff);color:inherit;font-size:13px;cursor:pointer}',
      '.itts-btn-action:hover{background:rgba(127,127,127,.08)}',
      '.itts-btn-danger{padding:6px 12px;border:1px solid rgba(217,48,38,.4);border-radius:6px;background:transparent;color:var(--dsw-danger,#d93026);font-size:13px;cursor:pointer}',
      '.itts-hint{font-size:12px;color:var(--dsw-text-tertiary,#9aa0a6)}',
      '.itts-ok{font-size:12px;color:#1a7f37}',
      '.itts-err{font-size:12px;color:var(--dsw-danger,#d93026)}',
    ].join('\n'))

    const API_BASE = 'https://api.modelverse.cn/v1'
    const MODEL = 'IndexTeam/IndexTTS-2'
    const MAX_CHARS = 600
    // 分段大小渐增：100 → 200 → 400 → 600…，首段小=快速开播，前几段播放时间为后续大段合成留足提前量
    const SEGMENT_SIZES = [100, 200, 400]

    // ---------- 文本过滤：颜文字 / emoji / markdown ----------
    const KAOMOJI_INSIDE = '๑๒ㅂㅋㅎㅇ￣￢•づヅノヽﾉゞヾゝωΩΣψ°º｡◕◜◝◞◟◠◡◉◎⊙☉◍●○◐◑△▽◇□■☆★✰˘ςᴗʖʕʔˁ❤♡♥❥❣✧✦✨✩✪✫✬❀❁ﾟ･゜゚┻━┬╯╰╮╭┌└₍₎´ˋ`̀̂̃̑≧≦∀▰▱و٦٧٨٩۶'
    const LEAD = '╭╰╮╯'
    const DECOR = '✧✦✨❤♡♥❥❣☆★✩✪✫✬❀❁ﾟ゜゚･・ヽヾﾉノづヅゝゞ╮╯╭╰ヮو٦٧٨٩۶*～~︵┻━┬'
    const PUNCT_ONLY = '・_｡･ﾟ゜＊* \t'
    const ASCII_EMOTICON = "=^><;:_oO0vV*.,'~/Tt0-"
    // ASCII 表情判定除「全在允许字符集内」外，还需至少一个「脸部特征」字符
    // （^ _ > < = ; : T t ' ~ /），避免 (00)、(..)、(o.o)、(0-0)、(0*0) 这类纯标点/数字的
    // 正常括号被当作颜文字误删（review #15；第六轮复审后去掉 -/*，(-_-)、(*_*) 等仍靠 _ 正常剔除）。
    const ASCII_FACE = "^_><=;:Tt'~/"
    const TRAILING_HARD = '✧✦✨❤♡♥❥❣☆★✩✪✫✬❀❁ﾟ゜゚･・♪♫♬'

    const escClass = function (s) {
      return s.split('').map(function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4) }).join('')
    }
    const PAREN_RE = new RegExp('(?<lead>[' + escClass(LEAD) + ']?)[\\(（](?<content>[^\\)）\\n]*)[\\)）](?<decor>[' + escClass(DECOR) + ']*)', 'g')
    const TRAILING_RE = new RegExp('[ \\t]*(?<hard>[' + escClass(TRAILING_HARD) + '])+[ \\t]*(?:[～~][ \\t]*)?$')

    function isKaomojiContent(content) {
      if (!content) return false
      for (let i = 0; i < content.length; i++) { if (KAOMOJI_INSIDE.indexOf(content[i]) >= 0) return true }
      let allPunct = content.length > 0
      for (let i = 0; i < content.length; i++) { if (PUNCT_ONLY.indexOf(content[i]) < 0) { allPunct = false; break } }
      if (allPunct) return true
      if (content.length >= 2) {
        let allAscii = true
        let hasFace = false
        for (let i = 0; i < content.length; i++) {
          const ch = content[i]
          if (ASCII_EMOTICON.indexOf(ch) < 0) { allAscii = false; break }
          if (ASCII_FACE.indexOf(ch) >= 0) hasFace = true
        }
        if (allAscii && hasFace) return true
      }
      return false
    }

    function stripKaomoji(text) {
      if (!text) return text
      text = text.replace(PAREN_RE, function (m, lead, content, decor, offset, str, groups) {
        return isKaomojiContent(groups.content) ? '' : m
      })
      text = text.replace(TRAILING_RE, '')
      return text
    }

    // 整段剔除 emoji：ZWJ 序列（含 VS16 在 ZWJ 前的形态，如 ❤️‍🔥）、变体选择符/键帽、
    // 旗帜（Regional_Indicator 对）、肤色修饰；ZWJ 若不在 emoji 序列中则保留，
    // 避免破坏阿拉伯语/印度语等依赖 U+200D 合字的正常文本。
    const EMOJI_RE = /(?:\p{Extended_Pictographic}(?:[\uFE0F\u20E3]?\u200D\p{Extended_Pictographic})*[\uFE0F\u20E3]?)|(?:\p{Regional_Indicator}{2})|(?:[\u0023\u002A\u0030-\u0039]\uFE0F?\u20E3)|[\u{1F3FB}-\u{1F3FF}]/gu

    function stripMarkdown(text) {
      return text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(^|[\s(（])\*([^*\n]+)\*(?=$|[\s),.。！？!?；;])/g, '$1$2')
        .replace(/(^|[\s(（])_([^_\n]+)_(?=$|[\s),.。！？!?；;])/g, '$1$2')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^-{3,}$/gm, ' ')
        .replace(/\s*\|\s*/g, '，')
        .replace(/\r/g, '')
    }

    function filterText(text) {
      if (!text) return ''
      let out = stripKaomoji(text)
      out = out.replace(EMOJI_RE, '')
      out = stripMarkdown(out)
      out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      return out.trim()
    }

    // ---------- 分段（段落/句子；块大小渐增 100→200→400→600，首段小=降低首句延迟） ----------
    function splitForTts(text, max) {
      const paras = text.split(/\n+/).map(function (p) { return p.trim() }).filter(Boolean)
      const chunks = []
      let cur = ''
      let chunkCount = 0
      const budget = function () {
        return chunkCount < SEGMENT_SIZES.length ? SEGMENT_SIZES[chunkCount] : max
      }
      const flush = function () { if (cur) { chunks.push(cur); cur = ''; chunkCount += 1 } }
      const add = function (seg) {
        const s = String(seg).replace(/\s+/g, ' ').trim()
        if (!s) return
        if (s.length > budget()) {
          if (cur) flush()
          let rest = s
          while (rest.length >= budget()) {
            const b = budget()
            const piece = rest.slice(0, b)
            rest = rest.slice(b)
            cur = piece
            flush()
          }
          if (rest) add(rest)
          return
        }
        const b = budget()
        const joined = cur ? cur + ' ' + s : s
        if (joined.length <= b) { cur = joined } else { flush(); cur = s }
      }
      for (let i = 0; i < paras.length; i++) {
        const para = paras[i]
        if (para.length <= budget()) {
          add(para)
        } else {
          const sentences = para.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [para]
          for (let j = 0; j < sentences.length; j++) add(sentences[j])
        }
      }
      flush()
      return chunks
    }

    // ---------- IndexTTS-2 API ----------
    // 单次请求；429 / 5xx / 网络错误 / 超时 标记为可重试（retryable），并保留 status。
    // 用 settled 标志保证只 settle 一次：网络错误/超时由 onerror/ontimeout 处理，
    // loadend 只处理有 HTTP 状态的响应（status=0 时已由前两者处理，避免重复 reject）。
    function xhrRaw(method, path, apiKey, body, responseType, timeoutMs) {
      return new Promise(function (resolve, reject) {
        let settled = false
        const fail = function (err) { if (settled) return; settled = true; reject(err) }
        const succeed = function (x) { if (settled) return; settled = true; resolve(x) }
        const x = new XMLHttpRequest()
        x.open(method, API_BASE + path)
        x.setRequestHeader('Authorization', 'Bearer ' + apiKey)
        if (typeof body === 'string') x.setRequestHeader('Content-Type', 'application/json')
        if (responseType) x.responseType = responseType
        x.timeout = timeoutMs || 30000
        x.onloadend = function () {
          if (x.status >= 200 && x.status < 300) { succeed(x); return }
          if (x.status === 0) return // 网络错误/超时已由 onerror/ontimeout 处理
          let msg = 'HTTP ' + x.status
          try {
            const raw = x.responseType === 'arraybuffer' ? new TextDecoder().decode(x.response) : (x.responseText || '')
            const j = JSON.parse(raw)
            if (j && j.error && j.error.message) msg = j.error.message
          } catch (e) {}
          const err = new Error(msg)
          err.status = x.status
          err.retryable = x.status === 429 || (x.status >= 500 && x.status < 600)
          fail(err)
        }
        x.onerror = function () {
          const err = new Error('网络错误')
          err.retryable = true
          fail(err)
        }
        x.ontimeout = function () {
          const err = new Error('请求超时')
          err.retryable = true
          fail(err)
        }
        x.send(body)
      })
    }

    // 通用重试（列表/删除等）：重试最多 3 次（共 4 次尝试），间隔 2s → 4s → 8s。
    // 仅对 429 / 5xx / 网络错误 / 超时 重试；其它 4xx（如 401 密钥错误）立即失败。
    function xhrJson(method, path, apiKey, body, responseType, timeoutMs) {
      const MAX_RETRIES = 3
      const attempt = function (n) {
        return xhrRaw(method, path, apiKey, body, responseType, timeoutMs).catch(function (err) {
          if (!(err && err.retryable) || n > MAX_RETRIES) throw err
          const delay = Math.min(2000 * Math.pow(2, n - 1), 8000)
          return ctx.timeout(delay).then(function () { return attempt(n + 1) })
        })
      }
      return attempt(1)
    }

    // 合成专用重试：支持优先级（session 为当前播放会话时 high，否则 low）。
    // high（用户当前要播的）短退避优先重试；low（后台/残留会话的缓存填充）让路：
    // 更长退避，并在 429 限流冷却期内等待，把 API 额度让给 high。
    let rateLimitCooldownUntil = 0
    const RATE_COOLDOWN_MS = 8000

    function xhrJsonSynth(payload, apiKey, session) {
      const body = JSON.stringify(payload)
      // 重试决策基于「当前最相关会话」：原会话已停止但该在途请求正被新会话（currentSession）
      // 复用（停止→立即重播同一条，见 #2 在途去重）时，以新会话为准继续按需重试，
      // 避免新播放首段被旧会话的 stopped 掐断（第六轮复审 A）；无新会话接管则照常停止重试。
      const effectiveSession = function () {
        if (session && session.stopped && currentSession && currentSession !== session) return currentSession
        return session
      }
      const attempt = function (n) {
        return xhrRaw('POST', '/audio/speech', apiKey, body, 'arraybuffer', 90000).catch(function (err) {
          const eff = effectiveSession()
          const high = !eff || eff.isCurrent
          if (!(err && err.retryable)) throw err
          // 会话已停止（且无新会话接管）：不再发起新的重试请求（避免停止后继续打 API）
          if (eff && eff.stopped) throw err
          const maxRetries = high ? 3 : 2
          if (n > maxRetries) throw err
          const base = high ? 1000 : 4000
          let delay = Math.min(base * Math.pow(2, n - 1), 8000)
          if (err.status === 429) {
            rateLimitCooldownUntil = Date.now() + RATE_COOLDOWN_MS
            delay = Math.max(delay, high ? 1000 : 4000)
          }
          if (!high) {
            const waitFor = rateLimitCooldownUntil - Date.now()
            if (waitFor > 0) delay = Math.max(delay, waitFor + 500)
          }
          return ctx.timeout(delay).then(function () {
            // 退避等待期间会话被停止（且无新会话接管）：不再发起新的重试请求（review #1）
            const eff2 = effectiveSession()
            if (eff2 && eff2.stopped) throw err
            return attempt(n + 1)
          })
        })
      }
      return attempt(1)
    }

    function synth(text, cfg, session) {
      const payload = { model: MODEL, input: text, voice: cfg.voiceId }
      if (typeof cfg.speed === 'number' && cfg.speed >= 0.25 && cfg.speed <= 4) payload.speed = cfg.speed
      if (cfg.sampleRate) payload.sample_rate = cfg.sampleRate
      if (typeof cfg.gain === 'number' && cfg.gain > 0 && cfg.gain <= 10) payload.gain = cfg.gain
      return xhrJsonSynth(payload, cfg.apiKey, session).then(function (x) { return x.response })
    }

    function listVoices(apiKey) {
      return xhrJson('GET', '/audio/voice/list', apiKey, null, '', 30000).then(function (x) {
        const j = JSON.parse(x.responseText)
        return (j && Array.isArray(j.list)) ? j.list : []
      })
    }

    function uploadVoice(apiKey, file, name) {
      const fd = new FormData()
      fd.append('speaker_file', file, file.name || 'voice.mp3')
      fd.append('name', name || 'voice')
      fd.append('model', MODEL)
      return new Promise(function (resolve, reject) {
        let settled = false
        const fail = function (err) { if (settled) return; settled = true; reject(err) }
        const succeed = function (x) { if (settled) return; settled = true; resolve(x) }
        const x = new XMLHttpRequest()
        x.open('POST', API_BASE + '/audio/voice/upload')
        x.setRequestHeader('Authorization', 'Bearer ' + apiKey)
        x.timeout = 60000
        x.onloadend = function () {
          // 按 2xx 判断成功（网关可能返回 201/204；仅认 200 会误判失败造成重复上传，review #9）
          if (x.status >= 200 && x.status < 300) {
            try { const j = JSON.parse(x.responseText); if (j && j.id) { succeed(j); return } } catch (e) {}
            fail(new Error('上传成功但未返回 voice_id'))
            return
          }
          if (x.status === 0) return // 网络错误/超时已由 onerror/ontimeout 处理
          let msg = 'HTTP ' + x.status
          try { const j = JSON.parse(x.responseText || ''); if (j && j.error && j.error.message) msg = j.error.message } catch (e) {}
          fail(new Error(msg))
        }
        x.onerror = function () { fail(new Error('网络错误')) }
        x.ontimeout = function () { fail(new Error('上传超时')) }
        x.send(fd)
      })
    }

    function deleteVoice(apiKey, voiceId) {
      return xhrJson('POST', '/audio/voice/delete', apiKey, JSON.stringify({ id: voiceId }), '', 30000).then(function () { return true })
    }

    // 上传前本地校验音频时长（5-30 秒，README 承诺；拿不到元数据时放行交由平台校验，review #13）。
    // 采样率在浏览器端无标准读取接口，仍由平台校验。
    function validateAudioFile(file) {
      return new Promise(function (resolve, reject) {
        let done = false
        let url
        const finish = function (err) {
          if (done) return
          done = true
          if (url) URL.revokeObjectURL(url)
          err ? reject(err) : resolve()
        }
        try { url = URL.createObjectURL(file) } catch (e) { resolve(); return } // 无法创建 URL 则放行
        const el = new Audio()
        el.preload = 'metadata'
        el.onloadedmetadata = function () {
          const dur = el.duration
          if (isFinite(dur) && dur > 0 && (dur < 5 || dur > 30)) {
            finish(new Error('音频时长需在 5-30 秒之间（当前 ' + dur.toFixed(1) + ' 秒）'))
          } else {
            finish()
          }
        }
        el.onerror = function () { finish() } // 无法解析则放行，交给平台校验
        el.src = url
        el.load()
        // 兜底：部分格式可能不触发 metadata/error，10s 后放行
        ctx.timeout(finish, 10000)
      })
    }

    // ---------- 音色源文件浏览器存档（IndexedDB，跨会话持久，仅用户手动清理站点数据才失效） ----------
    // 上传音色时把源文件/名称存入 IndexedDB；平台音色 7 天过期后，若当前音色不在平台列表
    // （或合成报 invalid_voice_id），自动用存档重新上传并更新所选音色 id（前提是所选音色有
    // 对应源文件）。请求持久化存储，降低浏览器自动回收概率。
    const ARCHIVE_DB = 'itts-voice-archive'
    const ARCHIVE_STORE = 'voices'

    if (navigator && navigator.storage && typeof navigator.storage.persist === 'function') {
      try { navigator.storage.persist().catch(function () {}) } catch (e) {}
    }

    // 复用单连接：打开一次后所有操作共用；打开失败 / 被 versionchange 关闭后自动重置以便下次重开。
    let archiveDbPromise = null

    function openArchiveDB() {
      if (archiveDbPromise) return archiveDbPromise
      archiveDbPromise = new Promise(function (resolve, reject) {
        let req
        try { req = indexedDB.open(ARCHIVE_DB, 1) } catch (e) { reject(e); return }
        req.onupgradeneeded = function () {
          const db = req.result
          if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
            db.createObjectStore(ARCHIVE_STORE, { keyPath: 'voiceId' })
          }
        }
        req.onsuccess = function () {
          const db = req.result
          // 其它标签页升级数据库版本时会触发 versionchange：主动关闭并重置，下次操作重开
          db.onversionchange = function () {
            db.close()
            archiveDbPromise = null
          }
          resolve(db)
        }
        req.onerror = function () { reject(req.error) }
        req.onblocked = function () {
          // 其它标签页持有旧版本连接导致升级被阻塞：明确报错而不是永久 pending（review #10）
          reject(new Error('音色存档数据库被其它标签页占用，请关闭其它 DeepSeek Harness 标签页后重试'))
        }
      })
      // 打开失败后允许下次操作重试（如临时被 blocked，用户关闭其它标签页后即可恢复）
      archiveDbPromise.catch(function () { archiveDbPromise = null })
      return archiveDbPromise
    }

    // 统一事务包装：事务 abort（配额错误等）与 error 都确保 settle，避免永久 pending（review #10）
    function archiveTx(mode, run) {
      return openArchiveDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          let tx
          try { tx = db.transaction(ARCHIVE_STORE, mode) } catch (e) { reject(e); return }
          run(tx, resolve, reject)
          tx.oncomplete = function () { resolve() }
          tx.onerror = function () { reject(tx.error || new Error('数据库操作失败')) }
          tx.onabort = function () { reject(tx.error || new Error('数据库事务中止（可能存储配额不足）')) }
        })
      })
    }

    function archivePut(record) {
      return archiveTx('readwrite', function (tx) {
        tx.objectStore(ARCHIVE_STORE).put(record)
      })
    }

    function archiveGet(voiceId) {
      return archiveTx('readonly', function (tx, resolve, reject) {
        const req = tx.objectStore(ARCHIVE_STORE).get(voiceId)
        req.onsuccess = function () { resolve(req.result || null) }
        req.onerror = function () { reject(req.error) }
      })
    }

    function archiveDelete(voiceId) {
      return archiveTx('readwrite', function (tx) {
        tx.objectStore(ARCHIVE_STORE).delete(voiceId)
      })
    }

    // 列出所有已存档（可自动续期）的 voiceId
    function archiveListKeys() {
      return archiveTx('readonly', function (tx, resolve, reject) {
        const req = tx.objectStore(ARCHIVE_STORE).getAllKeys()
        req.onsuccess = function () { resolve(req.result || []) }
        req.onerror = function () { reject(req.error) }
      })
    }

    // 从浏览器存档重新上传过期音色：{ok:true,id,name} 成功；{ok:false,reason:'no-archive'|'upload-failed'|'db-error'}
    function reuploadFromArchive(oldVoiceId, apiKey) {
      return archiveGet(oldVoiceId).then(function (rec) {
        if (!rec || !rec.blob) return { ok: false, reason: 'no-archive' }
        const file = (typeof File !== 'undefined' && rec.blob instanceof File)
          ? rec.blob
          : new File([rec.blob], rec.fileName || 'voice.mp3', { type: rec.blob.type || 'audio/mpeg' })
        const name = rec.name || 'voice'
        return uploadVoice(apiKey, file, name).then(function (res) {
          // 存档写入/删除失败不致命：本次续期仍算成功，仅影响下次能否自动续期。
          // 若 archiveDelete 失败导致新旧 id 并存，由调用方的「近期已续期」冷却兜底，避免重复上传（review #4）。
          return archivePut({
            voiceId: res.id,
            name: name,
            fileName: rec.fileName || 'voice.mp3',
            blob: rec.blob,
            uploadedAt: Date.now(),
          }).then(function () {
            return archiveDelete(oldVoiceId).catch(function () {})
          }).catch(function () {})
            .then(function () { return { ok: true, id: res.id, name: name } })
        }).catch(function () { return { ok: false, reason: 'upload-failed' } })
      }).catch(function () { return { ok: false, reason: 'db-error' } })
    }

    // ---------- 音频缓存（浏览器内存，key=请求参数全文；按总字节设上限防内存占用过高） ----------
    // 命中则直接播放，不重复调 API。key 用参数字符串本身（含 apiKey 指纹），
    // 避免 32 位哈希碰撞与换账号后 voiceId 撞车播到旧账号音频。命中时刷新为最新（LRU）。
    // 淘汰时跳过当前正在播放/预载的 URL（inUseUrls），避免 revoke 播放中的音频导致中断。
    // 注意：WAV 大小=采样率×2字节/秒，600 字段在 44100Hz 下约 10MB，故除段数上限外再设总字节上限。
    const audioCache = new Map() // key -> { url, bytes }
    const inflightCache = new Map() // key -> Promise<url>：同 key 在途合成去重（review #2）
    let cacheBytes = 0
    const CACHE_MAX = 60
    const CACHE_BYTES_MAX = 60 * 1024 * 1024 // 60MB
    const inUseUrls = new Set()

    function requestKey(text, cfg) {
      return JSON.stringify({
        ak: cfg.apiKey,
        model: MODEL,
        input: text,
        voice: cfg.voiceId,
        speed: (typeof cfg.speed === 'number' && cfg.speed >= 0.25 && cfg.speed <= 4) ? cfg.speed : undefined,
        sample_rate: cfg.sampleRate,
        gain: (typeof cfg.gain === 'number' && cfg.gain > 0 && cfg.gain <= 10) ? cfg.gain : undefined,
      })
    }

    // 返回缓存中的 blob URL；未命中则合成后存入缓存（URL 由缓存持有，播放方不主动 revoke）。
    // 会话停止后未播出的在途合成仍会完成并写入缓存，不浪费；session 用于合成重试优先级。
    function getAudioCached(text, cfg, session) {
      const key = requestKey(text, cfg)
      const hit = audioCache.get(key)
      if (hit !== undefined) {
        audioCache.delete(key)
        audioCache.set(key, hit) // LRU：命中刷新为最新，避免被当作最旧立即淘汰
        return Promise.resolve(hit.url)
      }
      // 在途去重：同 key 已有请求在跑则直接复用（停止后立刻重播同一段文本不会再发第二个 POST，
      // 也不会出现「后写覆盖先写 → 旧 blob URL 泄漏 + cacheBytes 重复记账」，review #2）
      const inflight = inflightCache.get(key)
      if (inflight !== undefined) return inflight
      const task = synth(text, cfg, session).then(function (buf) {
        const blob = new Blob([buf], { type: 'audio/wav' })
        const url = URL.createObjectURL(blob)
        const entry = { url: url, bytes: buf.byteLength }
        // 防御：写入前若已被其它分支写入（正常不应发生），放弃新 URL，只记一次账
        if (audioCache.has(key)) {
          URL.revokeObjectURL(url)
          return audioCache.get(key).url
        }
        audioCache.set(key, entry)
        cacheBytes += entry.bytes
        // 段数或总字节超限时淘汰最旧（跳过正在播放/预载的 URL）
        let attempts = 0
        while ((audioCache.size > CACHE_MAX || cacheBytes > CACHE_BYTES_MAX) && attempts < CACHE_MAX * 2) {
          attempts += 1
          const oldestKey = audioCache.keys().next().value
          const old = audioCache.get(oldestKey)
          audioCache.delete(oldestKey)
          if (old && inUseUrls.has(old.url)) {
            audioCache.set(oldestKey, old) // 正在播放/预载：挪到最新，跳过
            continue
          }
          if (old) {
            cacheBytes -= old.bytes
            URL.revokeObjectURL(old.url)
          }
        }
        console.log('[itts] 音频缓存', audioCache.size, '段', (cacheBytes / 1048576).toFixed(1), 'MB，新增', (entry.bytes / 1048576).toFixed(2), 'MB')
        return url
      }).finally(function () {
        inflightCache.delete(key)
      })
      inflightCache.set(key, task)
      return task
    }

    // ---------- 播放总线：同一时间只播放一条 ----------
    let currentSession = null
    function stopSession(session) {
      session.stopped = true
      session.isCurrent = false
      session.generation += 1 // 作废该会话的所有流水线（含 pump 调度），review #3
      if (session.resolveStop) session.resolveStop()
      // 释放本会话标记为“正在播放/预载”的 URL，使缓存淘汰可回收它们
      if (session.urls) {
        for (const u of session.urls) inUseUrls.delete(u)
        session.urls.clear()
      }
      const els = [session.audioEl, session.auxEl]
      for (let i = 0; i < els.length; i++) {
        const el = els[i]
        if (el) { el.pause(); el.removeAttribute('src'); el.load() }
      }
    }
    function requestStopAll() { if (currentSession) { const s = currentSession; currentSession = null; stopSession(s) } }

    // ---------- 设置页 ----------
    function SettingsView(props) {
      const [apiKey, setApiKey] = React.useState('')
      const [speed, setSpeed] = React.useState(1)
      const [sampleRate, setSampleRate] = React.useState(44100)
      const [gain, setGain] = React.useState('')
      const [voiceId, setVoiceId] = React.useState('')
      const [voiceName, setVoiceName] = React.useState('')
      const [voices, setVoices] = React.useState([])
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const fileRef = React.useRef(null)
      const nameRef = React.useRef(null)
      const voiceIdRef = React.useRef('')
      const [archivedIds, setArchivedIds] = React.useState([])

      // 缓存占用「实时」刷新（review #11）：每 1s 触发一次重渲染读取 audioCache 当前占用
      const [, cacheTick] = React.useState(0)
      React.useEffect(function () {
        return ctx.interval(function () { cacheTick(function (n) { return n + 1 }) }, 1000)
      }, [])

      // 刷新「哪些音色在浏览器有源文件存档（可过期自动续期）」标记
      const refreshArchiveMarks = React.useCallback(function () {
        archiveListKeys().then(function (keys) { setArchivedIds(keys || []) }).catch(function () {})
      }, [])

      // 「近期已续期」的 voiceId → 时间戳：平台列表同步有延迟时，防止同一音色被反复判定
      // 「不在列表」而重复上传、叠加孤儿音色（review #4）。30s 冷却。
      const recentlyRenewed = React.useRef(new Map())
      const RENEW_COOLDOWN_MS = 30000
      const markRenewed = function (id) {
        if (!id) return
        const now = Date.now()
        const m = recentlyRenewed.current
        // 顺带清理过期条目，防止 Map 无限增长
        for (const k of Array.from(m.keys())) { if (now - (m.get(k) || 0) > RENEW_COOLDOWN_MS) m.delete(k) }
        m.set(id, now)
      }

      const refreshVoices = React.useCallback(function (key) {
        const k = String(key == null ? '' : key).trim()
        if (!k) { setVoices([]); setErr('请先填写 API Key 再刷新音色列表'); return }
        setBusy(true)
        listVoices(k).then(function (list) {
          setVoices(list); setErr('')
          refreshArchiveMarks()
          // 自动续期：当前选中音色不在平台列表时，尝试用浏览器存档重新上传并更新选中音色
          const cur = voiceIdRef.current
          if (cur && !list.some(function (v) { return v.id === cur })) {
            const lastRenew = recentlyRenewed.current.get(cur) || 0
            if (Date.now() - lastRenew < RENEW_COOLDOWN_MS) {
              // 刚续期过、平台列表尚未同步出新 id：跳过本次上传，避免叠加孤儿音色（review #4）
              setMsg('音色列表暂未包含当前音色，可能正在同步，稍后刷新即可')
              return
            }
            markRenewed(cur) // 先标记再上传，防止并发刷新触发重复上传
            setMsg('当前音色可能已过期，尝试自动重新上传…')
            reuploadFromArchive(cur, k).then(function (res) {
              if (!res || !res.ok) {
                setErr('当前音色已过期且浏览器无对应源文件，请重新上传音色')
                setMsg('')
                return
              }
              voiceIdRef.current = res.id
              setVoiceId(res.id)
              setVoiceName(res.name)
              // 新 id 也标记为「近期已续期」，防止平台列表延迟导致再次触发上传
              markRenewed(res.id)
              // 直接把新音色合并进本地列表，不依赖重新拉取（平台列表可能尚未包含新 id，review #4）
              setVoices(function (prev) {
                if (prev.some(function (v) { return v.id === res.id })) return prev
                return prev.concat([{ id: res.id, name: res.name }])
              })
              return host.call('set-config', { voiceId: res.id, voiceName: res.name }).then(function () {
                setMsg('音色已过期，已用存档自动重新上传: ' + res.id)
              }, function () {
                setErr('自动续期成功但保存配置失败')
                setMsg('')
              })
            }, function () {
              setErr('自动续期失败')
              setMsg('')
            })
          }
        })
          .catch(function (e) { setErr(String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }, [])

      React.useEffect(function () {
        host.call('get-config', null).then(function (cfg) {
          if (!cfg) return
          setApiKey(cfg.apiKey || '')
          setSpeed(cfg.speed == null ? 1 : cfg.speed)
          setSampleRate(cfg.sampleRate == null ? 44100 : cfg.sampleRate)
          setGain(cfg.gain == null ? '' : String(cfg.gain))
          voiceIdRef.current = cfg.voiceId || ''
          setVoiceId(cfg.voiceId || '')
          setVoiceName(cfg.voiceName || '')
          if (cfg.apiKey) refreshVoices(cfg.apiKey)
        }).catch(function () { setErr('读取配置失败') })
      }, [refreshVoices])

      const commit = React.useCallback(function (patch) {
        return host.call('set-config', patch).then(function () {
          setMsg('设置已保存 ' + new Date().toLocaleTimeString())
          setErr('')
        }, function (e) {
          setErr('保存失败: ' + String((e && e.message) || e))
        })
      }, [])

      const onUpload = function () {
        const input = fileRef.current
        const file = input && input.files && input.files[0]
        if (!file) { setErr('请先选择音频文件'); return }
        if (file.size > 20 * 1024 * 1024) { setErr('音频不能超过 20MB'); return }
        const nm = nameRef.current && nameRef.current.value ? nameRef.current.value : (file.name ? file.name.replace(/\.[^.]+$/, '') : 'voice')
        setBusy(true)
        // 本地校验时长（5-30 秒；取不到元数据时放行，review #13）
        validateAudioFile(file).then(function () {
          return uploadVoice(apiKey.trim(), file, nm)
        }).then(function (res) {
          voiceIdRef.current = res.id
          setVoiceId(res.id)
          setVoiceName(nm)
          // 源文件存入浏览器（IndexedDB），音色过期后可自动续期。
          // 上传成功的 commit 一并带上 apiKey，避免新用户「填 key → 上传 → 回对话点播放」时
          // 播放读 host 配置仍报「未配置 API Key」（review #5）。
          const patch = { voiceId: res.id, voiceName: nm, apiKey: apiKey.trim() }
          return archivePut({
            voiceId: res.id,
            name: nm,
            fileName: file.name || 'voice.mp3',
            blob: file,
            uploadedAt: Date.now(),
          }).then(function () { return { archived: true } }, function () { return { archived: false } })
            .then(function (r) {
              return commit(patch).then(function () {
                setMsg(r.archived
                  ? '音色上传成功: ' + res.id + '（源文件已存入浏览器，过期自动续期）'
                  : '音色上传成功: ' + res.id + '（但源文件未能存入浏览器，音色过期后需手动重新上传）')
                return refreshVoices(apiKey.trim())
              })
            })
        }).catch(function (e) {
          setErr('上传失败: ' + String((e && e.message) || e))
        }).then(function () { setBusy(false) })
      }

      const onDelete = function () {
        if (!voiceId) { setErr('请先选择要删除的音色'); return }
        setBusy(true)
        deleteVoice(apiKey.trim(), voiceId).then(function () {
          voiceIdRef.current = ''
          setVoiceId('')
          setVoiceName('')
          setMsg('已删除: ' + voiceId)
          // 平台删除后同步清理浏览器存档
          return archiveDelete(voiceId).catch(function () {}).then(function () {
            return commit({ voiceId: '', voiceName: '', apiKey: apiKey.trim() }).then(function () { return refreshVoices(apiKey.trim()) })
          })
        }).catch(function (e) {
          setErr('删除失败: ' + String((e && e.message) || e))
        }).then(function () { setBusy(false) })
      }

      const onSave = function () {
        const sp = Number(speed)
        const sr = Number(sampleRate)
        const g = gain === '' ? null : Number(gain)
        if (!(sp >= 0.25 && sp <= 4)) { setErr('语速需在 0.25-4.0 之间'); return }
        if (sr !== 22050 && sr !== 44100 && sr !== 48000) { setErr('采样率需为 22050/44100/48000'); return }
        if (g !== null && (!isFinite(g) || g <= 0 || g > 10)) { setErr('音量增益需在 (0,10] 之间，或留空用默认'); return }
        setBusy(true)
        commit({
          apiKey: apiKey.trim(),
          voiceId: voiceId,
          voiceName: voiceName,
          speed: sp,
          sampleRate: sr,
          gain: g,
        }).then(function () { setBusy(false) })
      }

      const onTest = function () {
        setBusy(true); setMsg(''); setErr('')
        commit({ apiKey: apiKey.trim() }).then(function () {
          return host.call('get-config', null)
        }).then(function (cfg) {
          if (!cfg || !cfg.apiKey) throw new Error('请先填写并保存 API Key')
          if (!cfg.voiceId) throw new Error('请先上传或选择音色')
          // 试听不走缓存：每次真实调用 API，用于验证当前配置与网络/Key 是否可用
          return synth('你好，这是 IndexTTS 语音朗读插件的测试音频。', cfg)
        }).then(function (buf) {
          const blob = new Blob([buf], { type: 'audio/wav' })
          const url = URL.createObjectURL(blob)
          const el = new Audio(url)
          el.onended = function () { URL.revokeObjectURL(url) }
          el.onerror = function () { URL.revokeObjectURL(url) }
          const p = el.play()
          if (p && typeof p.catch === 'function') p.catch(function () { URL.revokeObjectURL(url) })
          setMsg('正在播放测试音频…')
        }).catch(function (e) {
          setErr(String((e && e.message) || e))
        }).then(function () { setBusy(false) })
      }

      return React.createElement('div', { className: 'itts-settings' },
        React.createElement('div', { className: 'itts-field' },
          React.createElement('label', { htmlFor: 'itts-apikey' }, 'API Key（优云智算控制台获取）'),
          React.createElement('input', { id: 'itts-apikey', type: 'password', value: apiKey, className: 'itts-input', placeholder: '输入 API Key', onChange: function (e) { setApiKey(e.target.value) } })
        ),
        React.createElement('div', { className: 'itts-field' },
          React.createElement('span', null, '上传音色（MP3/WAV，5-30 秒，≤20MB，≥16kHz）'),
          React.createElement('div', { className: 'itts-row' },
            React.createElement('input', { ref: fileRef, type: 'file', accept: '.mp3,.wav,audio/mpeg,audio/wav' }),
            React.createElement('input', { ref: nameRef, className: 'itts-input itts-inline', placeholder: '音色名称（可选）' }),
            React.createElement('button', { type: 'button', className: 'itts-btn-action', onClick: onUpload, disabled: busy }, '上传并设为当前音色')
          )
        ),
        React.createElement('div', { className: 'itts-field' },
          React.createElement('span', null, '当前音色'),
          React.createElement('div', { className: 'itts-row' },
            React.createElement('select', { className: 'itts-input itts-inline', value: voiceId, onChange: function (e) {
              const v = e.target.value
              voiceIdRef.current = v
              setVoiceId(v)
              setVoiceName('')
              // 选择音色立即生效并持久化到 host，播放按钮/试听都读 host 配置；
              // 一并提交 apiKey，避免新用户「填 key → 刷新 → 选音色 → 回对话点播放」读不到 key（review #5）
              commit({ voiceId: v, voiceName: '', apiKey: apiKey.trim() })
            } },
              React.createElement('option', { value: '' }, '(选择音色)'),
              voices.map(function (v) {
                const marker = archivedIds.indexOf(v.id) >= 0 ? ' · 可续期' : ''
                return React.createElement('option', { key: v.id, value: v.id }, (v.name || v.id) + ' · ' + v.id + marker)
              })
            ),
            React.createElement('button', { type: 'button', className: 'itts-btn-action', onClick: function () { refreshVoices(apiKey.trim()) }, disabled: busy }, '刷新'),
            React.createElement('button', { type: 'button', className: 'itts-btn-danger', onClick: onDelete, disabled: busy || !voiceId }, '删除')
          ),
          React.createElement('div', { className: 'itts-hint' }, voiceId ? ('voice_id: ' + voiceId) : '未选择音色')
        ),
        React.createElement('label', { className: 'itts-field' },
          React.createElement('span', null, '语速：' + Number(speed).toFixed(2)),
          React.createElement('input', { type: 'range', min: '0.25', max: '4', step: '0.05', value: speed, onChange: function (e) { setSpeed(Number(e.target.value)) } })
        ),
        React.createElement('label', { className: 'itts-field' },
          React.createElement('span', null, '采样率'),
          React.createElement('select', { className: 'itts-input', value: String(sampleRate), onChange: function (e) { setSampleRate(Number(e.target.value)) } },
            React.createElement('option', { value: '22050' }, '22050 Hz'),
            React.createElement('option', { value: '44100' }, '44100 Hz'),
            React.createElement('option', { value: '48000' }, '48000 Hz')
          )
        ),
        React.createElement('label', { className: 'itts-field' },
          React.createElement('span', null, '音量增益（0.1-10，留空为默认）'),
          React.createElement('input', { type: 'number', className: 'itts-input', min: '0.1', max: '10', step: '0.1', value: gain, placeholder: '默认', onChange: function (e) { setGain(e.target.value) } })
        ),
        React.createElement('div', { className: 'itts-row' },
          React.createElement('button', { type: 'button', className: 'itts-btn-action', onClick: onSave, disabled: busy }, '保存设置'),
          React.createElement('button', { type: 'button', className: 'itts-btn-action', onClick: onTest, disabled: busy }, '播放测试')
        ),
        React.createElement('div', { className: 'itts-hint' }, '音频缓存（浏览器内存，刷新页面清空；上限 60MB 自动淘汰）：' + audioCache.size + ' 段 / ' + (cacheBytes / 1048576).toFixed(1) + ' MB'),
        React.createElement('div', { className: 'itts-hint' }, '提示：点击对话中每条 agent 回复末尾的喇叭按钮即可朗读该条回复正文（>600 字自动按段落/句子分段，颜文字/emoji/思考过程不会被朗读）。'),
        msg ? React.createElement('div', { className: 'itts-ok' }, msg) : null,
        err ? React.createElement('div', { className: 'itts-err' }, err) : null
      )
    }

    // ---------- 播放按钮 ----------
    function PlayButton(props) {
      const messageId = props.messageId
      const useChat = props.useChat
      const text = useChat(function (snapshot) {
        let found = ''
        try {
          if (snapshot && snapshot.legacy && Array.isArray(snapshot.legacy.nodes)) {
            for (let i = 0; i < snapshot.legacy.nodes.length; i++) {
              const n = snapshot.legacy.nodes[i]
              if (n && n.kind === 'assistant' && n.messageId === messageId && Array.isArray(n.blocks)) {
                found = n.blocks.filter(function (b) { return b && b.kind === 'text' && typeof b.text === 'string' }).map(function (b) { return b.text }).join('')
                return found
              }
            }
          }
          if (snapshot && snapshot.nodes && typeof snapshot.nodes.values === 'function') {
            // Array.from 兼容迭代器返回值（review #16）：迭代器没有 .length / 下标索引
            const nodes = Array.from(snapshot.nodes.values())
            for (let i = 0; i < nodes.length; i++) {
              const node = nodes[i]
              const fn = node && node.data && node.data.finalNode
              if (node && node.kind === 'assistant' && fn && fn.messageId === messageId && Array.isArray(fn.blocks)) {
                found = fn.blocks.filter(function (b) { return b && b.kind === 'text' && typeof b.text === 'string' }).map(function (b) { return b.text }).join('')
                return found
              }
            }
          }
        } catch (e) {}
        return found
      })

      const [status, setStatus] = React.useState({ phase: 'idle', info: '' })
      const audioARef = React.useRef(null)
      const audioBRef = React.useRef(null)

      const playSegments = function (segments, cfg, session) {
        const total = segments.length
        const main = audioARef.current
        const aux = audioBRef.current
        // 本次流水线的代际：音色续期重试会 session.generation+1 作废旧流水线，
        // 避免新旧两条 pump 并存（并发翻倍 / 状态互相覆盖 / 旧 voiceId 继续消耗额度），review #3
        const myGen = session.generation
        const results = new Array(total)
        let next = 0
        let inflight = 0
        const LIMIT = 2

        // 状态只在仍为当前代际时更新，避免旧流水线覆盖新流水线的状态
        const setSt = function (s) { if (session.generation === myGen) setStatus(s) }

        // 有界并发（上限2）按段序启动合成；每段结果写入 results[i]（保序 Promise）。
        // 会话停止 / 被续期取代后：未开始的段不再启动；已在途的段完成后仍写入缓存，不浪费。
        // 预挂 then/catch 处理，避免会话停止后无人消费的 rejection 触发 unhandledrejection。
        const pump = function () {
          while (next < total && inflight < LIMIT && !session.stopped && session.generation === myGen) {
            const i = next
            next += 1
            inflight += 1
            const task = getAudioCached(segments[i], cfg, session)
            task.then(function () {}, function () {})
            results[i] = task
            task.finally(function () {
              inflight -= 1
              pump()
            }).catch(function () {})
          }
        }
        pump()

        const wait = function (p) {
          return Promise.race([p, session.stopSignal]).catch(function (err) {
            if (session.stopped) return undefined
            throw err
          })
        }

        // 播放一段：target 为预载好该 URL 的元素（或回退到 main）；resolve 实际播放的元素。
        // 记录 session.playingEl，供预载写入前避开正在播放的元素（回退场景）。
        const playOne = function (url, target) {
          return new Promise(function (resolve, reject) {
            let settled = false
            const done = function (err, el) { if (settled) return; settled = true; session.playingEl = null; err ? reject(err) : resolve(el) }
            const playOn = function (el) {
              el.onended = function () { done(null, el) }
              el.onerror = function () { done(new Error('音频播放失败'), el) }
              if (el.src !== url) el.src = url
              session.playingEl = el
              const p = el.play()
              if (p && typeof p.catch === 'function') p.catch(function (e) {
                if (el !== main) playOn(main) // 预载元素被自动播放策略拦截：回退主元素
                else done(new Error('播放被阻止：' + String((e && e.message) || e)), el)
              })
            }
            playOn(target)
          })
        }

        return (async function () {
          let curEl = main
          let otherEl = aux
          for (let i = 0; i < total; i++) {
            if (session.stopped || session.generation !== myGen) return 'superseded'
            setSt({ phase: 'loading', info: total > 1 ? '合成 ' + (i + 1) + '/' + total + ' …' : '合成中…' })
            const url = await wait(results[i])
            if (session.stopped || session.generation !== myGen || url === undefined) return 'superseded'
            setSt({ phase: 'playing', info: total > 1 ? '播放 ' + (i + 1) + '/' + total : '播放中' })
            // 第 i 段一开始播放，就预载第 i+1 段到另一个元素（并行解码，结束切换近零延迟）。
            // 预载写入前避开当前正在播放的元素；预载完成即计入 session.urls，防 LRU 在开播前 revoke。
            const preTarget = otherEl
            if (i + 1 < total) {
              results[i + 1].then(function (nextUrl) {
                if (!session.stopped && session.generation === myGen && nextUrl && session.playingEl !== preTarget && preTarget.src !== nextUrl) {
                  preTarget.src = nextUrl
                  preTarget.load()
                  session.urls.add(nextUrl)
                }
              }).catch(function () {})
            }
            session.urls.add(url)
            const playedEl = await wait(playOne(url, curEl))
            session.urls.delete(url)
            if (session.stopped || session.generation !== myGen) return 'superseded'
            // 下一段：正常播完则与预载元素交换（main/aux 交替使用，真正消费预载）；
            // 自动播放策略回退到 main 则停留 main，aux 重新作为预载目标。
            if (playedEl === curEl) {
              const tmp = curEl
              curEl = otherEl
              otherEl = tmp
            } else {
              curEl = main
              otherEl = aux
            }
          }
          return 'done'
        })()
      }

      const startPlay = function () {
        requestStopAll()
        const session = {
          stopped: false,
          isCurrent: true,
          generation: 0,
          urls: new Set(),
          playingEl: null,
          audioEl: audioARef.current,
          auxEl: audioBRef.current,
          resolveStop: null,
        }
        session.stopSignal = new Promise(function (resolve) { session.resolveStop = resolve })
        currentSession = session
        const markDone = function () { if (currentSession === session) { session.isCurrent = false; currentSession = null } }

        host.call('get-config', null).then(function (cfg) {
          if (session.stopped) { markDone(); return }
          if (!cfg || !cfg.apiKey) { setStatus({ phase: 'error', info: '未配置 API Key（设置→语音朗读）' }); markDone(); return }
          if (!cfg.voiceId) { setStatus({ phase: 'error', info: '未选择音色（设置→语音朗读）' }); markDone(); return }
          const cleaned = filterText(text)
          if (!cleaned) { setStatus({ phase: 'error', info: '无正文可朗读' }); markDone(); return }
          const segments = splitForTts(cleaned, MAX_CHARS)
          if (!segments.length) { setStatus({ phase: 'error', info: '无正文可朗读' }); markDone(); return }
          // 播放失败若因音色过期（invalid_voice_id 等），用浏览器存档自动重新上传一次并重试
          let recovered = false
          let gen = 0 // 当前流水线代际（与 session.generation 同步）
          const runPlay = function (cfg2) {
            return playSegments(segments, cfg2, session).catch(function (e) {
              if (session.stopped || session.generation !== gen || recovered) throw e
              // 仅当 HTTP 状态为明确的 400/404 且文案命中「音色无效/不存在」时才触发自动续期（review #8），
              // 避免把 5xx / 网络 / 限流 / 其它 4xx 误判为音色过期而重新上传换 id、旧缓存全部失效。
              const msg = String((e && e.message) || e)
              const statusOk = e && (e.status === 400 || e.status === 404)
              if (!statusOk || !/invalid_voice_id|voice[_ ]?id[_ ]?(invalid|not|no|miss|不存在|无效|失效)|音色.*(不存在|无效|失效|未找到)/i.test(msg)) throw e
              recovered = true
              // 立即作废旧流水线：旧 pump 不再调度新段，续期上传期间旧 voiceId 不再消耗 API 额度（review #3）
              gen += 1
              session.generation += 1
              setStatus({ phase: 'loading', info: '音色可能已过期，尝试自动续期…' })
              return reuploadFromArchive(cfg2.voiceId, cfg2.apiKey).then(function (res) {
                if (!res || !res.ok) throw e
                return host.call('set-config', { voiceId: res.id, voiceName: res.name }).then(function () {
                  if (session.stopped) throw e // 续期期间用户已停止：不再重试
                  // 防御（第六轮复审 B）：续期重试前暂停旧 audio 元素，避免任何极端时序下
                  // 新流水线从第 0 段开播时截断仍在播放的上一段
                  if (session.audioEl) session.audioEl.pause()
                  if (session.auxEl) session.auxEl.pause()
                  const cfg3 = Object.assign({}, cfg2, { voiceId: res.id })
                  return runPlay(cfg3) // 用新音色重试整段播放
                })
              }).catch(function () { throw e })
            })
          }
          return runPlay(cfg).then(function (reason) {
            if (session.stopped) { setStatus({ phase: 'idle', info: '已停止' }) }
            else { setStatus({ phase: 'idle', info: '播放完成' }) }
            markDone()
          })
        }).catch(function (e) {
          const wasStopped = session.stopped // 先记录，stopSession 会把它置 true
          stopSession(session)
          // 用户在续期/播放期间点停止：只显示「已停止」，不闪现无意义的 API 错误文案（第六轮复审 C）
          if (wasStopped) setStatus({ phase: 'idle', info: '已停止' })
          else setStatus({ phase: 'error', info: String((e && e.message) || e) })
          markDone()
        })
      }

      const onToggle = function () {
        if (status.phase === 'playing' || status.phase === 'loading') {
          if (currentSession) { const s = currentSession; currentSession = null; stopSession(s) }
          setStatus({ phase: 'idle', info: '' })
        } else {
          startPlay()
        }
      }

      if (typeof useChat !== 'function' || !messageId) return null

      const active = status.phase === 'playing' || status.phase === 'loading'
      // 播放/合成中即使 text 瞬时为空（流式消息 / 快照重建期间）也不卸载按钮与两个 <audio>
      // 元素——播放依赖这两个元素，卸载会导致当前播放中断、currentSession 变孤儿（review #6）。
      // 非活动时才允许因空文本隐藏。
      if (!text && !active) return null
      const title = active ? '停止朗读' : '朗读该回复'
      return React.createElement('span', { className: 'itts-action' },
        React.createElement('button', {
          type: 'button', className: 'itts-btn', onClick: onToggle,
          title: title, 'aria-label': title, 'data-active': active || undefined,
        },
          React.createElement('svg', { width: '16', height: '16', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
            React.createElement('path', { d: 'M7 2.5 L4.2 5.2 H2 V10.8 H4.2 L7 13.5 Z', fill: 'currentColor' }),
            active
              ? React.createElement('rect', { x: '9.5', y: '5.2', width: '5', height: '5.6', rx: '1', fill: 'currentColor' })
              : React.createElement('path', { d: 'M10.2 5.2 a3.2 3.2 0 0 1 0 5.6 M12 3.6 a5.4 5.4 0 0 1 0 8.8', fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' })
          )
        ),
        React.createElement('audio', { ref: audioARef, style: { display: 'none' } }),
        React.createElement('audio', { ref: audioBRef, style: { display: 'none' } }),
        status.info ? React.createElement('span', { className: 'itts-status', 'data-error': status.phase === 'error' || undefined }, status.info) : null
      )
    }

    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', function () {
      return slots.register({ name: 'settings.section', id: 'index-tts', order: 30, label: '语音朗读' }, SettingsView)
    })
    slots.inject('conversation.chat.assistant-actions', function () {
      return slots.register({ name: 'conversation.chat.assistant-actions', id: 'index-tts-play', order: 20, label: '朗读' }, PlayButton)
    })
  },
}
