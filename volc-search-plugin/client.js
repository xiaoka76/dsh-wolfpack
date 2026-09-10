/**
 * 火山引擎（豆包）联网搜索 —— Client 半部（code.client）
 *
 * 功能：
 *   1. 设置页（settings.section「火山引擎搜索」）：API Key、默认参数
 *      （条数 / 时间范围 / 权威级别 / 查询改写），以及「测试搜索」按钮
 *      （走 host.call('test-search') → Host 用系统自带 curl 直连 API）。
 *
 * 说明：
 *   - 所有配置经 host.call('get-config' / 'set-config') 读写 Host 内存 state；
 *   - 实际搜索在 Host 通过 ctx.subprocess 执行（浏览器端不做网络调用）；
 *   - 搜索工具 `byted_web_search` 由 Host 半部注册，本半部只负责设置 UI。
 *
 * 加载方式：作为 cordis_define 的 code.client 参数内容（async 函数体，return 插件对象）。
 * 约束：纯 JavaScript，无 JSX / TypeScript / import；React 一律 React.createElement。
 */

return {
  apply(ctx) {
    styles.insert([
      '.vsw-settings{display:flex;flex-direction:column;gap:14px;padding:4px 2px;font-size:13px;color:var(--dsw-text-primary,#1f2329)}',
      '.vsw-field{display:flex;flex-direction:column;gap:6px}',
      '.vsw-input{box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-border,#d0d4da);border-radius:6px;background:var(--dsw-bg-input,#fff);color:inherit;font-size:13px;min-width:0}',
      '.vsw-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.vsw-inline{flex:1;min-width:140px}',
      '.vsw-btn-action{padding:6px 12px;border:1px solid var(--dsw-border,#d0d4da);border-radius:6px;background:var(--dsw-bg-raised,#fff);color:inherit;font-size:13px;cursor:pointer}',
      '.vsw-btn-action:hover{background:rgba(127,127,127,.08)}',
      '.vsw-hint{font-size:12px;color:var(--dsw-text-tertiary,#9aa0a6)}',
      '.vsw-ok{font-size:12px;color:#1a7f37}',
      '.vsw-err{font-size:12px;color:var(--dsw-danger,#d93026)}',
      '.vsw-pre{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;max-height:360px;overflow:auto;background:var(--dsw-bg-input,#fff);border:1px solid var(--dsw-border,#d0d4da);border-radius:6px;padding:8px;margin:0;color:inherit}',
    ].join('\n'))

    function SettingsView(props) {
      const [apiKey, setApiKey] = React.useState('')
      const [defaultCount, setDefaultCount] = React.useState(10)
      const [defaultTimeRange, setDefaultTimeRange] = React.useState('')
      const [defaultAuthLevel, setDefaultAuthLevel] = React.useState(0)
      const [defaultQueryRewrite, setDefaultQueryRewrite] = React.useState(false)
      const [testQuery, setTestQuery] = React.useState('')
      const [testOut, setTestOut] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(function () {
        host.call('get-config', null).then(function (cfg) {
          if (!cfg) return
          setApiKey(cfg.apiKey || '')
          setDefaultCount(cfg.defaultCount == null ? 10 : cfg.defaultCount)
          setDefaultTimeRange(cfg.defaultTimeRange || '')
          setDefaultAuthLevel(cfg.defaultAuthLevel == null ? 0 : cfg.defaultAuthLevel)
          setDefaultQueryRewrite(!!cfg.defaultQueryRewrite)
        }).catch(function () { setErr('读取配置失败') })
      }, [])

      const commit = React.useCallback(function (patch) {
        return host.call('set-config', patch).then(function () {
          setMsg('设置已保存 ' + new Date().toLocaleTimeString())
          setErr('')
        }, function (e) {
          setErr('保存失败: ' + String((e && e.message) || e))
        })
      }, [])

      const onSave = function () {
        commit({
          apiKey: apiKey.trim(),
          defaultCount: Math.max(1, Math.min(50, Math.round(Number(defaultCount) || 10))),
          defaultTimeRange: defaultTimeRange.trim(),
          defaultAuthLevel: defaultAuthLevel === 1 ? 1 : 0,
          defaultQueryRewrite: !!defaultQueryRewrite,
        })
      }

      const onTest = function () {
        const q = testQuery.trim()
        if (!q) { setErr('请先输入测试搜索词'); return }
        setBusy(true)
        setTestOut('搜索中…')
        host.call('test-search', { query: q }).then(function (res) {
          if (res && res.ok) { setTestOut(res.text); setErr('') }
          else { setTestOut(''); setErr('搜索失败: ' + String((res && res.error) || '未知错误')) }
        }, function (e) {
          setTestOut('')
          setErr('搜索失败: ' + String((e && e.message) || e))
        }).then(function () { setBusy(false) })
      }

      return React.createElement('div', { className: 'vsw-settings' },
        React.createElement('div', { className: 'vsw-field' },
          React.createElement('label', null, 'API Key（火山引擎联网搜索，必填；https://console.volcengine.com/search-infinity/api-key ）'),
          React.createElement('input', {
            className: 'vsw-input', type: 'password', value: apiKey,
            placeholder: '粘贴 API Key', onChange: function (e) { setApiKey(e.target.value) },
          }),
        ),
        React.createElement('div', { className: 'vsw-row' },
          React.createElement('div', { className: 'vsw-field vsw-inline' },
            React.createElement('label', null, '默认条数'),
            React.createElement('input', {
              className: 'vsw-input', type: 'number', min: '1', max: '50', value: defaultCount,
              onChange: function (e) { setDefaultCount(e.target.value) },
            }),
          ),
          React.createElement('div', { className: 'vsw-field vsw-inline' },
            React.createElement('label', null, '默认时间范围'),
            React.createElement('input', {
              className: 'vsw-input', value: defaultTimeRange,
              placeholder: 'OneDay / OneWeek / OneMonth / OneYear / 日期区间',
              onChange: function (e) { setDefaultTimeRange(e.target.value) },
            }),
          ),
        ),
        React.createElement('div', { className: 'vsw-row' },
          React.createElement('label', null,
            React.createElement('input', {
              type: 'checkbox', checked: defaultAuthLevel === 1,
              onChange: function (e) { setDefaultAuthLevel(e.target.checked ? 1 : 0) },
            }),
            ' 默认仅权威来源',
          ),
          React.createElement('label', null,
            React.createElement('input', {
              type: 'checkbox', checked: defaultQueryRewrite,
              onChange: function (e) { setDefaultQueryRewrite(e.target.checked) },
            }),
            ' 默认查询改写',
          ),
        ),
        React.createElement('button', { className: 'vsw-btn-action', onClick: onSave, disabled: busy }, '保存设置'),
        msg ? React.createElement('div', { className: 'vsw-ok' }, msg) : null,
        err ? React.createElement('div', { className: 'vsw-err' }, err) : null,
        React.createElement('div', { className: 'vsw-field' },
          React.createElement('label', null, '测试搜索'),
          React.createElement('div', { className: 'vsw-row' },
            React.createElement('input', {
              className: 'vsw-input vsw-inline', value: testQuery,
              placeholder: '输入搜索词，如：北京今日天气',
              onChange: function (e) { setTestQuery(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') onTest() },
            }),
            React.createElement('button', { className: 'vsw-btn-action', onClick: onTest, disabled: busy }, '搜索'),
          ),
        ),
        testOut ? React.createElement('pre', { className: 'vsw-pre' }, testOut) : null,
      )
    }

    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', function () {
      return slots.register({ name: 'settings.section', id: 'volc-search', order: 32, label: '火山引擎搜索' }, SettingsView)
    })
  },
}
