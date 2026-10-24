import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowPaths, initFlowHome } from '@flow/core'
import { createProposalWatcher, openLedger, type RunningHub, runHub } from '../src/index.ts'
import { must, tempLedger } from './ledger-helpers.ts'

/** 提案目录的监听与扫描（add-m1-inbox 3.1；inbox spec "条目来源""自动关闭"）。 */

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const clock = { now: Date.now, setTimeout: () => () => {} }

function proposal(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    created_at: '2026-10-24T08:00:00.000Z',
    actor: 'agent:claude',
    target: 'resources/domains/payments',
    base_hash: null,
    content: '---\ntype: domain\n---\n正文\n',
    reason: '补充支付领域',
    sources: [],
    ...over,
  }
}

const ID_A = '1761292800000-aaaaaaaaaaaa'
const ID_B = '1761292800001-bbbbbbbbbbbb'
const ID_C = '1761292800002-cccccccccccc'

async function setup() {
  const l = await tempLedger()
  const home = join(l.dir, 'home')
  const dir = join(flowPaths(home).state, 'proposals')
  mkdirSync(dir, { recursive: true })
  const put = (id: string, over: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(proposal(id, over))}\n`)
  const archive = (id: string, kind: 'accepted' | 'rejected') => {
    mkdirSync(join(dir, kind), { recursive: true })
    renameSync(join(dir, `${id}.json`), join(dir, kind, `${id}.json`))
  }
  const warnings: unknown[] = []
  const watcher = createProposalWatcher({
    ledger: l.store,
    home,
    clock,
    logger: { warn: (_m, d) => warnings.push(d) },
  })
  cleanups.push(() => {
    watcher.stop()
    l.cleanup()
  })
  return { ...l, home, dir, put, archive, watcher, warnings }
}

describe('提案 → 收件箱条目', () => {
  test('待确认提案生成 Decide 条目（接受、拒绝）；接受、拒绝、删除后分别关闭并注明原因', async () => {
    const { store, put, archive, watcher, dir } = await setup()
    put(ID_A)
    put(ID_B, { base_hash: 'ab'.repeat(32) })
    put(ID_C)
    await watcher.scan()
    const open = store.listInboxItems({ state: 'open' })
    expect(open.map((i) => i.id)).toEqual([`prop.${ID_A}`, `prop.${ID_B}`, `prop.${ID_C}`])
    expect(open[0]).toMatchObject({
      level: 'decide',
      source: 'proposal',
      source_ref: ID_A,
      workspace: null,
      task_id: null,
      actions: ['accept', 'reject'],
      title: '修改提案：resources/domains/payments',
    })
    expect(open[0]?.body).toContain('补充支付领域')
    expect(open[0]?.body).toContain('agent:claude')

    // 再扫一次不重复
    const seq = store.seq()
    await watcher.scan()
    expect(store.seq()).toBe(seq)

    archive(ID_A, 'accepted')
    archive(ID_B, 'rejected')
    rmSync(join(dir, `${ID_C}.json`))
    await watcher.scan()
    expect(store.listInboxItems({ state: 'open' })).toEqual([])
    const reasons = Object.fromEntries(
      store.listInboxItems({ state: 'closed' }).map((i) => [i.source_ref, i.closed?.reason]),
    )
    expect(reasons).toEqual({
      [ID_A]: 'proposal_accepted',
      [ID_B]: 'proposal_rejected',
      [ID_C]: 'proposal_removed',
    })
  })

  test('被忽略的提案条目不会因为再次扫描而重新打开；不合法的提案文件跳过并告警', async () => {
    const { store, put, watcher, dir, warnings } = await setup()
    put(ID_A)
    writeFileSync(join(dir, `${ID_B}.json`), '{"id": "坏的"')
    writeFileSync(join(dir, `${ID_C}.json.abc123.tmp`), 'x')
    await watcher.scan()
    expect(store.listInboxItems().map((i) => i.id)).toEqual([`prop.${ID_A}`])
    expect(warnings).toHaveLength(1)
    must(
      store.append(
        { type: 'inbox.item_closed', payload: { item_id: `prop.${ID_A}`, reason: 'dismissed' } },
        { actor: 'user' },
      ),
    )
    const seq = store.seq()
    await watcher.scan()
    await watcher.scan()
    expect(store.seq()).toBe(seq)
    expect(warnings).toHaveLength(1)
  })

  test('提案文件读取或解析失败：已有条目保持 open，告警一次；文件恢复后照常，确认移走后才关闭（审查第 2 条）', async () => {
    const { store, put, watcher, dir, warnings } = await setup()
    put(ID_A)
    put(ID_B)
    await watcher.scan()
    expect(store.listInboxItems({ state: 'open' })).toHaveLength(2)
    const seq = store.seq()
    // A：JSON 损坏；B：JSON 合法但不符合 schema
    writeFileSync(join(dir, `${ID_A}.json`), '{"id": ')
    writeFileSync(join(dir, `${ID_B}.json`), JSON.stringify({ id: ID_B }))
    await watcher.scan()
    await watcher.scan()
    expect(store.seq()).toBe(seq)
    expect(store.listInboxItems({ state: 'open' }).map((i) => i.source_ref)).toEqual([ID_A, ID_B])
    expect(warnings).toHaveLength(2)
    // 恢复正常：不重复开条目
    put(ID_A)
    await watcher.scan()
    expect(store.seq()).toBe(seq)
    // 确认已不在待处理目录后才关闭
    rmSync(join(dir, `${ID_A}.json`))
    rmSync(join(dir, `${ID_B}.json`))
    await watcher.scan()
    expect(store.listInboxItems({ state: 'open' })).toEqual([])
    expect(store.listInboxItems({ state: 'closed' }).map((i) => i.closed?.reason)).toEqual([
      'proposal_removed',
      'proposal_removed',
    ])
  })

  test('扫描读完目录后提案才被接受：开条目前再确认文件仍在，不为已处理的提案开条目（审查第 3 条）', async () => {
    const { store, put, archive, home } = await setup()
    put(ID_A)
    put(ID_B)
    // 在"读完目录"与"写入条目"之间接受 A：getInboxItem 是写入前的最后一次查询
    let moved = false
    const racing = {
      ...store,
      getInboxItem(id: string) {
        if (!moved && id === `prop.${ID_A}`) {
          moved = true
          archive(ID_A, 'accepted')
        }
        return store.getInboxItem(id)
      },
    } as typeof store
    const w = createProposalWatcher({ ledger: racing, home, clock })
    cleanups.push(() => w.stop())
    await w.scan()
    expect(moved).toBe(true)
    expect(store.listInboxItems().map((i) => i.source_ref)).toEqual([ID_B])
    await w.scan()
    expect(store.listInboxItems().map((i) => i.source_ref)).toEqual([ID_B])
  })

  test('监听目录：新提案出现后自动生成条目', async () => {
    const { store, put, watcher } = await setup()
    await watcher.start()
    put(ID_A)
    const deadline = Date.now() + 5000
    while (store.listInboxItems().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(store.listInboxItems().map((i) => i.id)).toEqual([`prop.${ID_A}`])
  })
})

describe('runHub 挂载收件箱', () => {
  test('启动时扫描已有提案；停机期间卡住的任务在重启后补开条目', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'flow-inbox-hub-')), 'home')
    cleanups.push(() => rmSync(join(home, '..'), { recursive: true, force: true }))
    must(await initFlowHome(home))
    mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'workspaces', 'demo.yaml'),
      'id: demo\nkind: product\nname: Demo\ndescription: 测试\nrepos: []\n',
    )
    const dir = join(flowPaths(home).state, 'proposals')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ID_A}.json`), JSON.stringify(proposal(ID_A)))
    const quiet = { info() {}, warn() {}, error() {} }
    let hub: RunningHub | undefined
    cleanups.push(async () => {
      await hub?.stop()
    })
    hub = must(await runHub({ home, port: 0, logger: quiet as never, inbox: { watch: false } }))
    await hub.stop()
    hub = undefined

    // 停机期间直接在账本里制造一个卡住的任务（模拟中枢崩溃前最后写入的事件）
    const ledger = await openLedger(flowPaths(home).ledgerDb)
    expect(ledger.listInboxItems().map((i) => i.id)).toEqual([`prop.${ID_A}`])
    const base = { task_id: 't-1', workspace: 'ws/demo' }
    must(
      ledger.append(
        {
          ...base,
          type: 'task.created',
          payload: {
            contract: { goal: '修复', workspace: 'ws/demo', role: 'developer', executor: 'fake' },
          },
        },
        { actor: 'user' },
      ),
    )
    must(
      ledger.appendMany(
        [
          { ...base, type: 'task.started', payload: { node_id: 'n1', lease_id: 'l1', attempt: 1 } },
          { ...base, type: 'task.blocked', payload: { reason: 'question', message: '？' } },
        ],
        { actor: 'node:n1' },
      ),
    )
    ledger.close()

    hub = must(await runHub({ home, port: 0, logger: quiet as never, inbox: { watch: false } }))
    await hub.stop()
    hub = undefined
    const after = await openLedger(flowPaths(home).ledgerDb)
    cleanups.push(() => after.close())
    expect(after.listInboxItems({ state: 'open' }).map((i) => [i.source, i.level])).toEqual([
      ['task', 'interrupt'],
      ['proposal', 'decide'],
    ])
  })
})
