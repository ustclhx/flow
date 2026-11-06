import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fail,
  type IndexedPolicyRule,
  policyRuleHash,
  policyVersion,
  raindownPaths,
  type TaskStatus,
} from '@raindown/core'
import { stringify } from 'yaml'
import { createInboxReactor, createNodeService, type LedgerStore } from '../src/index.ts'
import { auditRules, createPolicyService, type PolicyService } from '../src/policy/service.ts'
import { drafts, must, startTask, sys, tempLedger, WS } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const rule: IndexedPolicyRule = {
  rule_index: 0,
  rule: { scope: WS, action: 'tool:Bash', level: 'supervisor' },
}
const otherRule: IndexedPolicyRule = {
  rule_index: 1,
  rule: { scope: WS, action: 'git.push', level: 'auto' },
}

async function setup(rules: IndexedPolicyRule[] = [rule]) {
  const ledger = await tempLedger()
  const home = join(ledger.dir, 'home')
  mkdirSync(join(home, 'config'), { recursive: true })
  const previousHome = process.env.RAINDOWN_HOME
  process.env.RAINDOWN_HOME = home
  cleanups.push(() => {
    if (previousHome === undefined) delete process.env.RAINDOWN_HOME
    else process.env.RAINDOWN_HOME = previousHome
    ledger.cleanup()
  })
  const clock = new FakeClock(Date.parse('2026-11-06T00:00:00Z'))
  const warnings: unknown[] = []
  let stamp = clock.now()
  const write = (input: unknown[], comment = '') => {
    const path = raindownPaths(home).policiesConfig
    writeFileSync(path, `${comment}${stringify(input)}`)
    // 显式推进文件时间，避免文件系统时间精度令快速连续写入不可见。
    stamp += 1000
    utimesSync(path, stamp / 1000, stamp / 1000)
  }
  write(rules.map((entry) => entry.rule))
  const create = (store: LedgerStore = ledger.store) => {
    const service = createPolicyService({
      home,
      ledger: store,
      clock,
      logger: { warn: (_message, detail) => warnings.push(detail) },
    })
    cleanups.push(() => service.stop())
    return service
  }
  const baseline = (service: PolicyService, baselineRules: IndexedPolicyRule[]) =>
    must(
      ledger.store.append(
        {
          type: 'hub.started',
          payload: {
            version: 'test',
            pid: 1,
            runtime: 'bun',
            port: 1234,
            policy_version: service.version(),
            policy_rules: baselineRules.map(policyRuleHash),
          },
        },
        sys,
      ),
    )
  const service = create()
  return { home, store: ledger.store, clock, warnings, write, create, baseline, service }
}

function createTask(
  store: LedgerStore,
  id: string,
  status: TaskStatus,
  matchedRules: IndexedPolicyRule[] = [rule],
  leaseToken?: string,
) {
  const d = drafts(id)
  must(
    store.append(
      {
        ...d['task.created'],
        payload: {
          ...d['task.created'].payload,
          mandate: {
            created_by: 'user',
            origin: 'user',
            policy_version: policyVersion([rule, otherRule]),
            matched_rules: auditRules(matchedRules),
          },
        },
      },
      { actor: 'user' },
    ),
  )
  if (status === 'queued') return
  if (leaseToken) {
    must(
      store.appendMany(
        [
          d['task.started'],
          {
            ...d['lease.granted'],
            payload: {
              ...d['lease.granted'].payload,
              token_sha256: createHash('sha256').update(leaseToken).digest('hex'),
              expires_at: '2026-11-06T01:00:00.000Z',
            },
          },
        ],
        sys,
      ),
    )
  } else startTask(store, id)
  if (status === 'blocked') must(store.append(d['task.blocked'], { actor: 'node:n1' }))
  if (status === 'verifying') must(store.append(d['task.verifying'], { actor: 'node:n1' }))
  if (status === 'done') must(store.append(d['task.done'], { actor: 'node:n1' }))
}

const changes = (store: LedgerStore) =>
  store.eventsAfter(0, undefined, 10_000).filter((event) => event.type === 'policy.changed')

