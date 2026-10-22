/**
 * Smoke tests for commandcode-usage-dsh.
 *
 *   node test/smoke.mjs
 *
 * The host test talks to the real Command Code billing endpoints when a
 * COMMANDCODE_API_KEY credential is available (from the environment or from
 * $DSH_HOME/.credentials.yaml), and falls back to a stubbed response otherwise,
 * so the suite passes offline too.
 */
import { mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SANDBOX = join(HERE, '.sandbox')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// host half
// ---------------------------------------------------------------------------

/** Read a credential reference out of the shared DSH credentials document. */
function credentialFromHome(ref) {
  const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
  try {
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const match = new RegExp(`${ref}:\\s*(\\S+)`).exec(text)
    return match ? match[1].replace(/,$/, '') : null
  } catch {
    return null
  }
}

function scaffold() {
  const pkg = join(SANDBOX, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', version: '0.0.0-stub', type: 'module', main: 'index.js' }))
  writeFileSync(
    join(pkg, 'index.js'),
    [
      'export class TypertRemoteService {',
      '  constructor(ctx, namespace) { this.ctx = ctx; this.namespace = namespace }',
      '}',
      'export function Remote(name) {',
      '  return (fn) => { fn.__remoteName = name }',
      '}',
      '',
    ].join('\n'),
  )
  copyFileSync(join(ROOT, 'lib', 'index.js'), join(SANDBOX, 'host.mjs'))
}

function mockContext(keyRef, key, options = {}) {
  const withProviders = options.withProviders === true
  const credentialsAfterMs = options.credentialsAfterMs || 0
  const startedAt = Date.now()
  return {
    logger: { warn() {}, info() {} },
    on() {},
    effect(fn) {
      return fn()
    },
    interval() {
      return () => {}
    },
    timeout() {
      return () => {}
    },
    get(name) {
      // A credential store that has not finished mounting yet: the very first
      // poll sees no service at all.
      if (name === 'credentials' && Date.now() - startedAt < credentialsAfterMs) return undefined
      if (name === 'credentials') {
        return { resolve: async (ref) => (ref === keyRef ? { value: key } : undefined) }
      }
      if (name === 'settings' && withProviders) {
        return {
          get: (namespace) =>
            namespace === 'llm-pi-ai'
              ? {
                  providers: {
                    commandcode: {
                      apiKeyEnv: keyRef,
                      baseURL: 'https://api.commandcode.ai/provider/v1',
                    },
                  },
                }
              : undefined,
        }
      }
      return undefined
    },
  }
}

async function testHost() {
  console.log('host half')
  scaffold()
  const { default: CommandcodeUsageService, SERVICE, PLUGIN_ID } = await import(
    pathToFileURL(join(SANDBOX, 'host.mjs')).href
  )

  check('namespace is advertised', SERVICE === 'commandcodeUsage' && PLUGIN_ID === 'commandcode-usage-dsh')

  const keyRef = 'COMMANDCODE_API_KEY'
  const key = process.env[keyRef] || credentialFromHome(keyRef)
  const live = Boolean(key)
  const now = Date.now()

  const originalFetch = globalThis.fetch
  if (!live) {
    globalThis.fetch = async (url) => {
      const body = url.includes('/alpha/whoami')
        ? { success: true, user: { id: 'u1', name: 'Ada', email: 'ada@example.com', userName: 'ada' }, org: null }
        : url.includes('/alpha/billing/credits')
          ? {
              credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 69.928645192, purchasedCredits: 0, freeCredits: 0 },
              windowLimits: {
                limited: true,
                exceeded: null,
                fiveHour: { used: 0.071354808, cap: 14, exceeded: false, resetAt: now + 4 * 3600_000 + 19 * 60_000 },
                weekly: { used: 0.071354808, cap: 35, exceeded: false, resetAt: now + 2 * 86400_000 },
              },
              sandboxAccess: true,
              sandboxMinutes: { usedMinutes: 0, limitMinutes: 0, overageUsd: 0, resetAt: now + 30 * 86400_000 },
            }
          : {
              success: true,
              data: {
                status: 'active',
                planId: 'individual-goat',
                currentPeriodStart: new Date(now).toISOString(),
                currentPeriodEnd: new Date(now + 30 * 86400_000).toISOString(),
                cancelAtPeriodEnd: false,
              },
            }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
  }

  try {
    const service = new CommandcodeUsageService(mockContext(keyRef, key || 'user_stub'))
    const state = await service.snapshot()
    check('snapshot is JSON-safe', !JSON.stringify(state).includes('undefined'))
    check('key resolves through credentials', state.keyConfigured === true)
    check('account name read', Boolean(state.user && state.user.name), JSON.stringify(state.user))
    check('plan read', Boolean(state.plan && state.plan.label), JSON.stringify(state.plan))
    check('monthly credits present', Boolean(state.credits), JSON.stringify(state.credits))
    check('5-hour window present', Boolean(state.windows && state.windows.fiveHour))
    check('weekly window present', Boolean(state.windows && state.windows.weekly))
    const window = state.windows && state.windows.fiveHour
    check(
      `5-hour percent is a number (${window && window.percent})`,
      Boolean(window) && typeof window.percent === 'number' && window.percent >= 0 && window.percent <= 100,
    )
    check(
      `5-hour reset time parses (${window && window.resetAt})`,
      Boolean(window) && !Number.isNaN(Date.parse(window.resetAt || '')),
    )
    check('web usage page derived', typeof state.usageUrl === 'string' && state.usageUrl.includes('/settings/usage'), state.usageUrl)
    check('no usage error', !state.error, state.error || '')
    console.log(`       source: ${live ? 'live API' : 'stubbed response'}`)

    // The provider row in `llm-pi-ai` names both the ref and the origin.
    const viaProvider = new CommandcodeUsageService(mockContext(keyRef, key || 'user_stub', { withProviders: true }))
    const providerState = await viaProvider.snapshot()
    check('provider row supplies the base URL', providerState.baseUrl === 'https://api.commandcode.ai', providerState.baseUrl)
    check('provider row keeps the account card', providerState.keyConfigured === true)

    // A credential store that is slower than the first poll must not decide the
    // first paint: the startup retries have to resolve the key on their own.
    const slowService = new CommandcodeUsageService(mockContext(keyRef, key || 'user_stub', { credentialsAfterMs: 600 }))
    await slowService.ready
    check('first poll may race the credential store', slowService.needsCredentialRetry() === true)
    const healed = await slowService.bootstrapRetries().then(() => slowService.state)
    check('startup retries resolve the key', healed.keyConfigured === true)

    // Nothing resolves at all: the retry loop must still run.
    const emptyService = new CommandcodeUsageService(mockContext(keyRef, undefined))
    await emptyService.ready
    check('empty snapshot keeps retrying', emptyService.needsCredentialRetry() === true)
    check('empty snapshot reports no key', emptyService.state.keyConfigured === false)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ---------------------------------------------------------------------------
// browser half
// ---------------------------------------------------------------------------

/** Just enough React for a server-side smoke render. */
function reactStub() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect(effect) {
      effect()
    },
  }
}

/** Collect every string rendered into an element tree. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (node.children) for (const child of node.children) textOf(child, out)
  return out
}

async function testClient() {
  console.log('browser half')
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  let definition = null
  const fakeWindow = { __ModuleLoader__: { load: (value) => { definition = value } } }
  const requireStub = (name) => {
    if (name === 'react') return reactStub()
    throw new Error(`unexpected require("${name}")`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(fakeWindow, requireStub)

  check('module loader definition captured', Boolean(definition) && definition.id === 'commandcode-usage-dsh')
  const plugin = definition.factory(requireStub)
  check('apply/inject exported', typeof plugin.apply === 'function' && Array.isArray(plugin.inject))
  check('timer is injected for polling', plugin.inject.includes('timer'))

  let registeredOptions = null
  let RegisteredComponent = null
  const remoteCalls = []
  const snapshot = {
    ok: true,
    value: {
      fetchedAt: Date.now(),
      keyConfigured: true,
      apiKeyEnv: 'COMMANDCODE_API_KEY',
      baseUrl: 'https://api.commandcode.ai',
      usageUrl: 'https://commandcode.ai/qpengfsd6y/settings/usage',
      user: { name: 'Joey Qu', email: 'qpengf@gmail.com', userName: 'qpengfsd6y' },
      org: null,
      plan: {
        id: 'individual-goat',
        label: 'GOAT',
        monthlyGrant: 70,
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
        cancelAtPeriodEnd: false,
      },
      credits: { remaining: 69.928645192, granted: 70, used: 0.071354808, percent: 0.1, purchased: 0, free: 0, threshold: 0, belowThreshold: false },
      windows: {
        fiveHour: { used: 0.071354808, cap: 14, percent: 0.5, exceeded: false, resetAt: new Date(Date.now() + 4 * 3600_000 + 19 * 60_000).toISOString() },
        weekly: { used: 0.071354808, cap: 35, percent: 0.2, exceeded: false, resetAt: new Date(Date.now() + 2 * 86400_000 + 10 * 3600_000).toISOString() },
      },
      sandbox: null,
      errors: { whoami: null, credits: null, subscriptions: null },
      error: null,
    },
  }
  const namespace = {
    async snapshot() {
      remoteCalls.push('snapshot')
      return snapshot
    },
    async refresh() {
      remoteCalls.push('refresh')
      return { ok: true, value: null }
    },
  }

  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    timeout() {
      return () => {}
    },
    interval() {
      return () => {}
    },
    locale: { bind: () => (key) => key, register() {} },
    slots: {
      inject(name, callback) {
        if (name !== 'settings.section') return
        callback()
      },
      register(options, component) {
        registeredOptions = options
        RegisteredComponent = component
        return () => {}
      },
    },
    remote: { $mount: async () => {} },
    inject(services, callback) {
      if (services[0] === 'remote.commandcodeUsage') {
        callback({ remote: { commandcodeUsage: namespace } })
      }
    },
  }

  await plugin.apply(ctx)
  await new Promise((done) => setTimeout(done, 60))

  check('settings.section registered', Boolean(registeredOptions) && registeredOptions.name === 'settings.section')
  check('section id is commandcode-usage', registeredOptions && registeredOptions.id === 'commandcode-usage')
  check('section carries a nav label', registeredOptions && typeof registeredOptions.label === 'function')
  check('remote snapshot was read', remoteCalls.includes('snapshot'))

  const face = registeredOptions.inject()
  const hooks = face.hooks
  check('store hooks exposed', Boolean(hooks && hooks.commandcodeUsage && typeof hooks.commandcodeUsage.getSnapshot === 'function'))

  const state = hooks.commandcodeUsage.getSnapshot()
  check('store reached the ready phase', state.phase === 'ready', state.phase)
  check('snapshot carried the plan', state.data && state.data.plan && state.data.plan.label === 'GOAT')

  const props = {
    ...face,
    t: (key) => key,
    useCommandcodeUsage: (selector) => selector(hooks.commandcodeUsage.getSnapshot()),
    useCommandcodeUsageBusy: (selector) => selector(hooks.commandcodeUsageBusy.getSnapshot()),
  }
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = () => 0
  let text
  try {
    const tree = RegisteredComponent(props)
    text = textOf(tree).join(' | ')
  } finally {
    globalThis.setInterval = originalSetInterval
  }
  check('renders the 5-hour window', text.includes('fiveHour'), text)
  check('renders the weekly window', text.includes('weekly'), text)
  check('renders the monthly row', text.includes('monthly'), text)
  check('renders used percentages', text.includes('usedSuffix'), text)
  check('renders a reset countdown', /\d+[dh] \d+[hm]/.test(text), text)
  check('renders the plan label', text.includes('GOAT'))
  check('renders the monthly amounts', text.includes('$0.071') && text.includes('$70'), text)
  check('renders the account email', text.includes('qpengf@gmail.com'))
  check('renders the web usage page', text.includes('qpengfsd6y/settings/usage'))

  await new Promise((done) => {
    const restore = globalThis.setInterval
    globalThis.setInterval = () => 0
    try {
      props.reload()
      setTimeout(() => {
        globalThis.setInterval = restore
        done()
      }, 40)
    } catch (error) {
      globalThis.setInterval = restore
      done()
    }
  })
  check('reload forces a host refresh', remoteCalls.includes('refresh'))
}

// ---------------------------------------------------------------------------

try {
  await testHost()
  await testClient()
} finally {
  await new Promise((done) => setTimeout(done, 20))
}

rmSync(SANDBOX, { recursive: true, force: true })

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
