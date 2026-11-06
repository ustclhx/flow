import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type InboxConfig, parseInboxConfig } from '@raindown/core'
import {
  createInboxReactor,
  type EventInput,
  type InboxReactor,
  type LedgerStore,
} from '../src/index.ts'
import { drafts, must, startTask, tempLedger, WS } from './ledger-helpers.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function setup(config: Pick<InboxConfig, 'levels'> = { levels: [] }) {
  const env = await tempLedger()
  const cursorPath = join(env.dir, 'state', 'inbox-reactor.json')
  const reactors: InboxReactor[] = []
  const reactor = (ledger = env.store) => {
    const r = createInboxReactor({ ledger, cursorPath, config: () => config })
    reactors.push(r)
    return r
  }
  cleanups.push(() => {
    for (const r of reactors) r.stop()
    env.cleanup()
  })
  return { ...env, reactor }
}

function blocked(store: LedgerStore, id: string) {
  must(store.append(drafts(id)['task.created'], { actor: 'user' }))
  startTask(store, id)
  must(
    store.append(
      {
        type: 'task.blocked',
        task_id: id,
        workspace: WS,
        payload: { reason: 'crashed', message: '执行器退出 137', lease_held: false },
      },
      { actor: 'node:n1' },
    ),
  )
}

function retry(store: LedgerStore, id: string, by: 'user' | 'supervisor') {
  const event = must(
    store.appendMany(
      [
        {
          task_id: id,
          workspace: WS,
          type: 'task.attempt_ended',
          payload: { attempt: store.getTask(id)?.attempt ?? 1, reason: 'retry' },
        },
        {
          task_id: id,
          workspace: WS,
          type: 'task.requeued',
          payload: {
            reason: 'manual',
            requested_by: by,
            retry_reason: '资源恢复后再试',
            note: '旧版本说明',
          },
        },
      ],
      { actor: by },
    ),
  )[1]
  if (!event) throw new Error('缺少重试事件')
  return event
}

