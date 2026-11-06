import { expect, test } from 'bun:test'
import { supervisorWakeRequest } from '@raindown/core'
import { openLedger } from '../src/index.ts'
import { must, tempLedger, WS } from './ledger-helpers.ts'

// 长指令改变账本可读范围，升级后的写入必须能在重启及重建后保持完整。
test('8192字符用户指令可重启重放，超过入口上限的指令不入账', async () => {
  const temporary = await tempLedger()
  const previousHome = process.env.RAINDOWN_HOME
  process.env.RAINDOWN_HOME = temporary.dir
  try {
    const text = '原'.repeat(8192)
    expect(supervisorWakeRequest.safeParse({ workspace: WS, text }).success).toBe(true)
    expect(supervisorWakeRequest.safeParse({ workspace: WS, text: `${text}越` }).success).toBe(
      false,
    )
    const written = must(
      temporary.store.append(
        {
          type: 'user.instruction',
          workspace: WS,
          payload: { text, via: 'cli' },
        },
        { actor: 'user' },
      ),
    )
    const rejected = temporary.store.append(
      {
        type: 'user.instruction',
        workspace: WS,
        payload: { text: `${text}越`, via: 'cli' },
      },
      { actor: 'user' },
    )
    expect(rejected.ok).toBe(false)
    expect(temporary.store.seq()).toBe(written.seq)
    temporary.store.close()
    const reopened = await openLedger(temporary.path)
    try {
      must(reopened.rebuild())
      const event = reopened.eventsAfter(written.seq - 1, undefined, 1)[0]
      expect(event).toMatchObject({ seq: written.seq, type: 'user.instruction', payload: { text } })
    } finally {
      reopened.close()
    }
  } finally {
    if (previousHome === undefined) delete process.env.RAINDOWN_HOME
    else process.env.RAINDOWN_HOME = previousHome
    temporary.cleanup()
  }
})
