/**
 * IndexTTS 语音朗读 —— Host 半部（code.host）
 *
 * 作用：作为该动态插件的“配置存储”，通过 Package 私有 RPC（harness.handle ↔ host.call）
 * 向浏览器半部提供：
 *   - get-config : 读取当前配置（API Key / 音色 / 语速 / 采样率 / 增益）
 *   - set-config : 更新配置（带范围校验）
 *
 * 说明：
 *   - 配置保存在内存中，随插件生命周期存续（动态插件不引入持久化存储）。
 *   - 所有 IndexTTS-2 API 网络调用（合成 / 音色上传 / 列表 / 删除）都在浏览器半部
 *     通过 XMLHttpRequest 直接完成（CORS 已实测开放），Host 只持有配置。
 *
 * 加载方式：作为 cordis_define 的 code.host 参数内容（async 函数体，return 插件对象）。
 */

return {
  apply(ctx) {
    const state = {
      apiKey: '',
      voiceId: '',
      voiceName: '',
      speed: 1,
      sampleRate: 44100,
      gain: null,
    }
    const clone = function () { return JSON.parse(JSON.stringify(state)) }
    harness.handle('get-config', async function () { return clone() })
    harness.handle('set-config', async function (args) {
      if (args && typeof args === 'object') {
        if (typeof args.apiKey === 'string') state.apiKey = args.apiKey.trim() // 统一去首尾空白（review #18）
        if (typeof args.voiceId === 'string') state.voiceId = args.voiceId
        if (typeof args.voiceName === 'string') state.voiceName = args.voiceName
        if (typeof args.speed === 'number' && args.speed >= 0.25 && args.speed <= 4) state.speed = args.speed
        if (args.sampleRate === 22050 || args.sampleRate === 44100 || args.sampleRate === 48000) state.sampleRate = args.sampleRate
        if (args.gain === null || (typeof args.gain === 'number' && args.gain > 0 && args.gain <= 10)) state.gain = args.gain
      }
      return clone()
    })
  },
}
