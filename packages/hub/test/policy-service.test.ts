import { afterEach, expect, test } from 'bun:test'
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
import { createInboxReactor, type LedgerStore } from '../src/index.ts'
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
  return { store: ledger.store, clock, warnings, write, create, baseline, service }
}

function createTask(
  store: LedgerStore,
  id: string,
  status: TaskStatus,
  matchedRules: IndexedPolicyRule[] = [rule],
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
  startTask(store, id)
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

test('进行中的 approval 委托依赖规则删除后原子转交用户，收件箱恢复可处理条目', async () => {
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
      policy_version: policyVersion([]),
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

test('整批追加失败不发布策略变化或推进基线，重试补齐同一变化及任务通知', async () => {
  const { service, store, create, baseline, write } = await setup()
  must(await service.load())
  baseline(service, [rule])
  await service.stop()
  createTask(store, 't-running', 'running')
  let reject = true
  const failing = create({
    ...store,
    appendMany(events, options) {
      return reject && events.some((event) => event.type === 'policy.changed')
        ? fail('failure', 'write_failed', '模拟整批追加失败')
        : store.appendMany(events, options)
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
