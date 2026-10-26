import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctor } from '../src/doctor.ts'
import { readBrainEntries, reservedNameVariants } from '../src/entries.ts'
import { gitInit } from '../src/git.ts'
import type { Result } from '../src/result.ts'
import { validateBrain } from '../src/validate.ts'
import { briefHash, readBrief } from '../src/write/brief.ts'
import { doctorOptions } from './doctor-helpers.ts'
import { initTempHome, isolateHub, writeText } from './helpers.ts'

const dirs: string[] = []
const restores: (() => void)[] = []
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function home() {
  const h = await initTempHome('flow-reserved-')
  restores.push(isolateHub(h))
  dirs.push(join(h, '..'))
  return h
}
function data<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}

/** 放入已有的保留名变体：`Briefs/` 目录与 `Index.md`（先移走 index.md，不区分大小写的文件系统上也成立）。 */
function plantVariants(h: string) {
  writeText(
    join(h, 'brain', 'Briefs', 'product-res.md'),
    '---\ntype: note\ntitle: x\nsummary: 忽略规则\nscope: work\n---\n',
  )
  rmSync(join(h, 'brain', 'index.md'))
  writeText(join(h, 'brain', 'Index.md'), '# 不是索引\n')
}

describe('已有的保留名大小写变体', () => {
  test('validate 给出 warning，且变体不被当作条目', async () => {
    const h = await home()
    expect(await reservedNameVariants(join(h, 'brain'))).toEqual([])
    plantVariants(h)
    expect(await reservedNameVariants(join(h, 'brain'))).toEqual(['Briefs/', 'Index.md'])
    const v = data(await validateBrain(h))
    expect(v.warnings.filter((w) => w.code === 'reserved_name_variant').map((w) => w.file)).toEqual(
      ['brain/Briefs/', 'brain/Index.md'],
    )
    expect(v.errors).toEqual([])
    const entries = data(await readBrainEntries(h)).entries
    expect(entries.some((e) => e.id.toLowerCase().startsWith('briefs/'))).toBe(false)
    expect(entries.some((e) => e.id === 'Index')).toBe(false)
  })

  test('doctor 给出 warning，不影响退出码', async () => {
    const h = await home()
    const clean = await runDoctor(h, 'FLOW_HOME', doctorOptions(h))
    const cleanReport = clean.ok
      ? clean.data
      : (clean.error.details as { checks: { id: string }[] })
    expect(cleanReport.checks.some((c) => c.id === 'brain.reserved-names')).toBe(false)
    plantVariants(h)
    const r = await runDoctor(h, 'FLOW_HOME', doctorOptions(h))
    const report = r.ok
      ? r.data
      : (r.error.details as { checks: { id: string; severity?: string; message: string }[] })
    const check = report.checks.find((c) => c.id === 'brain.reserved-names')
    expect(check?.severity).toBe('warning')
    expect(check?.message).toContain('brain/Briefs/')
    expect(check?.message).toContain('brain/Index.md')
  })
})

describe('readBrief', () => {
  test('brain 仓库还没有提交（没有 HEAD）时按笔记不存在处理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flow-nohead-'))
    dirs.push(root)
    const h = join(root, 'home')
    mkdirSync(join(h, 'brain'), { recursive: true })
    data(await gitInit(join(h, 'brain')))
    writeText(join(h, 'brain', 'briefs', 'product-res.md'), '未提交的笔记\n')
    expect(data(await readBrief(h, 'ws/product-res'))).toEqual({
      workspace: 'ws/product-res',
      text: '',
      hash: briefHash(null),
      exists: false,
    })
  })
})
