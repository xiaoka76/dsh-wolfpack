/**
 * Web 搜索插件（火山引擎 + Tavily）—— Client 半部（code.client）
 *
 * 功能：
 *   1. 设置页（settings.section「Web 搜索」）：
 *      - 火山引擎联网搜索 API Key 与 Tavily API Key（两者都可不填；
 *        都不填时自动使用 Tavily keyless 免费模式，无需任何 Key）；
 *      - 默认参数：条数 / 时间范围 / 权威来源 / 查询改写（火山引擎）、
 *        搜索深度 / 主题（Tavily）；
 *      - 当前生效后端展示（自动路由结果）；
 *      - 「测试搜索」（可指定后端 auto/volcengine/tavily），
 *        走 host.call('test-search') → Host 用 DSH 自身 Node 运行时直连 API。
 *
 * 说明：
 *   - 所有配置经 host.call('get-config' / 'set-config') 读写 Host 内存 state；
 *   - 实际搜索在 Host 通过 ctx.subprocess 拉起 DSH 的 Node 运行时执行（浏览器端不做网络调用）；
 *   - 模型工具 `web_search_multi` 由 Host 半部注册，本半部只负责设置 UI。
 *
 * 加载方式：作为 cordis_define 的 code.client 参数内容（async 函数体，return 插件对象）。
 * 约束：纯 JavaScript，无 JSX / TypeScript / import；React 一律 React.createElement。
 */

