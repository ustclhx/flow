import { z } from 'zod'

/** 适配器的交互能力（D1）；与派送匹配用的 `executor:<type>` 等字符串标签无关。 */
export const adapterCapabilities = z
  .strictObject({
    approval_requests: z.enum(['structured', 'inferred', 'none']),
    inject_while_running: z.boolean(),
    resume_session: z.boolean(),
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
