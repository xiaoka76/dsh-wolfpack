/**
 * Web 搜索插件（火山引擎 + Tavily）—— Host 半部（code.host）
 *
 * 作用：
 *   1. 注册模型工具 `web_search_multi`：agent 可直接调用，自动选择后端——
 *      配置了火山引擎 API Key 时用火山引擎；否则配置了 Tavily API Key 用
 *      Tavily（keyed）；两者都未配置时自动使用 Tavily keyless 免费模式
 *      （无需任何 Key）。
 *   2. 注册 `ctx.web` 搜索 Provider：优先抢占 id=`deepseek-official`
 *      （与内置 @deepseek-ai/dsh-web-search-deepseek 相同的 id），宿主把内置
 *      插件移除后，内置 `web_search` 工具无需任何配置即路由到本插件；同时
 *      注册 `web-search`（本插件自带 id，可用 DSH_WEB_SEARCH_PROVIDER=web-search
 *      显式选用）与 `volcengine`（旧版兼容）两个别名 id。
 *   3. RPC（get-config / set-config / test-search）：设置页读写两个 API Key
 *      与默认参数、测试搜索。
 *
 * 依赖 DSH 自身运行（核心决策，不依赖系统 curl）：
 *   - 动态插件 Host 沙箱**没有 fetch**，`ctx.web.fetch` 只支持 `{url}`；
 *     网络访问的唯一途径是 `ctx.subprocess` 拉起外部进程；
 *   - 本实现通过宿主 `ctx.subprocess` 拉起 **DSH 自身所在的 Node 运行时**
 *     （`resolveExecutable('node')`），用 Node 内置 `https` 模块直接 POST
 *     火山引擎联网搜索 / Tavily Search API。Node 是 DSH 的运行基础必然存在，
 *     自带 OpenSSL，不受本机 curl 的 TLS/schannel 问题影响；
 *   - 请求 JSON body 经 stdin 传入，避免命令行转义；API Key 经 spawn.env
 *     显式条目传给子进程（显式条目在 subprocess 的敏感变量 scrub 之后合并）；
 *   - 子进程 stdout 输出 `HTTP状态码\n响应体`（任何 HTTP 响应都 exit 0，
 *     只有传输层错误才非 0 退出），由插件按状态码与响应体判断业务错误。
 *
 * 参考：仓库 docs/dynamic-plugin-host-sandbox.md §7（网络路径与凭证陷阱）；
 *      qwenpaw-web-search-implementation.md（QwenPaw 的 Provider 抽象与
 *      Tavily keyless 后端实现，本插件 Tavily 部分与之对齐）。
 *
 * 加载方式：作为 cordis_define 的 code.host 参数内容（async 函数体，return 插件对象）。
 */

