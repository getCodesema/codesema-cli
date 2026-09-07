import { describe, expect, test } from 'bun:test'
import { serviceLaunchScript, shellSingleQuote } from './runbook-services.js'

describe('shellSingleQuote', () => {
  test('wraps a plain value in single quotes', () => {
    expect(shellSingleQuote('dockerd')).toBe("'dockerd'")
  })

  test('escapes an embedded single quote', () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('serviceLaunchScript', () => {
  test('index 0 backgrounds the command into /tmp/codesema-service-0.log', () => {
    expect(serviceLaunchScript('dockerd', 0)).toBe(
      "nohup sh -c 'dockerd' > /tmp/codesema-service-0.log 2>&1 &",
    )
  })

  test('index 3 backgrounds the command into /tmp/codesema-service-3.log', () => {
    expect(serviceLaunchScript('sleep 1', 3)).toBe(
      "nohup sh -c 'sleep 1' > /tmp/codesema-service-3.log 2>&1 &",
    )
  })
})
