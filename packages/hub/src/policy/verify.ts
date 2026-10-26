import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { decideVerifySteps, loadHubConfig, loadPoliciesConfig, ok } from '@flow/core'
import type { VerifyPolicyCheck } from '../ledger/tasks.ts'

/**
 * 基于 flow-home 的验收命令策略判定（add-m1-supervisor D5）：每次建任务都重新读取 `config/policies.yaml`，
 * 与 `POST /v1/policy/check` 一样按 flow-home 与中枢端口识别受保护动作。文件读取失败时返回失败（建任务被拒）。
 */
export function verifyPolicyFromHome(home: string): VerifyPolicyCheck {
  const flowHomes = (() => {
    try {
      return [...new Set([home, realpathSync(home)])]
    } catch {
      return [home]
    }
  })()
  return async (scope, steps) => {
    const loaded = await loadPoliciesConfig(home)
    if (!loaded.ok) return loaded
    const hubConfig = await loadHubConfig(home)
    const hubPorts = hubConfig.ok ? [hubConfig.data.port] : []
    return ok(
      decideVerifySteps(loaded.data.rules, scope, steps, {
        flowHomes,
        userHome: homedir(),
        hubPorts,
      }),
    )
  }
}
