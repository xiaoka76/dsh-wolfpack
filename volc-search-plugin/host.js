/**
 * 火山引擎（豆包）联网搜索 —— Host 半部（code.host）
 *
 * 作用：
 *   1. 注册模型工具 `byted_web_search`：agent 可直接调用，用火山引擎联网搜索 API 搜索
 *      网页/图片，返回标题、来源、URL、摘要。
 *   2. 注册 `ctx.web` 搜索 Provider（id: `volcengine`）：在宿主把 web 服务
 *      `searchProvider` 配成 `volcengine`（或 `DSH_WEB_SEARCH_PROVIDER=volcengine`）
 *      后，内置 `web_search` 工具也走火山引擎。
 *   3. RPC（get-config / set-config / test-search）：设置页读写 API Key 与默认参数。
 *
 * 0 外部依赖（核心决策）：
 *   - 动态插件 Host 沙箱**没有 fetch**（被 trap 并提示走 ctx.web），无法直接 POST
 *     Volcengine API；
 *   - 本实现**不依赖 Python / requests / 任何需安装的运行时**，而是通过宿主
 *     `ctx.subprocess` 拉起**操作系统自带的 curl**（Windows 10+ / macOS / Linux 均自带）
 *     直接 POST 火山引擎联网搜索 API；
 *   - 请求 JSON body 经 stdin（`--data-binary @-`）传入，避免命令行转义问题；
 *   - 响应是结构化 JSON（`ResponseMetadata` + `Result.WebResults/ImageResults`），
 *     直接解析，无需文本再解析。
 *
 * 凭证：
 *   - 仅支持 API Key 模式（Bearer token，推荐方式）。AK/SK 签名模式需要 HMAC-SHA256，
 *     沙箱无 crypto 模块无法实现，故不支持。
 *   - 凭证来自插件配置 apiKey（设置页填写）；留空则请求会得到 invalid_api_key，
 *     插件给出明确提示。
 *
 * 加载方式：作为 cordis_define 的 code.host 参数内容（async 函数体，return 插件对象）。
 */