test('首次加载只建立基线，启动和停止幂等；没有策略判定也每 60 秒按 mtime 检测变化', async () => {
  const { store, service, clock, write, warnings } = await setup()
  const initial = must(await service.load())
  expect(initial.version).toBe(policyVersion([rule]))
  expect(changes(store)).toEqual([])
  service.start()
  service.start()
  expect(clock.pending).toBe(1)
  write([otherRule.rule])
  await clock.advance(59_999)
  expect(changes(store)).toEqual([])
  await clock.advance(1)
  expect(changes(store)).toMatchObject([
    {
      actor: 'hub',
      payload: {
        from: initial.version,
        to: policyVersion([otherRule]),
        added: [policyRuleHash(otherRule)],
        removed: [policyRuleHash(rule)],
      },
    },
  ])
  expect(service.version()).toBe(policyVersion([otherRule]))
  await clock.advance(60_000)
  expect(changes(store)).toHaveLength(1)
  expect(warnings).toEqual([])
  await service.stop()
  expect(clock.pending).toBe(0)
})

test('重启从 hub.started 恢复基线，离线改动只记录一次；后续重启重放 policy.changed', async () => {
  const { store, service, baseline, create, write } = await setup()
  must(await service.load())
  baseline(service, [rule])
  await service.stop()
  write([otherRule.rule])
  const restarted = create()
  expect(restarted.version()).toBe(policyVersion([rule]))
  must(await restarted.load())
  expect(changes(store)).toMatchObject([
    {
      payload: { from: policyVersion([rule]), removed: [policyRuleHash(rule)] },
    },
  ])
  await restarted.stop()
  const next = create()
  expect(next.version()).toBe(policyVersion([otherRule]))
  must(await next.load())
  expect(changes(store)).toHaveLength(1)
})

test('仅改注释或无效规则不改变有效版本，保留有效规则索引变化也不通知', async () => {
  const { service, store, write, clock } = await setup()
  const version = must(await service.load()).version
  service.start()
  write([rule.rule], '# 修改说明\n')
  await clock.advance(60_000)
  write([{ scope: WS, action: 'git.push', level: 'invalid' }, rule.rule])
  await clock.advance(60_000)
  const loaded = must(await service.load())
  expect(loaded.errors).toHaveLength(1)
  expect(loaded.rules[0]?.rule_index).toBe(1)
  expect(loaded.version).toBe(version)
  expect(service.version()).toBe(version)
  expect(changes(store)).toEqual([])
})

test('并发主动加载串行比较有效版本，同一次变更只入账一次', async () => {
  const { service, store, write } = await setup()
  must(await service.load())
  write([])
  const results = await Promise.all([service.load(), service.load(), service.load()])
  expect(results.every((result) => result.ok)).toBe(true)
  expect(changes(store)).toHaveLength(1)
})

test('删除命中规则只通知 running、verifying、blocked 的受影响任务，不取消或通知其他任务', async () => {
  const { service, store, write } = await setup([rule, otherRule])
  must(await service.load())
  const statuses = ['running', 'verifying', 'blocked', 'queued', 'done'] as const
  for (const status of statuses) createTask(store, `t-${status}`, status)
  createTask(store, 't-unaffected', 'running', [otherRule])
  createTask(store, 't-no-rules', 'running', [])
  const seq = store.seq()
  write([otherRule.rule])
  must(await service.load())
  const events = store.eventsAfter(seq)
  expect(events.map((event) => event.type)).toEqual([
    'policy.changed',
    'task.policy_changed',
    'task.policy_changed',
    'task.policy_changed',
  ])
  expect(
    events
      .filter((event) => event.type === 'task.policy_changed')
      .map((event) => ({
        task_id: event.task_id,
        payload: event.payload,
      })),
  ).toEqual(
    ['running', 'verifying', 'blocked'].map((status) => ({
      task_id: `t-${status}`,
      payload: { policy_seq: seq + 1, rules: [policyRuleHash(rule)] },
    })),
  )
  for (const status of statuses) expect(store.getTask(`t-${status}`)?.status).toBe(status)
  expect(store.getTask('t-unaffected')?.status).toBe('running')
})

