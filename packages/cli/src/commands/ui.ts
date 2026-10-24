import { execFile } from 'node:child_process'
import {
  fail,
  HubClient,
  loadHubConfig,
  ok,
  type Result,
  resolveFlowHome,
  resolveHubUrl,
} from '@flow/core'
import { defineCommand } from '../command.ts'

/**
 * `flow ui`（add-m1-inbox 6.1，design D5）：向中枢申请一次性登录码，在浏览器中打开
 * `http://127.0.0.1:<端口>/ui/login?code=...`。登录码 60 秒内有效、只能使用一次。
 */

/** 打开链接的方式；测试注入，或用 `--print` 只输出链接。 */
export type UrlOpener = (url: string) => Promise<Result<void>>

/** 默认用系统命令打开：macOS 的 `open`，Linux 的 `xdg-open`；参数直接传递，不经过 shell。 */
export const systemOpener: UrlOpener = (url) => {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null
  if (!cmd) {
    return Promise.resolve(
      fail('failure', 'open_unsupported', '当前系统不支持自动打开浏览器，请用 --print'),
    )
  }
  return new Promise((resolve) => {
    execFile(cmd, [url], (err) => {
      resolve(
        err ? fail('failure', 'open_failed', `无法打开浏览器：${err.message}`) : ok(undefined),
      )
    })
  })
}

export interface UiCommandData {
  url: string
  expires_at: string
  opened: boolean
}

export function createUiCommand(opener: UrlOpener = systemOpener) {
  return defineCommand<UiCommandData>({
    name: 'ui',
    usage: 'ui [--print]',
    summary: '在浏览器中打开"需要我的"页面（生成一次性登录链接，仅 user）',
    options: {
      print: { type: 'boolean', description: '只输出登录链接，不打开浏览器' },
    },
    run: async ({ actor, options }) => {
      const home = resolveFlowHome(process.env)
      const config = await loadHubConfig(home)
      if (!config.ok) return config
      const issued = await new HubClient({ home, actor }).uiLoginCode()
      if (!issued.ok) return issued
      const url = `${resolveHubUrl(config.data)}${issued.data.login_path}`
      if (options.print === true)
        return ok({ url, expires_at: issued.data.expires_at, opened: false })
      const opened = await opener(url)
      if (!opened.ok) return opened
      return ok({ url, expires_at: issued.data.expires_at, opened: true })
    },
    human: ({ url, opened }) =>
      [
        opened ? '已在浏览器中打开"需要我的"页面。' : '在浏览器中打开下面的链接登录：',
        ...(opened ? ['如果浏览器没有打开，请手动访问：'] : []),
        url,
        '链接 60 秒内有效，只能使用一次。',
      ].join('\n'),
  })
}

export const uiCommand = createUiCommand()
