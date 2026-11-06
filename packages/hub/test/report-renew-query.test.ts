import { expect, test } from 'bun:test'
import { createNodeService } from '../src/nodes/service.ts'
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