test('进行中的 approval 委托依赖规则删除后转交用户，收件箱恢复可处理条目', async () => {
  const { service, store, write } = await setup()
  must(await service.load())
  const reactor = createInboxReactor({ ledger: store })
  reactor.start()
  cleanups.push(() => reactor.stop())
  createTask(store, 't-approval', 'running', [])
  const base = { task_id: 't-approval', workspace: WS }
  const decision = must(
    store.append(
      {
        ...base,
        type: 'policy.decided',
        payload: {
          task_id: base.task_id,
          policy_version: service.version(),
          request: { tool: 'Bash', command: 'bun test', actions: ['tool:Bash'] },
          level: 'supervisor',
          matched_rules: auditRules([rule]),
          actions: [],
        },
      },
      { actor: 'policy' },
    ),
  )
  const blocked = must(
    store.append(
      {
        ...base,
        type: 'task.blocked',
        payload: {
          reason: 'awaiting_approval',
          message: '等待测试授权',
          lease_held: true,
          decision_id: decision.seq,
          request: { tool: 'Bash', command: 'bun test', reason: '运行测试' },
        },
      },
      { actor: 'node:n1' },
    ),
  )
  must(
    store.append(
      {
        ...base,
        type: 'task.reply_delegated',
        payload: {
          task_id: base.task_id,
          block_seq: blocked.seq,
          kind: 'awaiting_approval',
          decision_id: decision.seq,
          deadline: '2026-11-06T01:00:00Z',
        },
      },
      sys,
    ),
  )
  await reactor.idle()
  expect(store.getInboxItem(`blk.${blocked.seq}`)?.title).toContain('supervisor')
  expect(store.activeDelegation(base.task_id)).not.toBeNull()
  const seq = store.seq()
  write([])
  must(await service.load())
  await reactor.idle()
  const events = store.eventsAfter(seq).filter((event) => !event.type.startsWith('inbox.'))
  expect(events.map((event) => event.type)).toEqual([
    'policy.changed',
    'task.policy_changed',
    'task.reply_escalated',
  ])
  expect(events[2]).toMatchObject({
    task_id: base.task_id,
    payload: {
      block_seq: blocked.seq,
      reason: 'policy_changed',
      policy_version: policyVersion([rule]),
      to_version: policyVersion([]),
    },
  })
  expect(store.activeDelegation(base.task_id)).toBeNull()
  expect(store.getTask(base.task_id)?.status).toBe('blocked')
  expect(store.getInboxItem(`blk.${blocked.seq}`)).toMatchObject({
    state: 'open',
    actions: ['approve', 'deny', 'reply'],
  })
  expect(store.getInboxItem(`blk.${blocked.seq}`)?.title).not.toContain('supervisor')
  expect(store.getInboxItem(`blk.${blocked.seq}`)?.body).toContain('已转交给你')
  expect(store.listInboxItems({ state: 'open' }).some((item) => item.source === 'policy')).toBe(
    true,
  )
})

test('全局变化追加失败不推进基线，重试记录同一变化及任务通知', async () => {
  const { service, store, create, baseline, write } = await setup()
  must(await service.load())
  baseline(service, [rule])
  await service.stop()
  createTask(store, 't-running', 'running')
  let reject = true
  const failing = create({
    ...store,
    append(event, options) {
      return reject && event.type === 'policy.changed'
        ? fail('failure', 'write_failed', '模拟全局追加失败')
        : store.append(event, options)
    },
  })
  const seq = store.seq()
  write([])
  expect((await failing.load()).ok).toBe(false)
  expect(store.seq()).toBe(seq)
  expect(failing.version()).toBe(policyVersion([rule]))
  reject = false
  must(await failing.load())
  expect(store.eventsAfter(seq).map((event) => event.type)).toEqual([
    'policy.changed',
    'task.policy_changed',
  ])
  expect(failing.version()).toBe(policyVersion([]))
})

test('审查5：单个任务通知写入失败不会阻断策略加载或其他任务通知', async () => {
  const { store, service, create, baseline, write, warnings } = await setup()
  must(await service.load())
  baseline(service, [rule])
  await service.stop()
  createTask(store, 't-bad', 'running')
  createTask(store, 't-good', 'running')
  const failing = create({
    ...store,
    append(event, options) {
      return event.task_id === 't-bad'
        ? fail('failure', 'write_failed', '单个任务草稿失败')
        : store.append(event, options)
    },
    appendMany(events, options) {
      return events.some((event) => event.task_id === 't-bad')
        ? fail('failure', 'write_failed', '单个任务草稿失败')
        : store.appendMany(events, options)
    },
  })
  write([])
  const loaded = await failing.load()
  expect(loaded.ok).toBe(true)
  expect(failing.version()).toBe(policyVersion([]))
  expect(changes(store)).toHaveLength(1)
  expect(store.taskEvents('t-good').some((event) => event.type === 'task.policy_changed')).toBe(
    true,
  )
  expect(warnings).toEqual([expect.objectContaining({ task_id: 't-bad' })])
})

