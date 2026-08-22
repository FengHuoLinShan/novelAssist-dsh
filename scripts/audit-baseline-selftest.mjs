#!/usr/bin/env node
import assert from 'node:assert/strict'
import { AuditBaselineViolation, AuditReportError, validateAuditReport } from './audit-baseline-lib.mjs'

const known = 'https://github.com/advisories/GHSA-known'
const advisory = (url = known, severity = 'high') => ({
  source: 123,
  name: 'leaf',
  dependency: 'leaf',
  title: 'known advisory',
  url,
  severity,
  range: '<2.0.0',
})
const { range: _range, ...knownIdentity } = advisory()
const profile = { maxHigh: 4, maxCritical: 0, allowedHighAdvisories: [knownIdentity] }
const report = (entries = {}) => {
  const vulnerabilities = Object.fromEntries(
    Object.entries(entries).map(([name, vulnerability]) => [name, { name, ...vulnerability }]),
  )
  const values = Object.values(vulnerabilities)
  return {
    auditReportVersion: 2,
    metadata: {
      vulnerabilities: {
        info: values.filter((v) => v.severity === 'info').length,
        low: values.filter((v) => v.severity === 'low').length,
        moderate: values.filter((v) => v.severity === 'moderate').length,
        high: values.filter((v) => v.severity === 'high').length,
        critical: values.filter((v) => v.severity === 'critical').length,
        total: values.length,
      },
    },
    vulnerabilities,
  }
}
const knownFour = report({
  root: { severity: 'high', via: ['middle'] },
  middle: { severity: 'high', via: ['leaf'] },
  leaf: { severity: 'high', via: [advisory()] },
  other: { severity: 'high', via: [advisory()] },
})

assert.deepEqual(validateAuditReport(knownFour, profile), { high: 4, critical: 0 })
assert.deepEqual(validateAuditReport(report({}), profile), { high: 0, critical: 0 })
assert.throws(() => validateAuditReport(report({ pkg: { severity: 'high', via: [advisory('https://example/new')] } }), profile), AuditBaselineViolation)
assert.throws(() => validateAuditReport(report({ pkg: { severity: 'high', via: [{ ...advisory(), source: 999, title: 'different advisory reusing URL' }] } }), profile), AuditBaselineViolation)
assert.throws(() => validateAuditReport(report({ pkg: { severity: 'critical', via: [advisory(known, 'critical')] } }), profile), AuditBaselineViolation)
assert.throws(() => validateAuditReport({ error: { summary: 'registry unavailable' } }, profile), AuditReportError)
assert.throws(() => validateAuditReport({ metadata: { vulnerabilities: { high: 0, critical: 0 } } }, profile), AuditReportError)
assert.throws(() => validateAuditReport({ ...report({}), metadata: { vulnerabilities: { high: Number.NaN, critical: 0 } } }, profile), AuditReportError)
assert.throws(() => validateAuditReport({ metadata: { vulnerabilities: { high: 0, critical: 0 } }, vulnerabilities: { pkg: {} } }, profile), AuditReportError)
assert.throws(() => validateAuditReport({ metadata: { vulnerabilities: { high: 4, critical: 0 } }, vulnerabilities: {} }, profile), AuditReportError)
assert.throws(() => validateAuditReport(report({ pkg: { severity: 'high', via: ['missing'] } }), profile), AuditReportError)
assert.throws(() => validateAuditReport(report({ pkg: { severity: 'high', via: ['cycle'] }, cycle: { severity: 'high', via: ['pkg'] } }), profile), AuditReportError)
assert.throws(() => validateAuditReport(report({ pkg: { severity: 'high', via: [{ severity: 'high', url: known, title: 'missing source/range' }] } }), profile), AuditReportError)
assert.throws(() => validateAuditReport(report({ a: { severity: 'high', via: ['b', advisory()] }, b: { severity: 'high', via: ['a'] } }), profile), AuditReportError)
assert.throws(() => validateAuditReport(report({ wrapper: { severity: 'moderate', via: [advisory('https://example/hidden', 'high')] } }), profile), AuditReportError)
assert.throws(() => {
  const malformed = report({})
  malformed.metadata.vulnerabilities.low = 7
  malformed.metadata.vulnerabilities.total = 99
  validateAuditReport(malformed, profile)
}, AuditReportError)
assert.throws(() => validateAuditReport({ ...report({}), auditReportVersion: 1 }, profile), AuditReportError)
assert.throws(() => {
  const mismatch = report({ pkg: { severity: 'high', via: [advisory()] } })
  mismatch.vulnerabilities.pkg.name = 'different-package'
  validateAuditReport(mismatch, profile)
}, AuditReportError)
assert.throws(() => validateAuditReport(report({ pkg: { severity: 'high', via: [] } }), profile), AuditReportError)
assert.throws(() => validateAuditReport(
  report({ pkg: { severity: 'critical', via: [advisory(known, 'critical')] } }),
  { ...profile, maxCritical: 99 },
), AuditBaselineViolation)
console.log('audit baseline self-test OK: 20 cases')
