#!/usr/bin/env node
/**
 * N36 dependency-audit gate.
 *
 * Usage:
 *   node scripts/check-audit-baseline.mjs --profile=default
 *   node scripts/check-audit-baseline.mjs --profile=bge
 *
 * The gate is advisory-aware, not count-only: fewer known findings pass, while
 * any unregistered high/critical finding fails even when aggregate counts stay
 * below the historical baseline.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AuditBaselineViolation, AuditReportError, validateAuditReport } from './audit-baseline-lib.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const baseline = JSON.parse(readFileSync(new URL('./audit-baseline.json', import.meta.url), 'utf8'))
const profileName = process.argv.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length) ?? 'default'
const profile = baseline.profiles?.[profileName]
if (!profile) {
  console.error(`unknown audit profile: ${profileName}`)
  process.exit(2)
}

const auditArgs = ['audit', '--omit=dev', '--json']
if (profileName === 'default') auditArgs.push('--omit=optional')
const result = spawnSync('npm', auditArgs, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (!result.stdout.trim()) {
  console.error(result.stderr.trim() || `npm ${auditArgs.join(' ')} produced no JSON`)
  process.exit(2)
}

let report
try {
  report = JSON.parse(result.stdout)
} catch (error) {
  console.error(`invalid npm audit JSON: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

if (result.error || (result.status !== 0 && result.status !== 1)) {
  console.error(`npm audit failed operationally: ${result.error?.message ?? result.stderr.trim() ?? 'unknown error'}`)
  process.exit(2)
}
try {
  const { high, critical } = validateAuditReport(report, profile)
  console.log(`audit baseline OK (${profileName}): high=${high}, critical=${critical}`)
} catch (error) {
  if (error instanceof AuditBaselineViolation) {
    console.error(`audit baseline failed (${profileName}): ${error.message}`)
    process.exit(1)
  }
  if (error instanceof AuditReportError) {
    console.error(`npm audit failed operationally: ${error.message}`)
    process.exit(2)
  }
  throw error
}