test('审查6：启动策略损坏，运行中建立基线落账，离线修改后重启仍能报告变化', async () => {
  const { home, store, service, write, create } = await setup()
  writeFileSync(raindownPaths(home).policiesConfig, '[broken yaml')
  expect((await service.load()).ok).toBe(false)
  must(
    store.append(
      {
        type: 'hub.started',
        payload: { version: 'test', pid: 1, runtime: 'bun', port: 1234 },
      },
      sys,
    ),
  )
  service.start()
  write([rule.rule])
  must(await service.load())
  expect(changes(store)).toMatchObject([
    {
      payload: {
        from: null,
        to: policyVersion([rule]),
        added: [policyRuleHash(rule)],
        removed: [],
      },
    },
  ])
  await service.stop()
  write([])
  const restarted = create()
  must(await restarted.load())
  expect(changes(store)).toHaveLength(2)
  expect(changes(store)[1]).toMatchObject({
    payload: { from: policyVersion([rule]), to: policyVersion([]) },
  })
})

test('审查7：恢复只读取最近策略启动基线之后的策略变化，不重放无关账本', async () => {
  const { store, service, baseline, create, write } = await setup()
  for (let i = 0; i < 20; i++)
    must(store.append({ type: 'hub.resumed', payload: { slept_ms: i, extended_leases: 0 } }, sys))
  must(await service.load())
  const start = baseline(service, [rule])
  write([otherRule.rule])
  must(await service.load())
  await service.stop()
  const reads: { after: number; type: string }[] = []
  const restarted = create({
    ...store,
    eventsAfter() {
      throw new Error('恢复不应读取完整账本')
    },
    eventsBetween(type, from, to, limit, after = 0) {
      reads.push({ after, type })
      return store.eventsBetween(type, from, to, limit, after)
    },
  })
  expect(restarted.version()).toBe(policyVersion([otherRule]))
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.every((read) => read.type === 'policy.changed' && read.after >= start.seq)).toBe(
    true,
  )
})

function delegateApproval(store: LedgerStore, id: string, version: string, leaseToken?: string) {
  createTask(store, id, 'running', [], leaseToken)
  const base = { task_id: id, workspace: WS }
  const decision = must(
    store.append(
      {
        ...base,
        type: 'policy.decided',
        payload: {
          task_id: id,
          policy_version: version,
          request: { tool: 'Bash', command: 'bun test', actions: ['tool:Bash'] },
          level: 'supervisor',
          matched_rules: auditRules([rule]),
          actions: [],
        },
      },
      { actor: 'policy' },
    ),
  )
  const blocked = must(
    store.append(
      {
        ...base,
        type: 'task.blocked',
        payload: {
          reason: 'awaiting_approval',
          message: '等待测试授权',
          lease_held: true,
          decision_id: decision.seq,
          request: { tool: 'Bash', command: 'bun test', reason: '测试' },
        },
      },
      { actor: 'node:n1' },
    ),
  )
  must(
    store.append(
      {
        ...base,
        type: 'task.reply_delegated',
        payload: {
          task_id: id,
          block_seq: blocked.seq,
          kind: 'awaiting_approval',
          decision_id: decision.seq,
          policy_version: version,
          deadline: '2026-11-06T01:00:00Z',
        },
      },
      sys,
    ),
  )
  return { ...base, block_seq: blocked.seq }
}

test('审查2：新增同范围更保守规则，即使原规则未删除也结束已有代批', async () => {
  const { store, service, write } = await setup()
  must(await service.load())
  const base = delegateApproval(store, 't-stricter', service.version())
  write([rule.rule, { ...rule.rule, level: 'draft-approve' }])
  const loaded = must(await service.load())
  expect(store.activeDelegation(base.task_id)).toBeNull()
  expect(store.taskEvents(base.task_id).at(-1)).toMatchObject({
    type: 'task.reply_escalated',
    payload: {
      reason: 'policy_changed',
      policy_version: policyVersion([rule]),
      to_version: loaded.version,
    },
  })
  expect(store.taskEvents(base.task_id).some((event) => event.type === 'task.policy_changed')).toBe(
    true,
  )
})

