/**
 * Client 半体样式的回归测试。
 *
 * 背景：把包名改成 scoped（`@kongxiangyiren/dsh-notifier`）时，类名前缀被一起替换，
 * 产生了 `.@kongxiangyiren/dsh-notifier-row` 这种选择器——`@` 与 `/` 不是合法的 CSS
 * 标识符字符，浏览器会**整条丢弃**，表单直接失去样式。这里把"前缀必须合法、类名与
 * 样式必须一一对应、只用主题 token"三条固定下来。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLASS_PREFIX, CLIENT_CSS, cx } from '../src/lib/client-css'

const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')

/** 样式表里每条规则的选择器部分。 */
const selectors = [...CLIENT_CSS.matchAll(/([^{}]+)\{/g)].map((match) => match[1])

/** `client.ts` 里出现的类名（className 字面量）。 */
const usedClasses = [...new Set([...source.matchAll(/className: '([^']+)'/g)].map((match) => match[1]))]

const CSS_IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/
const SELECTOR = new RegExp(`^\\.${CSS_IDENT.source.slice(1, -1)}(\\[[^\\]]*\\])?(::?[a-z-]+(\\([^)]*\\))?)?$`)

describe('client 表单样式', () => {
  it('类名前缀本身是合法 CSS 标识符（不能直接用 scoped 包名）', () => {
    expect(CLASS_PREFIX).toMatch(CSS_IDENT)
    expect(CLASS_PREFIX).not.toContain('@')
    expect(CLASS_PREFIX).not.toContain('/')
  })

  it('每条选择器都合法，且不含 @ 或 /', () => {
    expect(selectors.length).toBeGreaterThan(20)
    for (const selector of selectors) {
      expect(selector).toMatch(SELECTOR)
      expect(selector).not.toContain('@')
      expect(selector).not.toContain('/')
    }
  })

  it('cx() 组合出正确类名', () => {
    expect(cx()).toBe(CLASS_PREFIX)
    expect(cx('row')).toBe(`${CLASS_PREFIX}-row`)
  })

  it('client.ts 用到的每个类名都有对应样式，且都带前缀', () => {
    expect(usedClasses.length).toBeGreaterThan(10)
    for (const name of usedClasses) {
      expect(name === CLASS_PREFIX || name.startsWith(`${CLASS_PREFIX}-`)).toBe(true)
      expect(selectors.some((selector) => selector === `.${name}` || selector.startsWith(`.${name}:`) || selector.startsWith(`.${name}[`))).toBe(true)
    }
  })

  it('只使用 --dsw-alias-* 主题 token', () => {
    const tokens = [...new Set([...CLIENT_CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))]
    expect(tokens.length).toBeGreaterThan(5)
    for (const token of tokens) expect(token).toMatch(/^--dsw-alias-/)
  })

  it('不出现硬编码颜色（否则深色主题下会失效）', () => {
    expect(CLIENT_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(CLIENT_CSS).not.toMatch(/\b(rgba?|hsla?)\(/)
  })

  it('主按钮的文字色随主题反转（品牌色在深色下是近白，写死白色会看不见）', () => {
    const button = [...CLIENT_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) => match[1] === `.${cx('button')}`)
    expect(button).toBeDefined()
    expect(button?.[2]).toContain('background:var(--dsw-alias-brand-primary)')
    expect(button?.[2]).toContain('color:var(--dsw-alias-bg-base)')
    // 开关圆点同理：开启态轨道是品牌色，圆点必须是会反转的底色。
    const knob = [...CLIENT_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) => match[1] === `.${cx('switch')}::after`)
    expect(knob?.[2]).toContain('background:var(--dsw-alias-bg-base)')
  })
})
