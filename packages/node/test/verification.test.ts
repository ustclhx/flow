import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TAIL_LINE_MAX, TAIL_TOTAL_MAX_BYTES, taskContract } from '@flow/core'
import { type Bench, bench, fake } from './harness.ts'

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

async function open(...args: Parameters<typeof bench>) {
  current = await bench(...args)
  mkdirSync(join(current.home, 'work'), { recursive: true })
  return current
}

function command(b: Bench, name: string, source: string, ...args: string[]) {
  const path = join(b.home, `${name}.cjs`)
  writeFileSync(path, source)
  return [process.execPath, path, ...args]
}

const create = (b: Bench, verify: NonNullable<Parameters<Bench['create']>[0]>['verify']) =>
  b.create({ ...fake({ delay_ms: 0 }), cwd: join(b.home, 'work'), verify })

/** 真子进程启动与文件 I/O 用事件循环等待，虚拟时钟只由测试显式推进。 */
async function waitFor(b: Bench, pred: () => boolean) {
  const deadline = Date.now() + 5000
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('等待子进程或任务状态超时')
    await b.clock.advance(0)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const finished = (b: Bench, id: string) =>
  waitFor(b, () => ['done', 'failed', 'blocked', 'cancelled'].includes(b.task(id).status))

function assertDead(pid: number) {
  // Linux 的孤儿进程可能短暂成为 zombie；它已经终止，不再占有管道或执行脚本。
  if (process.platform === 'linux' && existsSync(`/proc/${pid}/stat`)) {
    let stat: string
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    expect(stat.split(') ')[1]?.startsWith('Z')).toBe(true)
  } else {
    expect(() => process.kill(pid, 0)).toThrow()
  }
}

/** 父子进程都忽略 SIGTERM，子进程继承管道；只杀父进程时 close 不会触发。 */
function hangingGroup(b: Bench) {
  const ready = join(b.home, 'ready.json')
  const cmd = command(
    b,
    'hanging',
    `const {spawn} = require('node:child_process');
     const {writeFileSync} = require('node:fs');
     process.on('SIGTERM', () => {});
     const child = spawn(process.execPath, ['-e',
       "process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000)"],
       {stdio:['ignore','inherit','inherit','ipc']});
     child.on('message', () => writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.pid,child.pid])));
     setInterval(()=>{},1000);`,
  )
  return { ready, cmd }
}

test('测试失败：保存退出码和合并输出，失败即停，第二条命令确实未执行', async () => {
  const b = await open()
  const marker = join(b.home, 'must-not-exist')
  const first = command(
    b,
    'fail',
    "process.stdout.write('测试失败\\n'); process.stderr.write('错误细节\\n'); process.exitCode=7",
  )
  const second = command(
    b,
    'skipped',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
  )
  const id = await create(b, [{ cmd: first }, { cmd: second }])
  await finished(b, id)
  expect(b.task(id)).toMatchObject({ status: 'failed', result: { reason: 'verify_failed' } })
  expect(b.task(id).result?.verify).toHaveLength(1)
  expect(b.task(id).result?.verify[0]).toMatchObject({ cmd: first, exit_code: 7, timed_out: false })
  expect(b.task(id).result?.verify[0]?.output_tail.join('\n')).toContain('测试失败')
  expect(b.task(id).result?.verify[0]?.output_tail.join('\n')).toContain('错误细节')
  expect(existsSync(marker)).toBe(false)
  expect(b.types(id)).toEqual([
    'task.created',
    'task.started',
    'lease.granted',
    'task.verifying',
    'task.failed',
  ])
})

test('输出里有疑似密钥：跨分块输出脱敏、尾部行数/单行长度/总字节数受限', async () => {
  const b = await open()
  const secret = ['sk', '-', 'A'.repeat(36)].join('')
  const cmd = command(
    b,
    'secret',
    `
    process.stdout.write('丢弃的第一行\\n' + 'x\\n'.repeat(240));
    process.stdout.write('长'.repeat(3000)+'\\n');
    const key = ['sk','-','A'.repeat(36)].join('');
    process.stdout.write(key.slice(0, 8));
    setImmediate(() => process.stdout.write(key.slice(8)+'\\n'));
    process.stderr.write('stderr\\n');`,
  )
  const id = await create(b, [{ cmd }])
  await finished(b, id)
  expect(b.task(id).status).toBe('done')
  const tail = b.task(id).result?.verify[0]?.output_tail ?? []
  expect(tail.length).toBeLessThanOrEqual(200)
  expect(tail.every((l) => l.length <= TAIL_LINE_MAX)).toBe(true)
  expect(Buffer.byteLength(tail.join('\n'))).toBeLessThanOrEqual(TAIL_TOTAL_MAX_BYTES)
  expect(tail.join('\n')).not.toContain('丢弃的第一行')
  expect(tail.join('\n')).toContain('stderr')
  expect(tail.join('\n')).toContain('[REDACTED:api-key]')
  expect(JSON.stringify(b.events(id))).not.toContain(secret)
  expect(JSON.stringify(b.task(id).result)).not.toContain(secret)
})

test('全部通过：顺序执行，使用任务 cwd，argv 中的 shell 元字符按字面量传递', async () => {
  const b = await open()
  const cwd = join(b.home, 'work')
  mkdirSync(join(cwd, 'x'))
  writeFileSync(join(cwd, 'x', 'keep'), '保留')
  const first = command(
    b,
    'literal',
    `
    const fs = require('node:fs');
    if (process.argv[2] !== '; rm -rf x') process.exit(8);
    fs.writeFileSync('first', process.argv[2]);
    console.log(process.cwd()); console.log(process.argv[2]);`,
    '; rm -rf x',
  )
  const second = command(
    b,
    'order',
    "if (!require('node:fs').existsSync('first')) process.exit(9); console.log('第二条通过')",
  )
  const id = await create(b, [{ cmd: first }, { cmd: second }])
  await finished(b, id)
  expect(b.task(id).status).toBe('done')
  expect(b.task(id).result?.summary).toBe('fake 执行完成')
  expect(b.task(id).result?.verify.map((v) => v.exit_code)).toEqual([0, 0])
  expect(b.task(id).result?.verify[0]).toMatchObject({ cmd: first, cwd, timed_out: false })
  expect(b.task(id).result?.verify[0]?.duration_ms).toBeGreaterThanOrEqual(0)
  expect(b.task(id).result?.verify[0]?.output_tail).toContain(realpathSync(cwd))
  expect(b.task(id).result?.verify[0]?.output_tail).toContain('; rm -rf x')
  expect(existsSync(join(cwd, 'x', 'keep'))).toBe(true)
  expect(b.types(id).filter((t) => t === 'task.verifying')).toHaveLength(1)
})

test('命令超时：合同覆盖超时，杀掉整个进程组，后续命令不运行', async () => {
  const b = await open()
  const { ready, cmd } = hangingGroup(b)
  const marker = join(b.home, 'skipped')
  const id = await create(b, [
    { cmd, timeout_s: 2 },
    {
      cmd: command(
        b,
        'skip-timeout',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ),
    },
  ])
  await waitFor(b, () => existsSync(ready))
  const pids = JSON.parse(readFileSync(ready, 'utf8')) as number[]
  expect(b.task(id).status).toBe('verifying')
  await b.clock.advance(1999)
  expect(b.task(id).status).toBe('verifying')
  await b.clock.advance(1)
  await finished(b, id)
  expect(b.task(id)).toMatchObject({ status: 'failed', result: { reason: 'verify_failed' } })
  expect(b.task(id).result?.verify).toHaveLength(1)
  expect(b.task(id).result?.verify[0]).toMatchObject({
    timed_out: true,
    exit_code: null,
    duration_ms: 2000,
  })
  expect(existsSync(marker)).toBe(false)
  pids.forEach(assertDead)
})

test('默认每条命令 10 分钟，verifying 期间持续续约，不受执行器超时或无进展计时影响', async () => {
  const b = await open({}, 3)
  const { ready, cmd } = hangingGroup(b)
  const id = await b.create({
    ...fake({ delay_ms: 0 }),
    verify: [{ cmd }],
    timeout_s: 1,
    no_progress_minutes: 0.01,
  })
  await waitFor(b, () => existsSync(ready))
  const expiresAt = b.task(id).lease?.expires_at
  await b.clock.advance(599_999)
  expect(b.task(id).status).toBe('verifying')
  expect(b.sweep()).toBe(0)
  expect(b.task(id).lease?.expires_at).not.toBe(expiresAt)
  await b.clock.advance(1)
  await finished(b, id)
  expect(b.task(id).result?.verify[0]).toMatchObject({ timed_out: true, duration_ms: 600_000 })
})

test('验收中取消：杀掉命令及子进程，保存已执行命令，任务 cancelled', async () => {
  const b = await open({}, 3)
  const { ready, cmd } = hangingGroup(b)
  const marker = join(b.home, 'cancel-skipped')
  const id = await create(b, [
    { cmd },
    {
      cmd: command(
        b,
        'skip-cancel',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ),
    },
  ])
  await waitFor(b, () => existsSync(ready))
  const pids = JSON.parse(readFileSync(ready, 'utf8')) as number[]
  await b.api('POST', `/v1/tasks/${id}/cancel`, {})
  await b.clock.advance(1000)
  await finished(b, id)
  expect(b.task(id).status).toBe('cancelled')
  expect(b.task(id).result?.verify).toHaveLength(1)
  expect(b.task(id).result?.verify[0]).toMatchObject({ cmd, exit_code: null, timed_out: false })
  expect(b.task(id).result?.reason).toBeUndefined()
  expect(existsSync(marker)).toBe(false)
  pids.forEach(assertDead)
  expect(b.types(id).slice(-2)).toEqual(['task.cancel_requested', 'task.cancelled'])
  const result = b.task(id).result
  expect(b.ledger.rebuild().ok).toBe(true)
  expect(b.task(id)).toMatchObject({ status: 'cancelled', result })
})

test('阶段上报暂时失败：中枢确认 verifying 之前不启动验收，重试后执行', async () => {
  let rejecting = true
  const b = await open({}, 60, (url, init) => {
    if (rejecting && url.endsWith('/renew') && String(init?.body).includes('"phase":"verifying"')) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { kind: 'retryable', code: 'hub_busy', message: '稍后重试' },
        }),
        { status: 503 },
      )
    }
    return undefined
  })
  const marker = join(b.home, 'verified')
  const cmd = command(
    b,
    'after-ack',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
  )
  const id = await create(b, [{ cmd }])
  expect(b.task(id).status).toBe('running')
  expect(existsSync(marker)).toBe(false)
  rejecting = false
  await b.clock.advance(1000)
  await finished(b, id)
  expect(b.task(id).status).toBe('done')
  expect(existsSync(marker)).toBe(true)
  expect(b.types(id).filter((t) => t === 'task.verifying')).toHaveLength(1)
})

