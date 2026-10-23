import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowPaths, hubConfigSchema, openDatabase } from '@flow/core'
import {
  type BackupInfo,
  createHubApp,
  type HubFetch,
  type HubLogger,
  startMaintenance,
} from '../src/index.ts'
import type { LedgerMaintenance } from '../src/ledger/port.ts'
import { FakeClock } from './server-fixtures.ts'

let home: string
let previousHome: string | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'flow-hub-maintenance-'))
  previousHome = process.env.FLOW_HOME
  process.env.FLOW_HOME = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env.FLOW_HOME
  else process.env.FLOW_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

function logs() {
  const changed = new EventEmitter()
  const warnings: string[] = []
  const infos: unknown[] = []
  const logger: HubLogger = {
    info: (_message, details) => {
      infos.push(details)
      changed.emit('change')
    },
    warn: (message) => {
      warnings.push(message)
      changed.emit('change')
    },
  }
  return {
    warnings,
    infos,
    logger,
    waitFor(level: 'info' | 'warn', count: number) {
      return new Promise<void>((resolve) => {
        const check = () => {
          if ((level === 'info' ? infos : warnings).length >= count) {
            changed.off('change', check)
            resolve()
          }
        }
        changed.on('change', check)
        check()
      })
    },
  }
}

function fakeBackup(paths: string[]): LedgerMaintenance {
  return {
    backupTo: (path) => {
      paths.push(path)
      // 空快照用测试内存账本占位；真实 VACUUM INTO 的恢复另有集成验证。
      writeFileSync(path, '{}')
    },
    close: () => {},
  }
}

