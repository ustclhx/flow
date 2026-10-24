import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import {
  fail,
  initSecrets,
  loadSecrets,
  ok,
  type Result,
  resolveFlowHome,
  type SecretsOptions,
  secretPathSchema,
  setSecret,
} from '@flow/core'
import { type Command, defineCommand } from '../command.ts'

/** 交互输入由 readline 管理 raw mode，但所有终端回显都丢弃；提示单独写 stderr。 */
export async function readSecretValue(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<Result<string>> {
  if (!input.isTTY) {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of input) chunks.push(Buffer.from(chunk))
      return ok(
        Buffer.concat(chunks)
          .toString('utf8')
          .replace(/[\r\n]+$/, ''),
      )
    } catch {
      return fail('failure', 'secret_input_failed', '读取标准输入失败')
    }
  }
  output.write('密钥值（不回显）：')
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const rl = createInterface({ input, output: muted, terminal: true, historySize: 0 })
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: Result<string>) => {
      if (settled) return
      settled = true
      rl.close()
      muted.end()
      output.write('\n')
      resolve(result)
    }
    rl.on('SIGINT', () => finish(fail('failure', 'secret_input_cancelled', '已取消密钥输入')))
    rl.on('close', () => finish(fail('failure', 'secret_input_cancelled', '密钥输入已结束')))
    rl.question('', (value) => finish(ok(value)))
  })
}

export function createSecretsCommands(
  opts: SecretsOptions & {
    home?: string
    readValue?: () => Promise<Result<string>>
  } = {},
): Command<unknown>[] {
  const home = () => opts.home ?? resolveFlowHome(process.env)
  const invalidArgs = () =>
    fail('usage', 'invalid_arguments', '只接受路径参数；密钥值必须从标准输入或不回显的提示读取')
  return [
    defineCommand({
      name: 'secrets init',
      summary: '初始化 sops + age 密钥并提示离线备份',
      run: ({ args }) => (args.length ? Promise.resolve(invalidArgs()) : initSecrets(home(), opts)),
      human: (data) => data.notice,
    }),
    defineCommand({
      name: 'secrets set',
      usage: 'secrets set <路径>',
      summary: '从标准输入或不回显的提示读取并加密保存密钥',
      async run({ args }) {
        if (args.length !== 1) return invalidArgs()
        const path = args[0] as string
        if (!secretPathSchema.safeParse(path).success)
          return fail('usage', 'invalid_secret_path', '密钥路径应为 a/b-c 格式')
        const value = await (opts.readValue ?? readSecretValue)()
        return value.ok ? setSecret(home(), path, value.data, opts) : value
      },
      human: (data) => `已保存：${data.path}`,
    }),
    defineCommand({
      name: 'secrets list',
      summary: '只列出密钥路径',
      async run({ args }) {
        if (args.length) return invalidArgs()
        const loaded = await loadSecrets(home(), opts)
        return loaded.ok ? ok([...loaded.data.keys()].sort()) : loaded
      },
      human: (paths) => paths.join('\n'),
    }),
    defineCommand({
      name: 'secrets get',
      usage: 'secrets get <路径>',
      summary: '仅用户本人可读取密钥值',
      async run({ args, actor }) {
        // 环境身份只能降级，--actor user 不能抹掉 FLOW_ACTOR 声明的 AI 身份。
        if (
          actor !== 'user' ||
          (process.env.FLOW_ACTOR !== undefined && process.env.FLOW_ACTOR !== 'user')
        ) {
          return fail('failure', 'user_only', '只有 user 可以读取密钥值')
        }
        if (args.length !== 1) return invalidArgs()
        const path = args[0] as string
        if (!secretPathSchema.safeParse(path).success)
          return fail('usage', 'invalid_secret_path', '密钥路径应为 a/b-c 格式')
        const loaded = await loadSecrets(home(), opts)
        if (!loaded.ok) return loaded
        const value = loaded.data.get(path)
        return value === undefined
          ? fail('failure', 'secret_not_found', '密钥路径不存在')
          : ok(value)
      },
      human: (value) => value,
    }),
  ] as Command<unknown>[]
}

export const secretsCommands = createSecretsCommands()
