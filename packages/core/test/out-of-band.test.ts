import { describe, expect, test } from 'bun:test'
import {
  blockedReason,
  defaultInboxLevel,
  outOfBandSignal,
  renewLeaseRequest,
} from '../src/index.ts'

describe('带外操作契约', () => {
  test('工作目录丢失是 Interrupt 原因；带外操作独立分级', () => {
    expect(blockedReason.parse('workdir_missing')).toBe('workdir_missing')
    expect(defaultInboxLevel({ source: 'task', reason: 'workdir_missing' })).toBe('interrupt')
    expect(defaultInboxLevel({ source: 'out_of_band' })).toBe('interrupt')
  })

  test('授权带外执行必须有命令与幂等 id，会话丢失可省略命令', () => {
    expect(outOfBandSignal.safeParse({ id: '1', kind: 'approval_outside_raindown' }).success).toBe(
      false,
    )
    expect(outOfBandSignal.safeParse({ id: '', kind: 'session_removed' }).success).toBe(false)
    expect(outOfBandSignal.safeParse({ id: '1', kind: 'unknown' }).success).toBe(false)
    expect(outOfBandSignal.parse({ id: '1', kind: 'session_removed' })).toEqual({
      id: '1',
      kind: 'session_removed',
    })
    const signal = {
      id: '2',
      kind: 'approval_outside_raindown' as const,
      command: 'git push',
      message: '已执行',
    }
    const request = { lease_token: 'x'.repeat(24), out_of_band: [signal] }
    expect(renewLeaseRequest.parse(request).out_of_band).toEqual([signal])
    expect(
      renewLeaseRequest.safeParse({ ...request, out_of_band: Array(101).fill(signal) }).success,
    ).toBe(false)
  })
})