return {
  apply(ctx) {
    styles.insert([
      '.wsp-settings{display:flex;flex-direction:column;gap:14px;padding:4px 2px;font-size:13px;color:var(--dsw-text-primary,#1f2329)}',
      '.wsp-field{display:flex;flex-direction:column;gap:6px}',
      '.wsp-input{box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-border,#d0d4da);border-radius:6px;background:var(--dsw-bg-input,#fff);color:inherit;font-size:13px;min-width:0}',
      '.wsp-select{box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-border,#d0d4da);border-radius:6px;background:var(--dsw-bg-input,#fff);color:inherit;font-size:13px;min-width:0}',
      '.wsp-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.wsp-inline{flex:1;min-width:140px}',
      '.wsp-btn-action{padding:6px 12px;border:1px solid var(--dsw-border,#d0d4da);border-radius:6px;background:var(--dsw-bg-raised,#fff);color:inherit;font-size:13px;cursor:pointer}',
      '.wsp-btn-action:hover{background:rgba(127,127,127,.08)}',
      '.wsp-btn-action:disabled{opacity:.55;cursor:default}',
      '.wsp-hint{font-size:12px;color:var(--dsw-text-tertiary,#9aa0a6)}',
      '.wsp-ok{font-size:12px;color:#1a7f37}',
      '.wsp-err{font-size:12px;color:var(--dsw-danger,#d93026)}',
      '.wsp-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;background:rgba(64,128,255,.12);color:var(--dsw-text-primary,#1f2329);border:1px solid var(--dsw-border,#d0d4da)}',
      '.wsp-pre{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;max-height:360px;overflow:auto;background:var(--dsw-bg-input,#fff);border:1px solid var(--dsw-border,#d0d4da);border-radius:6px;padding:8px;margin:0;color:inherit}',
    ].join('\n'))

    function effectiveLabel(effective) {
      if (!effective) return ''
      if (effective.provider === 'volcengine') return '火山引擎 · API Key 模式'
      if (effective.provider === 'tavily') return effective.mode === 'keyed' ? 'Tavily · API Key 模式' : 'Tavily · Keyless 免费模式（未配置 Key）'
      return ''
    }

    function SettingsView(props) {
      const [volcApiKey, setVolcApiKey] = React.useState('')
      const [tavilyApiKey, setTavilyApiKey] = React.useState('')
      const [defaultCount, setDefaultCount] = React.useState(10)
      const [defaultTimeRange, setDefaultTimeRange] = React.useState('')
      const [defaultAuthLevel, setDefaultAuthLevel] = React.useState(0)
      const [defaultQueryRewrite, setDefaultQueryRewrite] = React.useState(false)
      const [defaultSearchDepth, setDefaultSearchDepth] = React.useState('basic')
      const [defaultTopic, setDefaultTopic] = React.useState('general')
      const [effective, setEffective] = React.useState(null)
      const [testQuery, setTestQuery] = React.useState('')
      const [testProvider, setTestProvider] = React.useState('auto')
      const [testOut, setTestOut] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(function () {
        host.call('get-config', null).then(function (cfg) {
          if (!cfg) return
          setVolcApiKey(cfg.volcApiKey || '')
          setTavilyApiKey(cfg.tavilyApiKey || '')
          setDefaultCount(cfg.defaultCount == null ? 10 : cfg.defaultCount)
          setDefaultTimeRange(cfg.defaultTimeRange || '')
          setDefaultAuthLevel(cfg.defaultAuthLevel == null ? 0 : cfg.defaultAuthLevel)
          setDefaultQueryRewrite(!!cfg.defaultQueryRewrite)
          setDefaultSearchDepth(cfg.defaultSearchDepth || 'basic')
          setDefaultTopic(cfg.defaultTopic || 'general')
          setEffective(cfg.effective || null)
        }).catch(function () { setErr('读取配置失败') })
      }, [])

      const commit = React.useCallback(function (patch) {
        return host.call('set-config', patch).then(function (cfg) {
          if (cfg && cfg.effective) setEffective(cfg.effective)
          setMsg('设置已保存 ' + new Date().toLocaleTimeString())
          setErr('')
          return cfg
        }, function (e) {
          setErr('保存失败: ' + String((e && e.message) || e))
        })
      }, [])

      const onSave = function () {
        commit({
          volcApiKey: volcApiKey.trim(),
          tavilyApiKey: tavilyApiKey.trim(),
          defaultCount: Math.max(1, Math.min(50, Math.round(Number(defaultCount) || 10))),
          defaultTimeRange: defaultTimeRange.trim(),
          defaultAuthLevel: defaultAuthLevel === 1 ? 1 : 0,
          defaultQueryRewrite: !!defaultQueryRewrite,
          defaultSearchDepth: defaultSearchDepth,
          defaultTopic: defaultTopic,
        })
      }

      const onTest = function () {
        const q = testQuery.trim()
        if (!q) { setErr('请先输入测试搜索词'); return }
        setBusy(true)
        setTestOut('搜索中…')
        host.call('test-search', { query: q, provider: testProvider }).then(function (res) {
          if (res && res.ok) { setTestOut(res.text); setErr('') }
          else { setTestOut(''); setErr('搜索失败: ' + String((res && res.error) || '未知错误')) }
        }, function (e) {
          setTestOut('')
          setErr('搜索失败: ' + String((e && e.message) || e))
        }).then(function () { setBusy(false) })
      }

      const option = function (value, label) {
        return React.createElement('option', { value: value, key: value }, label)
      }

      return React.createElement('div', { className: 'wsp-settings' },
        React.createElement('div', { className: 'wsp-row' },
          React.createElement('span', { className: 'wsp-hint' }, '当前生效后端：'),
          React.createElement('span', { className: 'wsp-badge' }, effectiveLabel(effective) || '—'),
        ),
        React.createElement('div', { className: 'wsp-field' },
          React.createElement('label', null, '火山引擎联网搜索 API Key（可选；https://console.volcengine.com/search-infinity/api-key ）'),
          React.createElement('input', {
            className: 'wsp-input', type: 'password', value: volcApiKey,
            placeholder: '粘贴火山引擎 API Key；留空则不用火山引擎',
            onChange: function (e) { setVolcApiKey(e.target.value) },
          }),
        ),
        React.createElement('div', { className: 'wsp-field' },
          React.createElement('label', null, 'Tavily API Key（可选；https://app.tavily.com ）'),
          React.createElement('input', {
            className: 'wsp-input', type: 'password', value: tavilyApiKey,
            placeholder: '粘贴 Tavily API Key；留空则使用 Tavily keyless 免费模式',
            onChange: function (e) { setTavilyApiKey(e.target.value) },
          }),
        ),
        React.createElement('div', { className: 'wsp-hint' },
          '后端自动路由：填了火山引擎 Key → 火山引擎；否则填了 Tavily Key → Tavily；两者都未配置 → Tavily keyless 免费模式（无需任何 Key，开箱即用）。',
        ),
        React.createElement('div', { className: 'wsp-row' },
          React.createElement('div', { className: 'wsp-field wsp-inline' },
            React.createElement('label', null, '默认条数'),
            React.createElement('input', {
              className: 'wsp-input', type: 'number', min: '1', max: '50', value: defaultCount,
              onChange: function (e) { setDefaultCount(e.target.value) },
            }),
          ),
          React.createElement('div', { className: 'wsp-field wsp-inline' },
            React.createElement('label', null, '默认时间范围'),
            React.createElement('input', {
              className: 'wsp-input', value: defaultTimeRange,
              placeholder: '火山: OneDay/OneWeek/… ; Tavily: day/week/… 或日期区间',
              onChange: function (e) { setDefaultTimeRange(e.target.value) },
            }),
          ),
        ),
        React.createElement('div', { className: 'wsp-row' },
          React.createElement('label', null,
            React.createElement('input', {
              type: 'checkbox', checked: defaultAuthLevel === 1,
              onChange: function (e) { setDefaultAuthLevel(e.target.checked ? 1 : 0) },
            }),
            ' 默认仅权威来源（火山引擎）',
          ),
          React.createElement('label', null,
            React.createElement('input', {
              type: 'checkbox', checked: defaultQueryRewrite,
              onChange: function (e) { setDefaultQueryRewrite(e.target.checked) },
            }),
            ' 默认查询改写（火山引擎）',
          ),
        ),
        React.createElement('div', { className: 'wsp-row' },
          React.createElement('div', { className: 'wsp-field wsp-inline' },
            React.createElement('label', null, 'Tavily 搜索深度'),
            React.createElement('select', {
              className: 'wsp-select', value: defaultSearchDepth,
              onChange: function (e) { setDefaultSearchDepth(e.target.value) },
            },
              option('basic', 'basic（均衡）'),
              option('advanced', 'advanced（高精度）'),
              option('fast', 'fast（低延迟）'),
              option('ultra-fast', 'ultra-fast（最快）'),
            ),
          ),
          React.createElement('div', { className: 'wsp-field wsp-inline' },
            React.createElement('label', null, 'Tavily 主题'),
            React.createElement('select', {
              className: 'wsp-select', value: defaultTopic,
              onChange: function (e) { setDefaultTopic(e.target.value) },
            },
              option('general', 'general（综合）'),
              option('news', 'news（新闻）'),
              option('finance', 'finance（财经）'),
            ),
          ),
        ),
        React.createElement('button', { className: 'wsp-btn-action', onClick: onSave, disabled: busy }, '保存设置'),
        msg ? React.createElement('div', { className: 'wsp-ok' }, msg) : null,
        err ? React.createElement('div', { className: 'wsp-err' }, err) : null,
        React.createElement('div', { className: 'wsp-field' },
          React.createElement('label', null, '测试搜索'),
          React.createElement('div', { className: 'wsp-row' },
            React.createElement('input', {
              className: 'wsp-input wsp-inline', value: testQuery,
              placeholder: '输入搜索词，如：北京今日天气',
              onChange: function (e) { setTestQuery(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') onTest() },
            }),
            React.createElement('select', {
              className: 'wsp-select', value: testProvider,
              onChange: function (e) { setTestProvider(e.target.value) },
            },
              option('auto', 'auto（自动路由）'),
              option('volcengine', 'volcengine（火山引擎）'),
              option('tavily', 'tavily（Tavily）'),
            ),
            React.createElement('button', { className: 'wsp-btn-action', onClick: onTest, disabled: busy }, '搜索'),
          ),
        ),
        testOut ? React.createElement('pre', { className: 'wsp-pre' }, testOut) : null,
      )
    }

    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', function () {
      return slots.register({ name: 'settings.section', id: 'web-search', order: 32, label: 'Web 搜索' }, SettingsView)
    })
  },
}