test('审查3：待送达的supervisor批准因规则删除或新增限制被撤回，保持卡住并转交用户', async () => {
  for (const change of ['removed', 'restricted']) {
    const { store, service, write } = await setup()
    must(await service.load())
    const base = delegateApproval(store, `t-pending-${change}`, service.version())
    const replyId = `r-${change}`
    must(
      store.append(
        {
          task_id: base.task_id,
          workspace: WS,
          type: 'task.replied',
          payload: {
            reply_id: replyId,
            kind: 'approve',
            via: 'supervisor',
            reason: '批准测试',
            policy_version: service.version(),
          },
        },
        { actor: 'supervisor' },
      ),
    )
    write(change === 'removed' ? [] : [rule.rule, { ...rule.rule, level: 'draft-approve' }])
    const loaded = must(await service.load())
    expect(store.getReply(replyId)?.state).toBe('dropped')
    expect(store.pendingReply(base.task_id)).toBeNull()
    expect(store.activeDelegation(base.task_id)).toBeNull()
    expect(store.getTask(base.task_id)?.status).toBe('blocked')
    expect(store.taskEvents(base.task_id).at(-1)).toMatchObject({
      type: 'task.reply_escalated',
      payload: {
        reason: 'policy_changed',
        dropped_reply_id: replyId,
        policy_version: policyVersion([rule]),
        to_version: loaded.version,
      },
    })
  }
})

async function pendingApproval(id: string) {
  const context = await setup()
  const { store, service, clock } = context
  must(await service.load())
  const token = 'test-policy-approval-lease-token-0001'
  const base = delegateApproval(store, id, service.version(), token)
  const replyId = `r-${id}`
  must(
    store.append(
      {
        type: 'task.replied',
        task_id: id,
        workspace: WS,
        payload: {
          reply_id: replyId,
          kind: 'approve',
          via: 'supervisor',
          reason: '批准测试',
          policy_version: service.version(),
        },
      },
      { actor: 'supervisor' },
    ),
  )
  const nodes = (ledger: LedgerStore = store) => {
    const node = createNodeService({ ledger, clock, leaseTtlS: 60, leaseWaitMaxS: 0 })
    cleanups.push(() => node.close())
    return node
  }
  return {
    ...context,
    ...base,
    replyId,
    nodes,
    leaseId: `l-${id}-1`,
    leaseToken: token,
  }
}

test('批准经续约交给节点后持久记录交付边界，策略撤回保留pending且送达确认可恢复运行', async () => {
  const c = await pendingApproval('t-fetched')
  const node = c.nodes()
  const reactor = createInboxReactor({ ledger: c.store })
  reactor.start()
  cleanups.push(() => reactor.stop())
  const renew = () => must(node.renew(c.leaseId, { lease_token: c.leaseToken }))
  expect(renew().reply).toMatchObject({ reply_id: c.replyId, block_seq: c.block_seq })
  expect(renew().reply?.reply_id).toBe(c.replyId)
  const fetched = c.store
    .taskEvents(c.task_id)
    .filter((event) => event.type === 'task.reply_fetched')
  expect(fetched).toHaveLength(1)
  expect(fetched[0]).toMatchObject({
    actor: 'hub',
    payload: { reply_id: c.replyId, lease_id: c.leaseId },
  })
  expect(c.store.getReply(c.replyId)).toMatchObject({
    state: 'pending',
    fetched_at: fetched[0]?.ts,
  })
  must(c.store.rebuild())
  expect(c.store.getReply(c.replyId)).toMatchObject({ fetched_at: fetched[0]?.ts })
  expect(renew().reply?.reply_id).toBe(c.replyId)
  expect(
    c.store.taskEvents(c.task_id).filter((event) => event.type === 'task.reply_fetched'),
  ).toHaveLength(1)

  c.write([])
  must(await c.service.load())
  await reactor.idle()
  expect(c.store.getReply(c.replyId)?.state).toBe('pending')
  expect(c.store.pendingReply(c.task_id)?.id).toBe(c.replyId)
  expect(c.store.activeDelegation(c.task_id)).toBeNull()
  const taskEvents = c.store.taskEvents(c.task_id)
  expect(taskEvents.findLast((event) => event.type === 'task.policy_changed')).toMatchObject({
    payload: { note: expect.stringContaining('批准在撤回生效前已交给节点') },
  })
  const escalation = taskEvents.findLast((event) => event.type === 'task.reply_escalated')
  expect(escalation).toMatchObject({
    payload: {
      reason: 'policy_changed',
      note: expect.stringContaining('批准在撤回生效前已交给节点'),
    },
  })
  expect(escalation?.payload).not.toHaveProperty('dropped_reply_id')
  const notifications = c.store.listInboxItems({ state: 'open' })
  expect(notifications.find((item) => item.source === 'policy')?.body).toContain(
    '批准在撤回生效前已交给节点',
  )
  expect(c.store.getInboxItem(`blk.${c.block_seq}`)?.body).toContain('批准在撤回生效前已交给节点')
  const delivered = must(
    node.ackReply(c.leaseId, {
      lease_token: c.leaseToken,
      reply_id: c.replyId,
      outcome: 'delivered',
    }),
  )
  expect(delivered.task.status).toBe('running')
  expect(c.store.getReply(c.replyId)?.state).toBe('delivered')
  const seq = c.store.seq()
  must(
    node.ackReply(c.leaseId, {
      lease_token: c.leaseToken,
      reply_id: c.replyId,
      outcome: 'delivered',
    }),
  )
  expect(c.store.seq()).toBe(seq)
})