for (const outcome of ['failed', 'blocked'] as const) {
  test(`执行器报告 ${outcome} 时不运行验收`, async () => {
    const b = await open()
    const marker = join(b.home, 'not-run')
    const cmd = command(
      b,
      'must-skip',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    )
    const id = await b.create({
      ...fake({
        outcome,
        delay_ms: 0,
        ...(outcome === 'blocked' ? { blocked_reason: 'other' } : {}),
      }),
      verify: [{ cmd }],
    })
    await finished(b, id)
    expect(b.task(id).status).toBe(outcome)
    expect(existsSync(marker)).toBe(false)
    expect(b.types(id)).not.toContain('task.verifying')
  })
}

test('命令无法启动：记录诊断并以 verify_failed 结束', async () => {
  const b = await open()
  const id = await create(b, [{ cmd: [join(b.home, 'missing')] }])
  await finished(b, id)
  expect(b.task(id)).toMatchObject({ status: 'failed', result: { reason: 'verify_failed' } })
  expect(b.task(id).result?.verify[0]).toMatchObject({ exit_code: null, timed_out: false })
  expect(b.task(id).result?.verify[0]?.output_tail.join('')).toContain('ENOENT')
})

test('验收超时字段拒绝非正数', () => {
  expect(
    taskContract.safeParse({
      goal: '验收',
      workspace: 'ws/demo',
      role: 'dev',
      executor: 'fake',
      verify: [{ cmd: ['test'], timeout_s: 0 }],
    }).success,
  ).toBe(false)
})
