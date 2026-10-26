import { z } from 'zod'
import { HubClient } from '../daemon/client.ts'
import { fail } from '../result.ts'
import { BRIEF_WRITERS } from '../write/policy.ts'
import { defineOperation } from './operation.ts'

/**
 * `brief_update`（design D7、D8）：整体替换本 workspace 的 supervisor 简报笔记。
 * 执行位置是中枢：这里只做本地的身份预检并把请求交给中枢，**不在本地写文件**；
 * 中枢核对调用方身份与 workspace 绑定、`base_hash` 与长度后经写入层（脱敏、gitleaks、提交）写入。
 */
export const briefUpdateInput = z.strictObject({
  workspace: z.string().min(1).describe('workspace（ws/<id> 或 <id>）'),
  text: z
    .string()
    .describe('新的笔记全文：当前状态、关注点、进行中的计划（整体替换，最多 3000 字符）'),
  base_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'base_hash 应为 64 位小写十六进制')
    .describe('ws_brief 返回的 note_hash；笔记已被改动时返回 conflict'),
})
export type BriefUpdateInput = z.infer<typeof briefUpdateInput>

export const briefUpdateOp = defineOperation({
  name: 'brief_update',
  cli: 'brief update',
  summary: '经中枢整体替换本 workspace 的简报笔记（带 base_hash）',
  input: briefUpdateInput,
  positional: ['workspace', 'text'],
  fileInput: true,
  run: async (input: BriefUpdateInput, ctx) => {
    if (!(BRIEF_WRITERS as readonly string[]).includes(ctx.actor)) {
      return fail(
        'failure',
        'role_not_allowed',
        `只有 supervisor 与 user 能更新简报笔记，当前为 ${ctx.actor}`,
      )
    }
    const workspace = input.workspace.startsWith('ws/') ? input.workspace : `ws/${input.workspace}`
    return new HubClient(ctx).updateBrief({
      workspace,
      text: input.text,
      base_hash: input.base_hash,
    })
  },
  human: (o) =>
    o.changed
      ? `已更新简报笔记：${o.file}（hash ${o.hash}）`
      : `简报笔记没有变化：${o.file}（hash ${o.hash}）`,
})
