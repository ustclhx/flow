import { expect, test } from 'bun:test'
import { readRaindownEnv } from '../src/env.ts'

test('环境读取使用新非空值，否则回退旧非空值', () => {
  expect(
    readRaindownEnv('RAINDOWN_TASK_ID', { RAINDOWN_TASK_ID: ' new ', FLOW_TASK_ID: 'old' }),
  ).toBe('new')
  expect(
    readRaindownEnv('RAINDOWN_TASK_ID', { RAINDOWN_TASK_ID: ' ', FLOW_TASK_ID: ' old ' }),
  ).toBe('old')
  expect(readRaindownEnv('RAINDOWN_TASK_ID', { FLOW_TASK_ID: ' ' })).toBeUndefined()
})
