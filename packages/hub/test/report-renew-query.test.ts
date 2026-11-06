import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { fail } from '@raindown/core'
import type { LedgerStore } from '../src/ledger/store.ts'
import { createNodeService } from '../src/nodes/service.ts'
import { createTaskTokenAuthority } from '../src/server/lease-tokens.ts'
import { drafts, must, sys, tempLedger, WS } from './ledger-helpers.ts'

test('上报的续约投递、消费与派工收尾不扫描任务全部历史', async () => {
  const fixture = await tempLedger()
  const ledger = fixture.store
  const service = createNodeService({ ledger, leaseTtlS: 60, leaseWaitMaxS: 0 })
  try {
    must(ledger.append(drafts('t-query')['task.created'], sys))
    must(
      service.registerNode(
        { node_id: 'n1', hostname: 'test', version: '1', capabilities: ['executor:fake'] },
        'user',
      ),
    )
    const lease = must(
      await service.acquire(
        { node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 },
        { actor: 'user' },
      ),
    ).lease
    if (!lease) throw new Error('未派工')
    const report = must(
      ledger.append(
        {
          type: 'task.reported',
          task_id: lease.task_id,
          workspace: WS,
          payload: {
            status: 'progress',
            summary: '已核对',
            attempt: lease.attempt,
            lease_id: lease.lease_id,
          },
        },
        { actor: 'developer' },
      ),
    )
    ledger.taskEvents = () => {
      throw new Error('上报热路径不得扫描全部事件')
    }
    expect(
      must(service.renew(lease.lease_id, { lease_token: lease.lease_token })).report?.seq,
    ).toBe(report.seq)
    expect(
      must(
        service.renew(lease.lease_id, { lease_token: lease.lease_token, report_seq: report.seq }),
      ).report,
    ).toBeUndefined()
    expect(
      must(
        service.complete(lease.lease_id, {
          lease_token: lease.lease_token,
          outcome: 'done',
          result: { summary: '完成', executor: 'fake', node_id: 'n1' },
        }),
      ).task.status,
    ).toBe('done')
  } finally {
    service.close()
    fixture.cleanup()
  }
})

/** 同时准备待消费报告、待交付回复与重启后丢失的凭证记录。 */
async function pendingRenewal() {
  const fixture = await tempLedger()
  const ledger = fixture.store
  let authority = createTaskTokenAuthority({ ledger: () => ledger })
  let rejectFetched = false
  const guarded: LedgerStore = {
    ...ledger,
    append(draft, options) {
      return rejectFetched && draft.type === 'task.reply_fetched'
        ? fail('failure', 'write_failed', '模拟回复交付记录失败')
        : ledger.append(draft, options)
    },
  }
  const service = createNodeService({
    ledger: guarded,
    leaseTtlS: 60,
    leaseWaitMaxS: 0,
    issueTaskToken: (grant) => authority.issue(grant),
    renewTaskToken: (grant) => authority.ensure(grant),
  })
  must(ledger.append(drafts('t-renew-all')['task.created'], sys))
  must(
    service.registerNode(
      { node_id: 'n1', hostname: 'test', version: '1', capabilities: ['executor:fake'] },
      'user',
    ),
  )
  const lease = must(
    await service.acquire(
      { node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 },
      { actor: 'user' },
    ),
  ).lease
  if (!lease?.dispatch_token) throw new Error('未下发派工凭证')
  const report = must(
    ledger.append(
      {
        type: 'task.reported',
        task_id: lease.task_id,
        workspace: WS,
        payload: {
          status: 'progress',
          summary: '已完成核对',
          attempt: lease.attempt,
          lease_id: lease.lease_id,
        },
      },
      { actor: 'developer' },
    ),
  )
  must(
    service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      blocked: { reason: 'question', basis: 'reported', message: '请确认下一步' },
    }),
  )
  must(
    ledger.append(
      {
        type: 'task.replied',
        task_id: lease.task_id,
        workspace: WS,
        payload: { reply_id: 'r-renew-all', kind: 'text', text: '继续' },
      },
      { actor: 'user' },
    ),
  )
  authority = createTaskTokenAuthority({ ledger: () => ledger })
  return {
    ledger,
    service,
    lease,
    report,
    authority: () => authority,
    rejectFetched: (value: boolean) => {
      rejectFetched = value
    },
    renew: (token = lease.dispatch_token as string) =>
      service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        dispatch_token_sha256: createHash('sha256').update(token).digest('hex').slice(0, 16),
      }),
    close: () => {
      service.close()
      fixture.cleanup()
    },
  }
}

test('续约同时返回回复、补发凭证与待消费报告，回复交付事实只记录一次', async () => {
  const c = await pendingRenewal()
  try {
    const first = must(c.renew())
    expect(first.reply).toMatchObject({ reply_id: 'r-renew-all', text: '继续' })
    expect(first.report).toMatchObject({ seq: c.report.seq, status: 'progress' })
    expect(first.dispatch_token).toBeString()
    expect(c.authority().authenticate(c.lease.dispatch_token as string)).toBeNull()
    expect(c.authority().authenticate(first.dispatch_token as string)?.task_id).toBe(
      c.lease.task_id,
    )
    expect(c.ledger.getReply('r-renew-all')?.fetched_at).toBeString()
    const second = must(c.renew(first.dispatch_token))
    expect(second.reply).toEqual(first.reply)
    expect(second.report).toEqual(first.report)
    expect(second.dispatch_token).toBeUndefined()
    expect(
      c.ledger.taskEvents(c.lease.task_id).filter((event) => event.type === 'task.reply_fetched'),
    ).toHaveLength(1)
    must(c.ledger.rebuild())
    expect(must(c.renew()).reply).toEqual(first.reply)
    expect(must(c.renew()).report).toEqual(first.report)
  } finally {
    c.close()
  }
})

test('回复交付记录失败时不提前签发凭证，重试仍能取得新凭证与报告', async () => {
  const c = await pendingRenewal()
  try {
    c.rejectFetched(true)
    expect(c.renew()).toMatchObject({ ok: false, error: { code: 'write_failed' } })
    expect(c.authority().size()).toBe(0)
    expect(c.ledger.getReply('r-renew-all')?.fetched_at).toBeUndefined()
    c.rejectFetched(false)
    const renewed = must(c.renew())
    expect(renewed.dispatch_token).toBeString()
    expect(renewed.reply?.reply_id).toBe('r-renew-all')
    expect(renewed.report?.seq).toBe(c.report.seq)
    expect(c.authority().authenticate(renewed.dispatch_token as string)?.task_id).toBe(
      c.lease.task_id,
    )
  } finally {
    c.close()
  }
})

test('中枢重启后第一次续约响应丢失，旧凭证指纹重试仍能取得有效凭证', async () => {
  const c = await pendingRenewal()
  try {
    const lost = must(c.renew())
    const retried = must(c.renew())
    expect(retried.dispatch_token).toBeString()
    expect(retried.dispatch_token).not.toBe(lost.dispatch_token)
    expect(c.authority().authenticate(lost.dispatch_token as string)).toBeNull()
    expect(c.authority().authenticate(retried.dispatch_token as string)?.task_id).toBe(
      c.lease.task_id,
    )
    expect(must(c.renew(retried.dispatch_token)).dispatch_token).toBeUndefined()
  } finally {
    c.close()
  }
})
