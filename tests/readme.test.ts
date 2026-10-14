/**
 * README 与代码保持一致性的测试。
 *
 * README 是发布到 npm 的首页，配置表和安装命令是使用者唯一会读的东西——它们一旦和
 * 代码漂移，就是"文档骗人"。这里把三件事钉住：配置表覆盖全部配置项、默认值与代码
 * 一致、安装命令就是 npm 安装。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index'
import { DEFAULTS } from '../src/lib/config'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

/** 配置项清单以 schema 为准（`DEFAULTS` 只覆盖有默认值的那些）。 */
const schemaFields = Object.keys((Config as unknown as { dict?: Record<string, unknown> }).dict ?? {})

/** README 配置表里 ``| `key` | 默认值 | 说明 |`` 形式的行。 */
const documented = new Map<string, string>()
for (const match of readme.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|\s*([^|]*?)\s*\|/gm)) {
  documented.set(match[1], match[2])
}

/** 代码里的默认值 → README 表格里该写的样子（README 习惯用反引号包住字面量）。 */
function shown(key: string): string {
  const value = (DEFAULTS as unknown as Record<string, unknown>)[key]
  if (value === undefined || value === '') return '—'
  return String(value)
}

describe('README', () => {
  it('schema 字段拿得到（否则下面的断言就失去意义）', () => {
    expect(schemaFields.length).toBeGreaterThan(10)
  })

  it('配置表覆盖全部配置项（不多不少）', () => {
    const codeKeys = [...schemaFields].sort()
    const docKeys = [...documented.keys()].sort()
    expect(docKeys.filter((key) => !codeKeys.includes(key)), 'README 里有代码中不存在的配置项').toEqual([])
    expect(codeKeys.filter((key) => !docKeys.includes(key)), 'README 缺少这些配置项').toEqual([])
  })

  it('配置表里的默认值与代码一致', () => {
    for (const key of schemaFields) {
      const cell = documented.get(key)
      expect(cell, `README 缺少 ${key}`).toBeDefined()
      // README 里默认值通常写成 `true` 这种带反引号的形式，比较前去掉反引号。
      expect(cell?.replace(/`/g, ''), `${key} 的默认值与代码不一致`).toBe(shown(key))
    }
  })

  it('安装方式写的是 npm 安装命令', () => {
    expect(readme).toContain('dsh plugin --profile web add @kongxiangyiren/dsh-notifier')
    expect(readme).toContain('npx @deepseek-ai/dsh plugin --profile web add @kongxiangyiren/dsh-notifier')
  })
})