function legacyPolicyWithdraw(c: Awaited<ReturnType<typeof pendingApproval>>) {
  const changed = must(
    c.store.append(
      {
        type: 'policy.changed',
        payload: {
          from: c.service.version(),
          to: policyVersion([]),
          added: [],
          removed: [policyRuleHash(rule)],
        },
      },
      sys,
    ),
  )
  must(
    c.store.appendMany(
      [
        {
          type: 'task.policy_changed',
          task_id: c.task_id,
          workspace: WS,
          payload: { policy_seq: changed.seq, rules: [policyRuleHash(rule)] },
        },
        {
          type: 'task.reply_escalated',
          task_id: c.task_id,
          workspace: WS,
          payload: {
            reason: 'policy_changed',
            block_seq: c.block_seq,
            dropped_reply_id: c.replyId,
            policy_version: c.service.version(),
            to_version: policyVersion([]),
          },
        },
      ],
      sys,
    ),
  )
  expect(c.store.getReply(c.replyId)?.state).toBe('dropped')
}

test('旧版本策略撤回已丢弃批准时，当前回合的迟到delivered确认保留实际送达事实', async () => {
  const c = await pendingApproval('t-legacy-delivered')
  const node = c.nodes()
  legacyPolicyWithdraw(c)
  const delivered = must(
    node.ackReply(c.leaseId, {
      lease_token: c.leaseToken,
      reply_id: c.replyId,
      outcome: 'delivered',
    }),
  )
  expect(delivered.task.status).toBe('running')
  expect(c.store.getReply(c.replyId)?.state).toBe('delivered')
  expect(c.store.taskEvents(c.task_id).at(-1)).toMatchObject({
    type: 'task.unblocked',
    payload: {
      reply_id: c.replyId,
      note: expect.stringContaining('批准在撤回生效前已交给节点'),
    },
  })
})

test('旧策略撤回批准的迟到delivered确认不能解锁后来的新blocked回合', async () => {
  const c = await pendingApproval('t-legacy-stale-round')
  const node = c.nodes()
  legacyPolicyWithdraw(c)
  must(node.renew(c.leaseId, { lease_token: c.leaseToken, resumed: {} }))
  must(
    node.renew(c.leaseId, {
      lease_token: c.leaseToken,
      blocked: { request_id: 'next-round', reason: 'awaiting_approval', message: '新的待批请求' },
    }),
  )
  expect(
    node.ackReply(c.leaseId, {
      lease_token: c.leaseToken,
      reply_id: c.replyId,
      outcome: 'delivered',
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_transition' } })
  expect(c.store.getTask(c.task_id)).toMatchObject({
    status: 'blocked',
    blocked: { message: '新的待批请求' },
  })
  expect(c.store.getReply(c.replyId)?.state).toBe('dropped')
})

test('交付标记落账失败时续约不向节点回传批准，重试成功后才交付', async () => {
  const c = await pendingApproval('t-fetch-write-failed')
  let reject = true
  const node = c.nodes({
    ...c.store,
    append(event, options) {
      return reject && event.type === 'task.reply_fetched'
        ? fail('failure', 'write_failed', '模拟交付标记失败')
        : c.store.append(event, options)
    },
  })
  expect(node.renew(c.leaseId, { lease_token: c.leaseToken })).toMatchObject({
    ok: false,
    error: { code: 'write_failed' },
  })
  expect(
    c.store.taskEvents(c.task_id).filter((event) => event.type === 'task.reply_fetched'),
  ).toHaveLength(0)
  expect(c.store.getReply(c.replyId)?.state).toBe('pending')
  reject = false
  expect(must(node.renew(c.leaseId, { lease_token: c.leaseToken })).reply?.reply_id).toBe(c.replyId)
})
