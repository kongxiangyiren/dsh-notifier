import { expect, test } from 'vitest'
import { Config } from '../src'
import { DEFAULTS, resolveOptions } from '../src/lib/config'

interface StandardSchemaLike {
  validate(input: unknown): { issues?: unknown; value?: unknown }
}

const standards = (Config as unknown as { '~standard': StandardSchemaLike })['~standard']

test('Config schema 接受空配置并填满默认值', () => {
  const result = standards.validate({})
  expect(result.issues).toBeUndefined()
  expect(resolveOptions(result.value)).toEqual(DEFAULTS)
})

test('Config schema 拒绝未知枚举值与错误类型', () => {
  expect(standards.validate({ language: 'fr' }).issues).toBeDefined()
  expect(standards.validate({ onApproval: 'yes' }).issues).toBeDefined()
  expect(standards.validate({ maxBodyLength: -1 }).issues).toBeDefined()
})

test('Config schema 接受合法覆盖', () => {
  const result = standards.validate({ language: 'en', onApproval: false, idleGraceMs: 3000 })
  expect(result.issues).toBeUndefined()
  const options = resolveOptions(result.value)
  expect(options.language).toBe('en')
  expect(options.onApproval).toBe(false)
  expect(options.idleGraceMs).toBe(3000)
})
