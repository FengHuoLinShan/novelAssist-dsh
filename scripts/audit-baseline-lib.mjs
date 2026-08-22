export class AuditReportError extends Error {}
export class AuditBaselineViolation extends Error {}

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical']
const SEVERITIES = new Set(SEVERITY_ORDER)

function advisoryIdentity(advisory) {
  return JSON.stringify([
    advisory.source,
    advisory.name,
    advisory.dependency,
    advisory.title,
    advisory.url,
    advisory.severity,
  ])
}

function validBaselineAdvisory(advisory) {
  return advisory && typeof advisory === 'object' && !Array.isArray(advisory) &&
    Number.isSafeInteger(advisory.source) && advisory.source > 0 &&
    typeof advisory.name === 'string' && advisory.name.length > 0 &&
    typeof advisory.dependency === 'string' && advisory.dependency.length > 0 &&
    typeof advisory.title === 'string' && advisory.title.length > 0 &&
    typeof advisory.url === 'string' && advisory.url.length > 0 &&
    advisory.severity === 'high'
}

function concreteAdvisory(via, packageName) {
  if (!via || typeof via !== 'object' || Array.isArray(via)) {
    throw new AuditReportError(`invalid via entry: ${packageName}`)
  }
  if (!Number.isSafeInteger(via.source) || via.source <= 0 ||
      typeof via.name !== 'string' || via.name.length === 0 ||
      typeof via.dependency !== 'string' || via.dependency.length === 0 ||
      typeof via.title !== 'string' || via.title.length === 0 ||
      typeof via.url !== 'string' || via.url.length === 0 ||
      typeof via.range !== 'string' || via.range.length === 0 ||
      !SEVERITIES.has(via.severity)) {
    throw new AuditReportError(`incomplete concrete advisory: ${packageName}`)
  }
  return via
}

/** Pure advisory-aware validator, shared by CLI and zero-network self-tests. */
export function validateAuditReport(report, profile) {
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.error) {
    throw new AuditReportError(`audit error response: ${report?.error?.summary ?? 'invalid report'}`)
  }
  if (report.auditReportVersion !== 2) {
    throw new AuditReportError('auditReportVersion must be integer 2')
  }
  const counts = report.metadata?.vulnerabilities
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      !report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    throw new AuditReportError('missing metadata.vulnerabilities or vulnerabilities')
  }
  const high = counts.high
  const critical = counts.critical
  for (const severity of SEVERITY_ORDER) {
    if (!Number.isSafeInteger(counts[severity]) || counts[severity] < 0) {
      throw new AuditReportError(`invalid ${severity} count`)
    }
  }
  if (!Number.isSafeInteger(counts.total) || counts.total < 0) {
    throw new AuditReportError('invalid total count')
  }
  if (!profile || !Number.isSafeInteger(profile.maxHigh) || profile.maxHigh < 0 ||
      !Number.isSafeInteger(profile.maxCritical) || profile.maxCritical < 0 ||
      !Array.isArray(profile.allowedHighAdvisories) ||
      profile.allowedHighAdvisories.some((advisory) => !validBaselineAdvisory(advisory))) {
    throw new AuditReportError('invalid audit baseline profile')
  }
  const allowedIdentityList = profile.allowedHighAdvisories.map(advisoryIdentity)
  if (new Set(allowedIdentityList).size !== allowedIdentityList.length) {
    throw new AuditReportError('duplicate audit baseline advisory identity')
  }

  const entries = report.vulnerabilities
  const parsed = new Map()
  const reported = Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, 0]))
  for (const [packageName, vulnerability] of Object.entries(entries)) {
    if (!vulnerability || typeof vulnerability !== 'object' || Array.isArray(vulnerability) ||
        vulnerability.name !== packageName ||
        !SEVERITIES.has(vulnerability.severity) || !Array.isArray(vulnerability.via)) {
      throw new AuditReportError(`invalid vulnerability entry: ${packageName}`)
    }
    reported[vulnerability.severity] += 1
    const via = vulnerability.via.map((item) => {
      if (typeof item === 'string') {
        if (item.length === 0) throw new AuditReportError(`empty via reference: ${packageName}`)
        return item
      }
      return concreteAdvisory(item, packageName)
    })
    parsed.set(packageName, { severity: vulnerability.severity, via })
  }
  for (const severity of SEVERITY_ORDER) {
    if (reported[severity] !== counts[severity]) {
      throw new AuditReportError(`metadata/detail count mismatch: ${severity} ${counts[severity]}/${reported[severity]}`)
    }
  }
  const reportedTotal = SEVERITY_ORDER.reduce((sum, severity) => sum + reported[severity], 0)
  if (reportedTotal !== counts.total) {
    throw new AuditReportError(`metadata/detail count mismatch: total ${counts.total}/${reportedTotal}`)
  }

  const resolveConcrete = (packageName, visiting = new Set()) => {
    const entry = parsed.get(packageName)
    if (!entry) throw new AuditReportError(`via references missing package: ${packageName}`)
    if (visiting.has(packageName)) throw new AuditReportError(`cyclic via reference: ${packageName}`)
    const next = new Set(visiting)
    next.add(packageName)
    const concrete = []
    for (const item of entry.via) {
      if (typeof item === 'string') concrete.push(...resolveConcrete(item, next))
      else concrete.push(item)
    }
    return concrete
  }

  const allowed = new Set(allowedIdentityList)
  const unexpected = []
  for (const [packageName, entry] of parsed) {
    const concrete = resolveConcrete(packageName)
    if (concrete.length === 0) {
      throw new AuditReportError(`vulnerability entry has no concrete advisory: ${packageName}`)
    }
    const maxConcreteSeverity = concrete.reduce(
      (max, advisory) => Math.max(max, SEVERITY_ORDER.indexOf(advisory.severity)),
      -1,
    )
    if (maxConcreteSeverity !== SEVERITY_ORDER.indexOf(entry.severity)) {
      throw new AuditReportError(`entry/advisory severity mismatch: ${packageName}`)
    }
    for (const advisory of concrete) {
      if ((advisory.severity === 'high' || advisory.severity === 'critical') &&
          (advisory.severity === 'critical' || !allowed.has(advisoryIdentity(advisory)))) {
        unexpected.push({ package: packageName, severity: advisory.severity, title: advisory.title, url: advisory.url })
      }
    }
  }

  const failures = []
  if (high > profile.maxHigh) failures.push(`high ${high} > baseline ${profile.maxHigh}`)
  if (critical > profile.maxCritical) failures.push(`critical ${critical} > baseline ${profile.maxCritical}`)
  if (unexpected.length > 0) failures.push(`unregistered advisories: ${JSON.stringify(unexpected)}`)
  if (failures.length > 0) throw new AuditBaselineViolation(failures.join('; '))
  return { high, critical }
}