return {
  inject: ['subprocess'],
  apply(ctx) {
    // ── 内存配置（动态插件不引入持久化，随插件生命周期存续）──
    const state = {
      apiKey: '',
      defaultCount: 10,
      defaultTimeRange: '',
      defaultAuthLevel: 0,
      defaultQueryRewrite: false,
    }
    const clone = function () { return JSON.parse(JSON.stringify(state)) }

    // ── API 常量（与 byted-web-search 技能 CLI 的 Custom 版 API Key 路径一致）──
    const API_URL = 'https://open.feedcoopapi.com/search_api/web_search'
    const TRAFFIC_TAG = 'skill_web_search_common'

    // ── 构造请求 body（对照技能 CLI build_body）──
    // opts: { count?, type?, timeRange?, authLevel?, queryRewrite?, apiKey? }
    function buildBody(query, opts) {
      const type = opts && opts.type ? opts.type : 'web'
      const body = {
        Query: query,
        SearchType: type,
        Count: (opts && opts.count != null ? opts.count : state.defaultCount) || 10,
      }
      if (type === 'web') {
        body.NeedSummary = true
        const al = opts && opts.authLevel != null ? opts.authLevel : state.defaultAuthLevel
        if (al > 0) body.Filter = { AuthInfoLevel: al }
        const tr = opts && opts.timeRange != null ? opts.timeRange : state.defaultTimeRange
        if (tr) body.TimeRange = tr
      }
      const qr = opts && opts.queryRewrite != null ? opts.queryRewrite : state.defaultQueryRewrite
      if (qr) body.QueryControl = { QueryRewrite: true }
      return body
    }

    // ── 核心：curl 直连火山引擎搜索 API，返回解析后的 JSON ──
    async function search(query, opts) {
      const q = String(query == null ? '' : query).trim()
      if (!q) throw new Error('搜索词不能为空')
      const apiKey = String(opts && opts.apiKey != null ? opts.apiKey : state.apiKey).trim()
      const bodyText = JSON.stringify(buildBody(q, opts))

      const argv = [
        'curl', '-s', '-S', '-X', 'POST', API_URL,
        '-H', 'Content-Type: application/json',
        '-H', 'X-Traffic-Tag: ' + TRAFFIC_TAG,
      ]
      if (apiKey) argv.push('-H', 'Authorization: Bearer ' + apiKey)
      argv.push('--data-binary', '@-', '--max-time', '25')

      const handle = ctx.subprocess.spawn({
        argv,
        cwd: '.',
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
        throw new Error('curl 请求失败 (exit ' + String(outcome.exitCode) + '): ' + ((err || out) || '未知错误').trim())
      }

      let data
      try {
        data = JSON.parse(out)
      } catch (e) {
        throw new Error('无法解析 API 响应: ' + (out || err || '').slice(0, 300))
      }
      const metaErr = data && data.ResponseMetadata && data.ResponseMetadata.Error
      if (metaErr) {
        const code = String(metaErr.Code || '')
        const msg = String(metaErr.Message || '')
        if (/invalid_api_key|10403/i.test(code)) {
          throw new Error('API Key 无效或未开通（' + code + ' ' + msg + '）——请在「设置 → 火山引擎搜索」填写正确的 API Key（https://console.volcengine.com/search-infinity/api-key ）')
        }
        throw new Error('火山引擎搜索 API 错误 [' + code + ']: ' + msg)
      }
      if (!data || !data.Result) throw new Error('搜索无返回结果')
      return data
    }

    // ── 格式化输出（供模型工具 / 设置页测试）──
    function formatResult(data) {
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

    // ── 结构化 sources（供 WebSearchProvider）──
    function toSources(data) {
      const result = data.Result || {}
      const items = result.WebResults || result.ImageResults || []
      const sources = []
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
    harness.handle('get-config', async function () { return clone() })
    harness.handle('set-config', async function (args) {
      if (args && typeof args === 'object') {
        if (typeof args.apiKey === 'string') state.apiKey = args.apiKey.trim()
        if (typeof args.defaultCount === 'number' && args.defaultCount >= 1 && args.defaultCount <= 50) state.defaultCount = Math.round(args.defaultCount)
        if (typeof args.defaultTimeRange === 'string') state.defaultTimeRange = args.defaultTimeRange.trim()
        if (args.defaultAuthLevel === 0 || args.defaultAuthLevel === 1) state.defaultAuthLevel = args.defaultAuthLevel
        if (typeof args.defaultQueryRewrite === 'boolean') state.defaultQueryRewrite = args.defaultQueryRewrite
      }
      return clone()
    })
    harness.handle('test-search', async function (args) {
      try {
        const data = await search(args && args.query, {})
        return { ok: true, text: formatResult(data) }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })

    // ── 模型工具：byted_web_search ──
    harness.registerTool(ctx, harness.defineTool({
      name: 'byted_web_search',
      description:
        '火山引擎（豆包）联网搜索：用火山引擎联网搜索 API 查询实时网页或图片。'
        + '返回结果数、每条结果的标题、来源站点、URL 与摘要。'
        + '适用于需要最新网络信息、时效性事实、出处核实的搜索。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词（1~100 字符）' },
        count: { type: 'integer', description: '返回条数（web ≤ 50，image ≤ 5），默认 10' },
        type: { type: 'string', enum: ['web', 'image'], description: '搜索类型：web 网页 / image 图片，默认 web' },
        time_range: { type: 'string', description: '时间范围：OneDay / OneWeek / OneMonth / OneYear 或 YYYY-MM-DD..YYYY-MM-DD' },
        auth_level: { type: 'integer', enum: [0, 1], description: '0 全部 / 1 仅权威来源，默认 0' },
        query_rewrite: { type: 'boolean', description: '开启查询改写优化（口语化长句建议开启），默认 false' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      async execute(args) {
        const data = await search(args.query, {
          count: args.count,
          type: args.type,
          timeRange: args.time_range,
          authLevel: args.auth_level,
          queryRewrite: args.query_rewrite,
        })
        return formatResult(data)
      },
    }))

    // ── WebSearchProvider：id=volcengine ──
    // 注：宿主 base 默认把 web.searchProvider 钉在 deepseek-official；
    // 把宿主 web 服务 searchProvider 改为 volcengine（或设 DSH_WEB_SEARCH_PROVIDER=volcengine）
    // 后，内置 web_search / ctx.web.search() 才会路由到这里。
    const web = ctx.get('web')
    if (web !== undefined) {
      web.registerSearchProvider({
        id: 'volcengine',
        available() { return true },
        async search(request, signal) {
          const data = await search(request.query, { count: request.maxResults })
          return { content: formatResult(data), sources: toSources(data), truncated: false }
        },
      })
    }
  },
}