describe('外部心跳', () => {
  test('未配置时不发请求；失败仅警告，API 保持可用', async () => {
    const clock = new FakeClock(0)
    const log = logs()
    let requests = 0
    const request: HubFetch = async () => {
      requests++
      throw new Error('unreachable')
    }
    const disabled = startMaintenance({
      home,
      config: hubConfigSchema.parse({}),
      clock,
      fetch: request,
      logger: log.logger,
    })
    await clock.advance(300_000)
    expect(requests).toBe(0)
    await disabled.stop()
    const enabled = startMaintenance({
      home,
      config: hubConfigSchema.parse({
        heartbeat_url: 'https://example.invalid/ping',
        heartbeat_interval_s: 10,
      }),
      clock,
      fetch: request,
      logger: log.logger,
    })
    try {
      await clock.advance(30_000)
      await log.waitFor('warn', 3)
      expect(requests).toBe(3)
      expect((await createHubApp().request('/v1/health')).status).toBe(200)
    } finally {
      await enabled.stop()
    }
    expect(clock.pending).toBe(0)
  })

  test('10 秒超时取消 GET，stop 取消进行中的请求且不再发心跳', async () => {
    const clock = new FakeClock(0)
    const log = logs()
    const signals: AbortSignal[] = []
    const request: HubFetch = async (_url, init) => {
      expect(init?.method).toBe('GET')
      const signal = init?.signal as AbortSignal
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    const job = startMaintenance({
      home,
      config: hubConfigSchema.parse({
        heartbeat_url: 'https://example.invalid/ping',
        heartbeat_interval_s: 30,
      }),
      clock,
      fetch: request,
      logger: log.logger,
    })
    await clock.advance(30_000)
    expect(signals.length).toBe(1)
    await clock.advance(9_999)
    expect(signals[0]?.aborted).toBe(false)
    await clock.advance(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(log.warnings.length).toBe(1)
    await clock.advance(20_000)
    expect(signals.length).toBe(2)
    await job.stop()
    expect(signals[1]?.aborted).toBe(true)
    await clock.advance(300_000)
    expect(signals.length).toBe(2)
    expect(clock.pending).toBe(0)
  })

  test('HTTP 非成功状态记为警告', async () => {
    const clock = new FakeClock(0)
    const log = logs()
    const job = startMaintenance({
      home,
      config: hubConfigSchema.parse({
        heartbeat_url: 'https://example.invalid/ping',
        heartbeat_interval_s: 10,
      }),
      clock,
      logger: log.logger,
      fetch: async () => new Response('down', { status: 503 }),
    })
    try {
      await clock.advance(10_000)
      await log.waitFor('warn', 1)
    } finally {
      await job.stop()
    }
  })
})

describe('每日备份', () => {
  test('默认本地 03:30 触发，按文件时间保留最新份数，只删除备份文件', async () => {
    const clock = new FakeClock(new Date(2026, 9, 24, 3, 29, 59).getTime())
    const backups = flowPaths(home).backups
    await mkdir(backups, { recursive: true })
    await Promise.all(
      ['flow-20261022-033000.db', 'flow-20261023-033000.db', 'notes.txt'].map((name) =>
        writeFile(join(backups, name), 'test'),
      ),
    )
    const paths: string[] = []
    const done: BackupInfo[] = []
    const job = startMaintenance({
      home,
      config: hubConfigSchema.parse({ backup_keep: 2 }),
      clock,
      ledger: fakeBackup(paths),
      logger: logs().logger,
      onBackupDone: (info) => {
        done.push(info)
      },
    })
    try {
      expect(paths).toHaveLength(0)
      await clock.advance(1000)
      expect(done).toHaveLength(1)
      expect(done[0]).toEqual({
        path: 'state/backups/flow-20261024-033000.db',
        at: new Date(clock.now()).toISOString(),
        kept: 2,
        size_bytes: 2,
        duration_ms: 0,
        removed: expect.any(Array),
      })
      expect((await readdir(backups)).sort()).toEqual([
        'flow-20261023-033000.db',
        'flow-20261024-033000.db',
        'notes.txt',
      ])
      await clock.advance(86_400_000)
      expect(done).toHaveLength(2)
      expect(paths[1]).toEndWith('flow-20261025-033000.db')
    } finally {
      await job.stop()
    }
    expect(clock.pending).toBe(0)
  })

  test('启动时补做当天错过的备份，重启不重复；可自定义本地时间', async () => {
    const clock = new FakeClock(new Date(2026, 9, 24, 9).getTime())
    const paths: string[] = []
    const log = logs()
    const options = {
      home,
      config: hubConfigSchema.parse({ backup_at: '08:00', backup_keep: 1 }),
      clock,
      ledger: fakeBackup(paths),
      logger: log.logger,
    }
    const first = startMaintenance(options)
    await log.waitFor('info', 1)
    await first.stop()
    const oldPath = join(flowPaths(home).backups, 'flow-20261023-080000.db')
    await writeFile(oldPath, '{}')
    const second = startMaintenance(options)
    await second.stop()
    expect(paths).toHaveLength(1)
    expect(log.infos).toHaveLength(1)
    expect(await readdir(flowPaths(home).backups)).toEqual(['flow-20261024-090000.db'])
  })

  test('备份失败后 API 可用，下一天仍会调度', async () => {
    const clock = new FakeClock(new Date(2026, 9, 24, 4).getTime())
    const log = logs()
    let calls = 0
    const ledger: LedgerMaintenance = {
      backupTo: () => {
        calls++
        throw new Error('disk full')
      },
      close: () => {},
    }
    const job = startMaintenance({
      home,
      config: hubConfigSchema.parse({}),
      clock,
      ledger,
      logger: log.logger,
    })
    try {
      await log.waitFor('warn', 1)
      expect((await createHubApp().request('/v1/health')).status).toBe(200)
      await clock.advance(24 * 3600_000)
      await log.waitFor('warn', 2)
      expect(calls).toBe(2)
    } finally {
      await job.stop()
    }
  })

  test('在线 VACUUM INTO 副本可恢复，保留备份时刻数据', async () => {
    const clock = new FakeClock(new Date(2026, 9, 24, 4).getTime())
    await mkdir(flowPaths(home).state, { recursive: true })
    const db = await openDatabase(flowPaths(home).ledgerDb)
    db.exec('CREATE TABLE snapshot (value TEXT)')
    db.prepare('INSERT INTO snapshot VALUES (?)').run('before')
    const done: BackupInfo[] = []
    const ledger: LedgerMaintenance = {
      backupTo: (path) => db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`),
      close: () => db.close(),
    }
    const log = logs()
    const job = startMaintenance({
      home,
      config: hubConfigSchema.parse({}),
      clock,
      ledger,
      logger: log.logger,
      onBackupDone: (info) => {
        done.push(info)
      },
    })
    try {
      await log.waitFor('info', 1)
      db.prepare('INSERT INTO snapshot VALUES (?)').run('after')
      const restoredPath = join(home, 'restored.db')
      const info = done[0]
      if (!info) throw new Error('未生成备份')
      await copyFile(join(home, info.path), restoredPath)
      const restored = await openDatabase(restoredPath)
      try {
        expect(restored.prepare('SELECT value FROM snapshot').all()).toEqual([{ value: 'before' }])
      } finally {
        restored.close()
      }
      expect(db.prepare('SELECT value FROM snapshot').all()).toHaveLength(2)
    } finally {
      await job.stop()
      ledger.close()
    }
  })
})
