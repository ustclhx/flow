import { z } from 'zod'

/**
 * 适配器的交互能力（D1）；与派送匹配用的 `executor:<type>` 等字符串标签无关。
 * resume_session 指进程结束后仍能继续同一个 harness 会话，重新挂接存活终端不算恢复。
 * raindown_mcp 指具有任务绑定且可调用 raindown_report，仅加载知识库 MCP 不算。
 */
export const adapterCapabilities = z
  .object({
    approval_requests: z.enum(['structured', 'inferred', 'none']),
    inject_while_running: z.boolean(),
    resume_session: z.boolean().meta({ description: '进程结束后仍能继续同一个 harness 会话' }),
    raindown_mcp: z.boolean(),
    out_of_band_detection: z.boolean(),
  })
  .meta({ title: 'Adapter capabilities' })
export type AdapterCapabilities = z.infer<typeof adapterCapabilities>

/** 旧节点未上报能力时采用保守缺省；不按执行器类型推断。 */
export const NO_ADAPTER_CAPABILITIES: Readonly<AdapterCapabilities> = Object.freeze({
  approval_requests: 'none',
  inject_while_running: false,
  resume_session: false,
  raindown_mcp: false,
  out_of_band_detection: false,
})

/** 读取旧账本或新版本投影时，剥离未知键；不认识或缺少的字段逐项退回保守值。 */
export const readAdapterCapabilities = z
  .object({
    approval_requests: adapterCapabilities.shape.approval_requests.catch(
      NO_ADAPTER_CAPABILITIES.approval_requests,
    ),
    inject_while_running: z.boolean().catch(NO_ADAPTER_CAPABILITIES.inject_while_running),
    resume_session: z.boolean().catch(NO_ADAPTER_CAPABILITIES.resume_session),
    raindown_mcp: z.boolean().catch(NO_ADAPTER_CAPABILITIES.raindown_mcp),
    out_of_band_detection: z.boolean().catch(NO_ADAPTER_CAPABILITIES.out_of_band_detection),
  })
  .catch({ ...NO_ADAPTER_CAPABILITIES })
