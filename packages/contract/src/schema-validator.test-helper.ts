// Deliberately local and tiny, like recap.test.ts's and index.test.ts's own
// validators: this proves a SCHEMA against a SANITIZER's real output, not a
// library's leniency. Extracted from arm.test.ts so tasks.test.ts and
// runbook.test.ts can run the same cross tests against their own published
// schemas (see arm.test.ts for the original cross-test narrative).

export type Schema = Record<string, unknown>

export function deref(schema: Schema, root: Schema): Schema {
  const ref = schema.$ref
  if (typeof ref !== 'string') {
    return schema
  }
  const defs = (root.$defs ?? {}) as Record<string, Schema>
  const key = ref.replace('#/$defs/', '')
  const target = Object.hasOwn(defs, key) ? (defs[key] ?? {}) : {}
  const { $ref: _drop, ...siblings } = schema
  return { ...target, ...siblings }
}

export function typeMatches(node: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return node === null
    case 'string':
      return typeof node === 'string'
    case 'boolean':
      return typeof node === 'boolean'
    case 'integer':
      return typeof node === 'number' && Number.isInteger(node)
    // The hub's own TypeBox-generated schemas (verification.schema.json,
    // runbook-scan-result.schema.json) use the bare JSON Schema "number",
    // never "integer": this package's own schemas (arm.ts) never did, so this
    // branch was unreached until those fixtures arrived.
    case 'number':
      return typeof node === 'number' && Number.isFinite(node)
    case 'array':
      return Array.isArray(node)
    case 'object':
      return !!node && typeof node === 'object' && !Array.isArray(node)
    default:
      return false
  }
}

export function validateString(node: string, s: Schema, path: string): string[] {
  const errors: string[] = []
  const length = [...node].length
  if (typeof s.maxLength === 'number' && length > s.maxLength) {
    errors.push(`${path}: maxLength`)
  }
  if (typeof s.minLength === 'number' && length < s.minLength) {
    errors.push(`${path}: minLength`)
  }
  if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(node)) {
    errors.push(`${path}: pattern`)
  }
  return errors
}

export function validateNumber(node: number, s: Schema, path: string): string[] {
  const errors: string[] = []
  if (typeof s.minimum === 'number' && node < s.minimum) {
    errors.push(`${path}: minimum`)
  }
  if (typeof s.maximum === 'number' && node > s.maximum) {
    errors.push(`${path}: maximum`)
  }
  return errors
}

export function validateObject(node: object, s: Schema, root: Schema, path: string): string[] {
  const errors: string[] = []
  const record = node as Record<string, unknown>
  const properties = (s.properties ?? {}) as Record<string, Schema>
  for (const key of (s.required ?? []) as string[]) {
    if (!Object.hasOwn(record, key)) {
      errors.push(`${path}.${key}: required`)
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const child = Object.hasOwn(properties, key) ? properties[key] : undefined
    if (!child) {
      if (s.additionalProperties === false) {
        errors.push(`${path}.${key}: additionalProperties`)
      }
      continue
    }
    errors.push(...validate(value, child, root, `${path}.${key}`))
  }
  return errors
}

export function validate(node: unknown, schema: Schema, root: Schema, path = '$'): string[] {
  const s = deref(schema, root)
  const types =
    typeof s.type === 'string' ? [s.type] : Array.isArray(s.type) ? (s.type as string[]) : []
  const hasAssertion = 'const' in s || 'enum' in s || types.length > 0 || Array.isArray(s.anyOf)
  if (!hasAssertion) {
    // A schema node that asserts NOTHING accepts every value that reaches it.
    // Fail loudly here instead of quietly proving nothing.
    throw new Error(`schema validator: '${path}' asserts nothing`)
  }
  const errors: string[] = []
  if ('const' in s && node !== s.const) {
    errors.push(`${path}: const`)
  }
  if (Array.isArray(s.enum) && !s.enum.includes(node)) {
    errors.push(`${path}: enum`)
  }
  if (Array.isArray(s.anyOf)) {
    const branches = s.anyOf as Schema[]
    if (!branches.some((branch) => validate(node, branch, root, path).length === 0)) {
      errors.push(`${path}: anyOf`)
    }
  }
  if (types.length === 0) {
    return errors
  }
  if (!types.some((type) => typeMatches(node, type))) {
    errors.push(`${path}: type`)
    return errors
  }
  if (typeof node === 'string') {
    errors.push(...validateString(node, s, path))
  } else if (typeof node === 'number') {
    errors.push(...validateNumber(node, s, path))
  } else if (Array.isArray(node)) {
    const items = s.items as Schema | undefined
    if (items) {
      node.forEach((item, i) => errors.push(...validate(item, items, root, `${path}[${i}]`)))
    }
  } else if (node && typeof node === 'object') {
    errors.push(...validateObject(node, s, root, path))
  }
  return errors
}
