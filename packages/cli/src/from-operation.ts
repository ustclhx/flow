import { readFile } from 'node:fs/promises'
import { fail, invokeOperation, type Operation, resolveFlowHome } from '@flow/core'
import type { z } from 'zod'
import { type Command, defineCommand, type OptionSpec } from './command.ts'

type FieldKind = 'string' | 'number' | 'boolean' | 'array'

/** 剥掉 optional / default / nullable 包装，取字段的基础类型。 */
function fieldKind(schema: z.ZodType): FieldKind {
  let def = (schema as unknown as { def: { type: string; innerType?: z.ZodType } }).def
  while (def.innerType && ['optional', 'default', 'nullable', 'prefault'].includes(def.type)) {
    def = (def.innerType as unknown as { def: typeof def }).def
  }
  if (def.type === 'boolean') return 'boolean'
  if (def.type === 'number' || def.type === 'int') return 'number'
  if (def.type === 'array') return 'array'
  return 'string'
}

const kebab = (key: string) => key.replace(/[A-Z_]/g, (c) => `-${c === '_' ? '' : c.toLowerCase()}`)

/** 由操作定义生成 CLI 命令：位置参数与选项映射到同一个输入对象，再交给操作的 zod schema 校验。 */
export function commandFromOperation(op: Operation<never, unknown>): Command<unknown> {
  const shape = op.input.shape as Record<string, z.ZodType>
  const positional = op.positional ?? []
  const options: Record<string, OptionSpec> = {}
  const optionKeys: Record<string, string> = {}
  for (const [key, schema] of Object.entries(shape)) {
    if (positional.includes(key)) continue
    const kind = fieldKind(schema)
    const name = kebab(key)
    optionKeys[name] = key
    const description = schema.description
    options[name] = {
      type: kind === 'boolean' ? 'boolean' : 'string',
      ...(kind === 'array' ? { multiple: true } : {}),
      ...(description ? { description } : {}),
    }
  }
  if (op.fileInput)
    options.file = { type: 'string', description: '完整输入的 JSON 文件（与字段选项互斥）' }
  const usage = [
    op.cli,
    ...positional.map((p, i) =>
      i === positional.length - 1 && fieldKind(shape[p] as z.ZodType) === 'array'
        ? `<${p}...>`
        : `<${p}>`,
    ),
  ].join(' ')

  return defineCommand({
    name: op.cli,
    summary: op.summary,
    usage,
    options,
    run: async ({ args, options: values, actor }) => {
      let raw: Record<string, unknown> = {}
      if (op.fileInput && typeof values.file === 'string') {
        if (args.length || Object.keys(values).some((key) => key !== 'file')) {
          return fail('usage', 'invalid_arguments', '--file 不能与字段选项或位置参数同时使用')
        }
        let text: string
        try {
          text = await readFile(values.file, 'utf8')
        } catch {
          return fail('failure', 'read_failed', '无法读取输入文件')
        }
        try {
          raw = JSON.parse(text)
        } catch {
          return fail('usage', 'invalid_arguments', '输入文件不是合法的 JSON')
        }
      }
      positional.forEach((key, i) => {
        const last = i === positional.length - 1
        const kind = fieldKind(shape[key] as z.ZodType)
        if (last && kind === 'array') raw[key] = args.slice(i)
        else if (last && kind === 'string' && args.length > i) raw[key] = args.slice(i).join(' ')
        else if (args[i] !== undefined) raw[key] = args[i]
      })
      if (args.length > positional.length && positional.length === 0) {
        return fail('usage', 'invalid_arguments', `${op.cli} 不接受位置参数`)
      }
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined || (op.fileInput && name === 'file')) continue
        const key = optionKeys[name] as string
        raw[key] = fieldKind(shape[key] as z.ZodType) === 'number' ? Number(value) : value
      }
      return invokeOperation(op, raw, {
        home: resolveFlowHome(process.env),
        actor,
        via: 'cli',
      })
    },
    ...(op.human ? { human: op.human } : {}),
  })
}