describe('task_retry 收件箱通知', () => {
  test('user/supervisor 重试分别默认 digest/interrupt；正文保留上一派工事实与重试理由', async () => {
    const { store, reactor } = await setup()
    const r = reactor()
    r.start()
    for (const by of ['user', 'supervisor'] as const) {
      blocked(store, by)
      const event = retry(store, by, by)
      await r.idle()
      const item = store.getInboxItem(`retry.${event.seq}`)
      expect(item).toMatchObject({
        title: `任务 ${by} 被重试`,
        source: 'task_retry',
        source_ref: by,
        reason: by,
        level: by === 'user' ? 'digest' : 'interrupt',
        actions: [],
        state: 'open',
      })
      expect(item?.body).toContain('第 2 次派工：已重新排队')
      expect(item?.body).toContain(`发起者：${by}`)
      expect(item?.body).toContain('结束事实：retry')
      expect(item?.body).toContain('crashed')
      expect(item?.body).toContain('执行器退出 137')
      expect(item?.body).toContain('重试理由：资源恢复后再试')
      expect(item?.body).not.toContain('旧版本说明')
      const created = store
        .eventsAfter(event.seq, {}, 100)
        .find((e) => e.type === 'inbox.item_created' && e.payload.item_id === item?.id)
      expect(created?.payload).toMatchObject({ source_seq: event.seq })
    }
  })

  test('异步处理已开始并结束的新派工时，只展示源事件之前的失败事实；分级可覆盖', async () => {
    const config = must(
      parseInboxConfig({
        levels: [{ source: 'task_retry', reason: 'user', workspace: WS, level: 'decide' }],
      }),
    )
    const { store, reactor } = await setup(config)
    must(store.append(drafts('failed')['task.created'], { actor: 'user' }))
    startTask(store, 'failed')
    must(
      store.appendMany(
        [
          {
            type: 'task.attempt_ended',
            task_id: 'failed',
            workspace: WS,
            payload: { attempt: 1, reason: 'failed', last_report: '上次日志' },
          },
          {
            type: 'task.failed',
            task_id: 'failed',
            workspace: WS,
            payload: { result: { summary: '上次失败摘要', executor: 'fake', node_id: 'n1' } },
          },
        ],
        { actor: 'node:n1' },
      ),
    )
    const event = must(
      store.append(
        {
          type: 'task.requeued',
          task_id: 'failed',
          workspace: WS,
          payload: { reason: 'manual', requested_by: 'user', retry_reason: '修复依赖' },
        },
        { actor: 'user' },
      ),
    )
    startTask(store, 'failed', 2)
    must(
      store.append(
        {
          ...drafts('failed', { attempt: 2 })['task.failed'],
          payload: { message: '后续失败不能串入' },
        },
        { actor: 'node:n1' },
      ),
    )
    const r = reactor()
    r.start()
    await r.idle()
    const item = store.getInboxItem(`retry.${event.seq}`)
    expect(item?.level).toBe('decide')
    expect(item?.body).toContain('第 2 次派工：已重新排队')
    expect(item?.body).toContain('结束事实：failed')
    expect(item?.body).toContain('上次失败摘要')
    expect(item?.body).toContain('上次日志')
    expect(item?.body).not.toContain('后续失败不能串入')
    expect(item?.state).toBe('open')
  })

  test('旧账 user/supervisor manual 使用 note；hub manual 与租约过期不通知', async () => {
    const { store, reactor } = await setup()
    const events = []
    for (const by of ['user', 'supervisor', 'hub'] as const) {
      blocked(store, by)
      events.push(
        must(
          store.append(
            {
              ...drafts(by)['task.requeued:manual'],
              payload: { reason: 'manual', note: '历史重试说明' },
            },
            { actor: by },
          ),
        ),
      )
    }
    must(store.append(drafts('lease')['task.created'], { actor: 'user' }))
    startTask(store, 'lease')
    must(store.append(drafts('lease')['task.lease_expired'], { actor: 'hub' }))
    const expiry = must(
      store.append(drafts('lease')['task.requeued:lease_expired'], { actor: 'hub' }),
    )
    const r = reactor()
    r.start()
    await r.idle()
    for (const event of events.slice(0, 2)) {
      expect(store.getInboxItem(`retry.${event.seq}`)?.body).toContain('重试理由：历史重试说明')
    }
    expect(store.getInboxItem(`retry.${events[2]?.seq}`)).toBeNull()
    expect(store.getInboxItem(`retry.${expiry.seq}`)).toBeNull()
    expect(store.listInboxItems({ source: 'task_retry' })).toHaveLength(2)
  })

  test('重复处理、重启和投影重建幂等；已关闭的重试条目不重新打开', async () => {
    const { store, reactor } = await setup()
    blocked(store, 'idempotent')
    const event = retry(store, 'idempotent', 'user')
    const r = reactor()
    r.start()
    await r.idle()
    must(
      store.append(
        {
          type: 'inbox.item_closed',
          task_id: 'idempotent',
          workspace: WS,
          payload: { item_id: `retry.${event.seq}`, reason: 'dismissed', via: 'web' },
        },
        { actor: 'user' },
      ),
    )
    r.stop()
    const snapshot = store.snapshot({ includeSoft: false }).inbox_items
    const seq = store.seq()
    const fresh = reactor()
    fresh.handle(event)
    fresh.handle(event)
    fresh.start()
    fresh.reconcile()
    await fresh.idle()
    expect(store.seq()).toBe(seq)
    must(store.rebuild())
    await fresh.idle()
    expect(store.snapshot({ includeSoft: false }).inbox_items).toEqual(snapshot)
    expect(store.getInboxItem(`retry.${event.seq}`)?.state).toBe('closed')
  })

  test('写入失败游标推进后重启，扫描历史事件补齐通知', async () => {
    const { store, reactor } = await setup()
    blocked(store, 'recover')
    const broken = reactor({
      ...store,
      appendMany(input: readonly EventInput[], opts: { actor: string }) {
        if (
          input.some((e) => e.type === 'inbox.item_created' && e.payload.source === 'task_retry')
        ) {
          return {
            ok: false as const,
            error: { kind: 'failure' as const, code: 'internal_error', message: '模拟写入失败' },
          }
        }
        return store.appendMany(input, opts)
      },
    })
    broken.start()
    const event = retry(store, 'recover', 'supervisor')
    await broken.idle()
    expect(broken.processed()).toBeGreaterThanOrEqual(event.seq)
    expect(store.getInboxItem(`retry.${event.seq}`)).toBeNull()
    broken.stop()
    startTask(store, 'recover', 2)
    must(store.append(drafts('recover', { attempt: 2 })['task.done'], { actor: 'node:n1' }))
    const healed = reactor()
    healed.start()
    await healed.idle()
    expect(store.getInboxItem(`retry.${event.seq}`)).toMatchObject({
      level: 'interrupt',
      state: 'open',
    })
    expect(store.getInboxItem(`retry.${event.seq}`)?.body).toContain('执行器退出 137')
    expect(store.listInboxItems({ source: 'task_retry' })).toHaveLength(1)
  })
})
