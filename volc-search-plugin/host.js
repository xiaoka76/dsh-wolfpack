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
 * 依赖 DSH 自身运行（核心决策，不依赖系统 curl）：
 *   - 动态插件 Host 沙箱**没有 fetch**（被 trap 并提示走 ctx.web），无法直接 POST
 *     Volcengine API；`ctx.web.fetch` 只支持 `{url}`，不能自定义 method/headers/body；
 *   - 本实现**不依赖系统 curl / Python / 任何需安装的外部工具**，而是通过宿主
 *     `ctx.subprocess` 拉起 **DSH 自身所在的 Node 运行时**（`resolveExecutable('node')`），
 *     用 Node 内置 `https` 模块直接 POST 火山引擎联网搜索 API。Node 是 DSH 的运行基础，
 *     必然存在，且自带 OpenSSL，不受本机 curl 的 TLS/schannel 问题影响；
 *   - 请求 JSON body 经 stdin 传入（与原先 `--data-binary @-` 等价），避免命令行转义；
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

    // ── 内联 Node 脚本：由 DSH 自身所在的 Node 运行时执行，替代系统 curl ──
    // 行为与原先 curl 对齐：任何 HTTP 响应（含 4xx/5xx）都写 body 到 stdout 并以 0 退出，
    // 由插件解析 JSON 判断业务错误；只有传输层错误（DNS/连接/TLS/超时）才非 0 退出。
    // 该脚本运行在独立 node 子进程里，`require/process/Buffer` 均可用（不受宿主沙箱限制）。
    const NODE_SCRIPT = `
const https = require('https')
const API_URL = ${JSON.stringify(API_URL)}
const TRAFFIC_TAG = ${JSON.stringify(TRAFFIC_TAG)}
let body = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (c) { body += c })
process.stdin.on('end', function () {
  const url = new URL(API_URL)
  const headers = {
    'Content-Type': 'application/json',
    'X-Traffic-Tag': TRAFFIC_TAG,
    'Content-Length': String(Buffer.byteLength(body)),
  }
  const key = (process.env.VOLC_API_KEY || '').trim()
  if (key) headers['Authorization'] = 'Bearer ' + key
  const req = https.request({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: headers,
    timeout: 25000,
  }, function (res) {
    const chunks = []
    res.on('data', function (c) { chunks.push(c) })
    res.on('end', function () {
      const out = Buffer.concat(chunks).toString('utf8')
      process.stdout.write(out, function () { process.exit(0) })
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

    // ── 核心：DSH Node 运行时直连火山引擎搜索 API，返回解析后的 JSON ──
    async function search(query, opts) {
      const q = String(query == null ? '' : query).trim()
      if (!q) throw new Error('搜索词不能为空')
      const apiKey = String(opts && opts.apiKey != null ? opts.apiKey : state.apiKey).trim()
      const bodyText = JSON.stringify(buildBody(q, opts))
      const nodeExe = await resolveNode()

      // env 显式条目在 subprocess 的敏感变量 scrub 之后合并，`VOLC_API_KEY` 能存活传给子进程
      const handle = ctx.subprocess.spawn({
        argv: [nodeExe, '-e', NODE_SCRIPT],
        cwd: '.',
        env: { VOLC_API_KEY: apiKey },
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
