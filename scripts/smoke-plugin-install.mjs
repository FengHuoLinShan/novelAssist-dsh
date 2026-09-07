#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const dshBin = requiredPath('DSH_BIN')
const dshHome = resolve(required('DSH_HOME'))
const pluginTarball = requiredPath('PLUGIN_TARBALL')
const env = { ...process.env, DSH_HOME: dshHome }
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000

assert(!existsSync(dshHome) || readdirSync(dshHome).length === 0, 'DSH_HOME must be a new or empty smoke directory')
mkdirSync(dshHome, { recursive: true })
runDsh(['plugin', '--profile', 'web', 'add', pluginTarball])
const config = runDsh(['--profile', 'web', '--dump-config'])
assert(/^\s*name: ['"]?novelcraft-dsh['"]?\s*$/m.test(config), 'composed profile is missing novelcraft-dsh host')
assert(/^\s*name: ['"]?novelcraft-dsh\/client-host['"]?\s*$/m.test(config), 'composed profile is missing novelcraft-dsh client host')

const child = spawn(dshBin, ['--profile', 'web', '--no-open', '--port', '0'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
const append = (chunk) => { output = (output + chunk.toString()).slice(-200_000) }
child.stdout.on('data', append)
child.stderr.on('data', append)

try {
  const authenticatedUrl = await waitForWebUrl(child, () => output)
  const authorized = await request(authenticatedUrl, { redirect: 'manual' })
  assert(authorized.status === 303, `token exchange returned HTTP ${authorized.status}`)
  const cookie = (authorized.headers.getSetCookie?.()[0] ?? authorized.headers.get('set-cookie'))?.split(';', 1)[0]
  assert(cookie, 'token exchange did not return a browser-session cookie')
  const location = authorized.headers.get('location')
  assert(location, 'token exchange did not return a redirect location')

  const indexUrl = new URL(location, authenticatedUrl)
  const indexResponse = await request(indexUrl, { headers: { cookie } })
  assert(indexResponse.ok, `authorized index returned HTTP ${indexResponse.status}`)
  const html = await indexResponse.text()
  assert(html.includes('novelcraft-dsh'), 'boot graph does not contain novelcraft-dsh')

  const pluginUrls = [...new Set(html.match(/\/plugins\/\?\?[^"'<>\s]+/g) ?? [])]
  assert(pluginUrls.length > 0, 'boot page does not advertise plugin bundles')
  let factoryFound = false
  for (const relativeUrl of pluginUrls) {
    const url = new URL(relativeUrl.replaceAll('&amp;', '&'), indexUrl)
    const response = await request(url, { headers: { cookie } })
    if (!response.ok) continue
    const source = await response.text()
    if (/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']novelcraft-dsh["']/.test(source)) {
      factoryFound = true
      break
    }
  }
  assert(factoryFound, 'served plugin bundles do not register the novelcraft-dsh client factory')

  const rpcId = `smoke-${randomUUID()}`
  const rpcResponse = await request(new URL('/novelcraft/watch/state', indexUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin: indexUrl.origin,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'watch/state',
      payload: {},
    }),
  })
  assert(rpcResponse.status === 200, `watch/state returned HTTP ${rpcResponse.status}`)
  const rpc = await rpcResponse.json()
  assert(rpc?.type === 'server-response' && rpc.rpcId === rpcId, 'watch/state returned an invalid RPC envelope')
  assert(rpc.result?.ok === true, `watch/state failed: ${JSON.stringify(rpc.result)}`)
  assert(rpc.result.value?.bound === null, 'unbound smoke session did not return the safe empty state')
  console.log('plugin smoke OK: install, profile, Web boot, client factory, and Connection RPC')
} catch (error) {
  process.stderr.write(`${redact(error instanceof Error ? error.stack ?? error.message : String(error))}\n`)
  process.exitCode = 1
} finally {
  await stop(child)
  process.stderr.write(`dsh Web stopped (code=${child.exitCode}, signal=${child.signalCode})\n${redact(output)}\n`)
}

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requiredPath(name) {
  const value = resolve(required(name))
  if (!existsSync(value)) throw new Error(`${name} does not exist: ${value}`)
  return value
}

function runDsh(args) {
  const result = spawnSync(dshBin, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} failed (${result.status}):\n${redact(result.stderr || result.stdout)}`)
  }
  return result.stdout
}

function waitForWebUrl(processHandle, readOutput) {
  return new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => failed(new Error(`dsh Web did not become ready within ${START_TIMEOUT_MS}ms`)), START_TIMEOUT_MS)
    const inspect = () => {
      const match = /dsh web:\s+(https?:\/\/[^\s]+)/.exec(readOutput())
      if (!match) return
      clearTimeout(timeout)
      cleanup()
      resolveUrl(match[1])
    }
    const failed = (error) => {
      clearTimeout(timeout)
      cleanup()
      reject(error)
    }
    const exited = (code, signal) => failed(new Error(`dsh Web exited before readiness (code=${code}, signal=${signal})`))
    const cleanup = () => {
      processHandle.stdout.off('data', inspect)
      processHandle.stderr.off('data', inspect)
      processHandle.off('exit', exited)
      processHandle.off('error', failed)
    }
    processHandle.stdout.on('data', inspect)
    processHandle.stderr.on('data', inspect)
    processHandle.once('exit', exited)
    processHandle.once('error', failed)
    inspect()
  })
}

async function stop(processHandle) {
  if (processHandle.pid === undefined) return
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return
  processHandle.kill('SIGTERM')
  let timeout
  try {
    await Promise.race([
      once(processHandle, 'exit'),
      new Promise(resolveTimeout => { timeout = setTimeout(resolveTimeout, STOP_TIMEOUT_MS) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    processHandle.kill('SIGKILL')
    await once(processHandle, 'exit')
  }
}

function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(START_TIMEOUT_MS) })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function redact(value) {
  return value.replace(/([?&]token=)[^\s)&]+/g, '$1[redacted]')
}
