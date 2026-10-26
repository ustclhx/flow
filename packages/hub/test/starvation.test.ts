import { describe, expect, test } from 'bun:test'
import { createStarvationMonitor } from '../src/nodes/starvation.ts'

describe('createStarvationMonitor', () => {
  const setup = () => {
    let t = 0
    const m = createStarvationMonitor({ monotonic: () => t, intervalMs: 1000, windowMs: 60_000 })
    return {
      m,
      at: (ms: number) => {
        t = ms
      },
    }
  }

  test('按时采样不算卡住；小于阈值的抖动不计入', () => {
    const { m, at } = setup()
    for (let i = 1; i <= 10; i++) {
      at(i * 1000 + 100)
      m.tick()
    }
    expect(m.starvedMs()).toBe(0)
  })

  test('采样逾期的部分累计为卡住时长；进行中的卡住也计入', () => {
    const { m, at } = setup()
    at(1000)
    m.tick()
    at(4000)
    // 采样定时器还没来得及触发：进行中的卡住 2 秒。
    expect(m.starvedMs()).toBe(2000)
    m.tick()
    expect(m.starvedMs()).toBe(2000)
    at(5000)
    m.tick()
    expect(m.starvedMs()).toBe(2000)
  })

  test('超出窗口的卡住不再计入；reset 清空', () => {
    const { m, at } = setup()
    at(5000)
    m.tick()
    expect(m.starvedMs()).toBe(4000)
    for (let t = 6000; t <= 70_000; t += 1000) {
      at(t)
      m.tick()
    }
    expect(m.starvedMs()).toBe(0)
    at(80_000)
    m.reset()
    expect(m.starvedMs()).toBe(0)
  })
})