return {
  inject: ['subprocess'],
  apply(ctx) {
    // ── 内存配置（动态插件不引入持久化，随插件生命周期存续）──
    const state = {
      volcApiKey: '',
      tavilyApiKey: '',
      defaultCount: 10,
      defaultTimeRange: '',
      defaultAuthLevel: 0,
      defaultQueryRewrite: false,
      defaultSearchDepth: 'basic',
      defaultTopic: 'general',
    }
    const clone = function () { return JSON.parse(JSON.stringify(state)) }

    // ── API 常量 ──
    const VOLC_URL = 'https://open.feedcoopapi.com/search_api/web_search'
    const TRAFFIC_TAG = 'skill_web_search_common' // 与 byted-web-search 技能 CLI 的 API Key 路径一致
    const TAVILY_URL = 'https://api.tavily.com/search'
    const TAVILY_KEYLESS_HEADER = { name: 'X-Tavily-Access-Mode', value: 'keyless' }

    // ── 内联 Node 脚本生成器：由 DSH 自身所在的 Node 运行时执行，替代系统 curl ──
    // stdout 输出 `HTTP状态码\n响应体`；任何 HTTP 响应（含 4xx/5xx）都 exit 0，
    // 由插件解析状态码与 JSON 判断业务错误；只有传输层错误（DNS/连接/TLS/超时）才非 0 退出。
    // envKeyName：从子进程 env 读取的 API Key 变量名；keylessHeader：未配置 Key 时附加的
    // 免 Key 头（如 Tavily 的 X-Tavily-Access-Mode: keyless），null 表示无。
    function buildNodeScript(endpoint, headers, envKeyName, keylessHeader) {
      return `
const https = require('https')
const ENDPOINT = ${JSON.stringify(endpoint)}
const HEADERS = ${JSON.stringify(headers)}
const ENV_KEY = ${JSON.stringify(envKeyName)}
const KEYLESS = ${JSON.stringify(keylessHeader)}
let body = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (c) { body += c })
process.stdin.on('end', function () {
  const url = new URL(ENDPOINT)
  const h = {}
  for (const k of Object.keys(HEADERS)) h[k] = HEADERS[k]
  const key = (process.env[ENV_KEY] || '').trim()
  if (key) h['Authorization'] = 'Bearer ' + key
  else if (KEYLESS) h[KEYLESS.name] = KEYLESS.value
  h['Content-Length'] = String(Buffer.byteLength(body))
  const req = https.request({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: h,
    timeout: 25000,
  }, function (res) {
    const chunks = []
    res.on('data', function (c) { chunks.push(c) })
    res.on('end', function () {
      const out = Buffer.concat(chunks).toString('utf8')
      process.stdout.write(String(res.statusCode || 0) + '\\n' + out, function () { process.exit(0) })
    })
    res.on('error', function (e) {
      process.stderr.write('response error: ' + String((e && e.message) || e))
      process.exit(1)
    })
  })
  req.on('timeout', function () { req.destroy(new Error('timeout')) })
  req.on('error', function (e) {
    process.stderr.write(String((e && e.message) || e))
    process.exit(1)
  })
  req.end(body)
})
`
    }

    const VOLC_SCRIPT = buildNodeScript(VOLC_URL, { 'Content-Type': 'application/json', 'X-Traffic-Tag': TRAFFIC_TAG }, 'VOLC_API_KEY', null)
    const TAVILY_SCRIPT = buildNodeScript(TAVILY_URL, { 'Content-Type': 'application/json' }, 'TAVILY_API_KEY', TAVILY_KEYLESS_HEADER)

    // ── Node 可执行文件：DSH 自身运行在 Node 上，用它替代系统 curl（解析结果缓存）──
    let nodeExePromise
    function resolveNode() {
      if (!nodeExePromise) {
        nodeExePromise = ctx.subprocess.resolveExecutable('node').catch(function (e) {
          nodeExePromise = undefined // 允许下次重试
          throw new Error('找不到 Node 运行时（DSH 依赖 Node 运行，应必然存在）：' + String((e && e.message) || e))
        })
      }
      return nodeExePromise
    }

    // ── 统一 POST：spawn DSH 自身 Node 运行时执行内联脚本，返回 { status, body } ──
    async function postNode(script, env, bodyText) {
      const nodeExe = await resolveNode()
      const handle = ctx.subprocess.spawn({
        argv: [nodeExe, '-e', script],
        cwd: '.',
        env: env,
        stdio: {
          stdin: { data: bodyText },
          stdout: { maxBytes: 500000 },
          stderr: { maxBytes: 50000 },
        },
        graceMs: 30000,
      })
      const outcome = await handle.done
      const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      if (outcome.exitCode !== 0) {
        throw new Error('DSH Node 请求失败 (exit ' + String(outcome.exitCode) + '): ' + ((err || out) || '未知错误').trim())
      }
      const nl = out.indexOf('\n')
      const status = parseInt(nl >= 0 ? out.slice(0, nl) : out, 10)
      const body = nl >= 0 ? out.slice(nl + 1) : ''
      if (!Number.isFinite(status)) {
        throw new Error('无法解析 API 响应头: ' + (out || err || '').slice(0, 300))
      }
      return { status: status, body: body }
    }

    // ── 参数工具 ──
    function pick(opts, key, fallback) {
      return opts && opts[key] != null ? opts[key] : fallback
    }
    function clampInt(value, min, max, fallback) {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.max(min, Math.min(max, Math.round(n)))
    }

    // ── 火山引擎请求 body（对照 byted-web-search 技能 CLI build_body）──
    // opts: { count?, type?, timeRange?, authLevel?, queryRewrite? }
    function buildVolcBody(query, opts) {
      const type = opts && opts.type === 'image' ? 'image' : 'web'
      const body = {
        Query: query,
        SearchType: type,
        Count: clampInt(pick(opts, 'count', state.defaultCount), 1, 50, 10),
      }
      if (type === 'web') {
        body.NeedSummary = true
        const al = clampInt(pick(opts, 'authLevel', state.defaultAuthLevel), 0, 1, 0)
        if (al > 0) body.Filter = { AuthInfoLevel: al }
        const tr = String(pick(opts, 'timeRange', state.defaultTimeRange) || '').trim()
        if (tr) body.TimeRange = tr
      }
      const qr = pick(opts, 'queryRewrite', state.defaultQueryRewrite)
      if (qr === true) body.QueryControl = { QueryRewrite: true }
      return body
    }

    // ── Tavily 时间范围归一化：兼容火山引擎的 OneDay/… 与日期区间写法 ──
    function mapTavilyTimeRange(tr) {
      const value = String(tr == null ? '' : tr).trim()
      if (!value) return {}
      const map = { OneDay: 'day', OneWeek: 'week', OneMonth: 'month', OneYear: 'year' }
      if (map[value]) return { range: map[value] }
      const rangeMatch = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value)
      if (rangeMatch) return { start: rangeMatch[1], end: rangeMatch[2] }
      return { range: value } // day/week/month/year/d/w/m/y 直接透传
    }

    // ── Tavily 请求 body（对照 qwenpaw tavily.py：query + max_results + search_depth）──
    // opts: { count?, timeRange?, searchDepth?, topic? }
    function buildTavilyBody(query, opts) {
      const body = {
        query: query,
        max_results: clampInt(pick(opts, 'count', state.defaultCount), 1, 20, 10),
        search_depth: String(pick(opts, 'searchDepth', state.defaultSearchDepth) || 'basic').trim() || 'basic',
      }
      const topic = String(pick(opts, 'topic', state.defaultTopic) || '').trim()
      if (topic && topic !== 'general') body.topic = topic
      const tr = mapTavilyTimeRange(pick(opts, 'timeRange', state.defaultTimeRange))
      if (tr.range) body.time_range = tr.range
      if (tr.start) body.start_date = tr.start
      if (tr.end) body.end_date = tr.end
      return body
    }

    // ── 后端选择：provider 显式指定优先，否则按配置自动路由 ──
    // auto：有火山 Key → volcengine；否则有 Tavily Key → tavily(keyed)；都没有 → tavily(keyless)
    function effectiveBackend() {
      if (String(state.volcApiKey || '').trim()) return { provider: 'volcengine', mode: 'keyed' }
      if (String(state.tavilyApiKey || '').trim()) return { provider: 'tavily', mode: 'keyed' }
      return { provider: 'tavily', mode: 'keyless' }
    }
    function resolveBackend(opts) {
      const forced = opts && opts.provider
      if (forced === 'volcengine' || forced === 'tavily') return forced
      return effectiveBackend().provider
    }

    // ── 火山引擎搜索：返回解析后的 JSON（ResponseMetadata + Result）──
    async function volcSearch(query, apiKey, opts) {
      const bodyText = JSON.stringify(buildVolcBody(query, opts))
      const res = await postNode(VOLC_SCRIPT, { VOLC_API_KEY: apiKey }, bodyText)
      let data
      try {
        data = JSON.parse(res.body)
      } catch (e) {
        throw new Error('无法解析火山引擎 API 响应: ' + (res.body || '').slice(0, 300))
      }
      const metaErr = data && data.ResponseMetadata && data.ResponseMetadata.Error
      if (metaErr) {
        const code = String(metaErr.Code || '')
        const msg = String(metaErr.Message || '')
        if (/invalid_api_key|10403/i.test(code)) {
          throw new Error('火山引擎 API Key 无效或未开通（' + code + ' ' + msg + '）——请在「设置 → Web 搜索」填写正确的 API Key（https://console.volcengine.com/search-infinity/api-key ），或改用 Tavily（无需 Key 的 keyless 模式）')
        }
        throw new Error('火山引擎搜索 API 错误 [' + code + ']: ' + msg)
      }
      if (!data || !data.Result) throw new Error('搜索无返回结果')
      return data
    }

    // ── Tavily 搜索：返回解析后的 JSON（query + results + answer…）──
    // apiKey 为空时自动走 keyless（X-Tavily-Access-Mode: keyless，无需任何配置）
    async function tavilySearch(query, apiKey, opts) {
      const bodyText = JSON.stringify(buildTavilyBody(query, opts))
      const res = await postNode(TAVILY_SCRIPT, { TAVILY_API_KEY: apiKey }, bodyText)
      let data
      try {
        data = JSON.parse(res.body)
      } catch (e) {
        throw new Error('无法解析 Tavily API 响应: ' + (res.body || '').slice(0, 300))
      }
      if (res.status < 200 || res.status >= 300) {
        const detail = data && data.detail
        const detailMsg = detail ? (typeof detail === 'string' ? detail : String((detail && detail.error) || JSON.stringify(detail))) : ''
        if (res.status === 401) {
          throw new Error('Tavily API Key 无效（HTTP 401）——请在「设置 → Web 搜索」填写正确的 Tavily API Key（https://app.tavily.com ），或清空该 Key 使用免配置的 keyless 模式')
        }
        if (res.status === 429) {
          throw new Error('Tavily 请求过于频繁（HTTP 429）' + (detailMsg ? '：' + detailMsg : '') + (apiKey ? '' : '——keyless 免费模式有限流，建议在设置中配置 Tavily API Key 或稍后重试'))
        }
        if (res.status === 432 || res.status === 433) {
          throw new Error('Tavily 用量/配额超限（HTTP ' + res.status + '）' + (detailMsg ? '：' + detailMsg : '') + '——请在 https://app.tavily.com 检查套餐与用量')
        }
        throw new Error('Tavily API 错误 (HTTP ' + res.status + ')' + (detailMsg ? ': ' + detailMsg : ''))
      }
      if (!data || !Array.isArray(data.results)) throw new Error('搜索无返回结果')
      return data
    }

    // ── 核心：按后端路由执行一次搜索 ──
    // 返回 { provider: 'volcengine'|'tavily', mode: 'keyed'|'keyless', data }
    async function runSearch(query, opts) {
      const q = String(query == null ? '' : query).trim()
      if (!q) throw new Error('搜索词不能为空')
      const provider = resolveBackend(opts)
      if (provider === 'volcengine') {
        const apiKey = String(pick(opts, 'apiKey', state.volcApiKey)).trim()
        if (!apiKey) {
          throw new Error('未配置火山引擎 API Key——请在「设置 → Web 搜索」填写火山引擎联网搜索 API Key，或让后端走 Tavily（不配任何 Key 时自动使用 Tavily keyless 免费模式）')
        }
        const data = await volcSearch(q, apiKey, opts)
        return { provider: 'volcengine', mode: 'keyed', data: data }
      }
      const apiKey = String(pick(opts, 'apiKey', state.tavilyApiKey)).trim()
      const data = await tavilySearch(q, apiKey, opts)
      return { provider: 'tavily', mode: apiKey ? 'keyed' : 'keyless', data: data }
    }

    // ── 格式化输出（供模型工具 / Provider / 设置页测试）──
    function formatVolc(data) {
      const result = data.Result || {}
      const lines = ['结果数: ' + (result.ResultCount == null ? 0 : result.ResultCount) + '  耗时: ' + (result.TimeCost == null ? 0 : result.TimeCost) + 'ms', '']
      const items = result.WebResults || result.ImageResults || []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        lines.push('[' + (i + 1) + '] ' + (item.Title || ''))
        const meta = []
        if (item.SiteName) meta.push(item.SiteName)
        if (item.AuthInfoDes) meta.push(item.AuthInfoDes)
        if (meta.length > 0) lines.push('    ' + meta.join(' | '))
        if (item.Url) {
          lines.push('    ' + item.Url)
        } else if (item.Image && item.Image.Url) {
          lines.push('    ' + item.Image.Url)
          lines.push('    ' + (item.Image.Width || '?') + 'x' + (item.Image.Height || '?') + ' (' + (item.Image.Shape || '') + ')')
        }
        const summary = item.Summary || item.Snippet || ''
        if (summary) lines.push('    ' + summary)
        lines.push('')
      }
      return lines.join('\n')
    }

    function formatTavily(data) {
      const results = Array.isArray(data.results) ? data.results : []
      const lines = ['结果数: ' + results.length + '  耗时: ' + (data.response_time == null ? '?' : data.response_time) + 's', '']
      for (let i = 0; i < results.length; i++) {
        const item = results[i]
        lines.push('[' + (i + 1) + '] ' + (item.title || ''))
        if (item.url) lines.push('    ' + item.url)
        if (item.published_date) lines.push('    发布于: ' + item.published_date)
        const content = item.content || ''
        if (content) lines.push('    ' + content)
        lines.push('')
      }
      if (results.length === 0 && data.answer) lines.push(data.answer)
      return lines.join('\n')
    }

    function formatResult(provider, mode, data) {
      const head = provider === 'volcengine'
        ? '[后端] 火山引擎 · ' + (mode === 'keyed' ? 'API Key 模式' : '')
        : '[后端] Tavily · ' + (mode === 'keyed' ? 'API Key 模式' : 'Keyless 免费模式（未配置 Key）')
      return head + '\n\n' + (provider === 'tavily' ? formatTavily(data) : formatVolc(data))
    }

    // ── 结构化 sources（供 WebSearchProvider）──
    function toSources(provider, data) {
      const sources = []
      if (provider === 'tavily') {
        const results = Array.isArray(data.results) ? data.results : []
        for (let i = 0; i < results.length; i++) {
          const item = results[i]
          const url = item.url || ''
          if (!url) continue
          const source = { url: url }
          if (item.title) source.title = item.title
          if (item.content) source.snippet = item.content
          if (item.published_date) source.publishedAt = item.published_date
          sources.push(source)
        }
        return sources
      }
      const result = data.Result || {}
      const items = result.WebResults || result.ImageResults || []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const url = item.Url || (item.Image && item.Image.Url) || ''
        if (!url) continue
        const source = { url: url }
        if (item.Title) source.title = item.Title
        const snippet = item.Summary || item.Snippet || ''
        if (snippet) source.snippet = snippet
        sources.push(source)
      }
      return sources
    }

    // ── RPC：设置页读写配置 ──
    harness.handle('get-config', async function () {
      const cfg = clone()
      cfg.effective = effectiveBackend()
      return cfg
    })
    harness.handle('set-config', async function (args) {
      if (args && typeof args === 'object') {
        if (typeof args.volcApiKey === 'string') state.volcApiKey = args.volcApiKey.trim()
        if (typeof args.tavilyApiKey === 'string') state.tavilyApiKey = args.tavilyApiKey.trim()
        if (typeof args.defaultCount === 'number') state.defaultCount = clampInt(args.defaultCount, 1, 50, 10)
        if (typeof args.defaultTimeRange === 'string') state.defaultTimeRange = args.defaultTimeRange.trim()
        if (args.defaultAuthLevel === 0 || args.defaultAuthLevel === 1) state.defaultAuthLevel = args.defaultAuthLevel
        if (typeof args.defaultQueryRewrite === 'boolean') state.defaultQueryRewrite = args.defaultQueryRewrite
        if (['basic', 'advanced', 'fast', 'ultra-fast'].indexOf(args.defaultSearchDepth) >= 0) state.defaultSearchDepth = args.defaultSearchDepth
        if (['general', 'news', 'finance'].indexOf(args.defaultTopic) >= 0) state.defaultTopic = args.defaultTopic
      }
      const cfg = clone()
      cfg.effective = effectiveBackend()
      return cfg
    })
    harness.handle('test-search', async function (args) {
      try {
        const out = await runSearch(args && args.query, { provider: args && args.provider })
        return { ok: true, provider: out.provider, mode: out.mode, text: formatResult(out.provider, out.mode, out.data) }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })

    // ── 模型工具：web_search_multi（后端自动路由：火山引擎 / Tavily keyed / Tavily keyless）──
    harness.registerTool(ctx, harness.defineTool({
      name: 'web_search_multi',
      description:
        '通用联网搜索（火山引擎 / Tavily）：查询实时网页或图片，返回标题、URL 与摘要。'
        + '后端自动选择：配置了火山引擎 API Key 时优先用火山引擎；否则配置了 Tavily API Key 用 Tavily；'
        + '两者都未配置时自动使用 Tavily keyless 免费模式（无需任何 Key）。'
        + '当内置 web_search 工具不可用，或需要指定后端 / 图片搜索 / 时间范围 / 权威来源等高级参数时使用本工具。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词' },
        provider: { type: 'string', enum: ['auto', 'volcengine', 'tavily'], description: '后端：auto 自动路由（默认）/ volcengine 火山引擎 / tavily Tavily' },
        count: { type: 'integer', description: '返回条数（火山引擎 web ≤ 50、image ≤ 5；Tavily ≤ 20），默认 10' },
        type: { type: 'string', enum: ['web', 'image'], description: '搜索类型（仅火山引擎支持 image）：web 网页 / image 图片，默认 web' },
        time_range: { type: 'string', description: '时间范围：火山引擎 OneDay/OneWeek/OneMonth/OneYear 或 YYYY-MM-DD..YYYY-MM-DD；Tavily day/week/month/year/d/w/m/y 或日期区间' },
        auth_level: { type: 'integer', enum: [0, 1], description: '仅火山引擎：0 全部 / 1 仅权威来源，默认 0' },
        query_rewrite: { type: 'boolean', description: '仅火山引擎：开启查询改写优化（口语化长句建议开启），默认 false' },
        search_depth: { type: 'string', enum: ['basic', 'advanced', 'fast', 'ultra-fast'], description: '仅 Tavily：搜索深度，默认 basic' },
        topic: { type: 'string', enum: ['general', 'news', 'finance'], description: '仅 Tavily：搜索主题，默认 general' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      async execute(args) {
        const out = await runSearch(args.query, {
          provider: args.provider,
          count: args.count,
          type: args.type,
          timeRange: args.time_range,
          authLevel: args.auth_level,
          queryRewrite: args.query_rewrite,
          searchDepth: args.search_depth,
          topic: args.topic,
        })
        return formatResult(out.provider, out.mode, out.data)
      },
    }))

    // ── WebSearchProvider：抢占 deepseek-official 实现「替换内置插件」 ──
    // 宿主 base 默认 web.searchProvider=deepseek-official；把内置
    // @deepseek-ai/dsh-web-search-deepseek 从组合里移除后，内置 web_search /
    // ctx.web.search() 无需任何配置即路由到本插件。若内置插件仍挂载（id 被占），
    // 跳过该 id 并给出提示，同时保留 web-search / volcengine 两个别名 id 可用。
    const web = ctx.get('web')
    if (web !== undefined) {
      const register = function (id) {
        try {
          const provider = {
            id: id,
            available() { return true }, // Tavily keyless 兜底：永远可用
            async search(request, signal) {
              const out = await runSearch(request.query, { count: request.maxResults })
              return { content: formatResult(out.provider, out.mode, out.data), sources: toSources(out.provider, out.data), truncated: false }
            },
          }
          web.registerSearchProvider(provider)
          console.log('[web-search-plugin] 已注册搜索 Provider: ' + id)
          return true
        } catch (e) {
          const msg = String((e && e.message) || e)
          if (/already registered|WEB_DUPLICATE_PROVIDER/i.test(msg)) {
            console.error('[web-search-plugin] Provider id=' + id + ' 已被占用（内置 @deepseek-ai/dsh-web-search-deepseek 或旧版插件仍挂载）：' + msg)
          } else {
            console.error('[web-search-plugin] 注册 Provider id=' + id + ' 失败：' + msg)
          }
          return false
        }
      }
      register('deepseek-official') // 替换内置插件：宿主 searchProvider=deepseek-official 直接路由到本插件
      register('web-search')        // 本插件自带 id：可用 DSH_WEB_SEARCH_PROVIDER=web-search 显式选用
      register('volcengine')        // 旧版兼容：已设 DSH_WEB_SEARCH_PROVIDER=volcengine 的用户无需改配置
    }
  },
}
