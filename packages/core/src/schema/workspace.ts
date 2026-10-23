import { z } from 'zod'
import { WORKSPACE_ID_RE } from './common.ts'

/** `config/workspaces/<id>.yaml` 的格式（resource-registry）。 */

const shared = {
  id: z
    .string()
    .regex(WORKSPACE_ID_RE, 'workspace id 只能包含小写字母、数字和连字符')
    .meta({ description: 'workspace id，与文件名一致；标识写作 ws/<id>' }),
  name: z.string().min(1).meta({ description: '显示名称' }),
  description: z.string().min(1).meta({ description: '一句话说明' }),
}

export const productWorkspace = z
  .looseObject({
    ...shared,
    kind: z.literal('product').meta({ description: '产品 workspace，可以拥有资源' }),
    repos: z.array(z.string().min(1)).meta({ description: '关联项目仓库的本地路径' }),
  })
  .meta({ title: 'product workspace' })

export const functionWorkspace = z
  .looseObject({
    ...shared,
    kind: z.literal('function').meta({ description: '职能 workspace，不能拥有资源' }),
    repos: z.array(z.string().min(1)).optional().meta({ description: '关联仓库的本地路径' }),
  })
  .meta({ title: 'function workspace' })

export const workspaceSchema = z
  .discriminatedUnion('kind', [productWorkspace, functionWorkspace])
  .meta({ title: 'Flow workspace', description: 'config/workspaces/<id>.yaml 的内容' })

export type WorkspaceConfig = z.infer<typeof workspaceSchema>
