/**
 * Command Code usage for DeepSeek Harness — Host half.
 *
 * Reads the same private billing routes the official `cmd` CLI uses for `/usage`
 *   GET <base>/alpha/whoami                 → { user, org }
 *   GET <base>/alpha/billing/credits        → { credits, windowLimits, sandboxMinutes }
 *   GET <base>/alpha/billing/subscriptions  → { data: { planId, status, currentPeriodEnd } }
 * with the account's `user_…` API key (the ref named by `COMMANDCODE_API_KEY`),
 * and serves a JSON-safe snapshot to the browser half over the process-private
 * Typert Remote namespace `commandcodeUsage`.
 *
 * Only the ledger (`credits`) is load-bearing: `whoami` names the account and
 * `subscriptions` names the plan, so a failure there costs its own detail and
 * nothing more. The API key is resolved from DSH credentials on every refresh
 * and never leaves this process.
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** Typert wire namespace owned by this plugin. */
const SERVICE = 'commandcodeUsage'

/** Host half of the plugin identity, matched by the browser half's descriptors. */
const PLUGIN_ID = 'commandcode-usage-dsh'

const DEFAULT_BASE = 'https://api.commandcode.ai'
const DEFAULT_KEY_REF = 'COMMANDCODE_API_KEY'
const POLL_MS = 30_000
const STARTUP_RETRY_DELAYS = [1200, 4000]
const REQUEST_TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 400

/**
 * Monthly allowance per plan id, from the public pricing page. The credits
 * response sometimes reports the grant itself; when it does not, this catalog
 * fills the gap so the monthly row can still show a percentage.
 */
const PLAN_CATALOG = [
  { match: /goat/i, label: 'GOAT', monthlyGrant: 70 },
  { match: /team/i, label: 'Team Pro', monthlyGrant: 40 },
  { match: /max.*20|20.*max/i, label: 'Max 20×', monthlyGrant: 300 },
  { match: /max/i, label: 'Max 10×', monthlyGrant: 150 },
  { match: /pro/i, label: 'Pro', monthlyGrant: 80 },
  { match: /go/i, label: 'Go', monthlyGrant: 10 },
]

/** Trim a configured API URL down to its origin. */
function normalizeBase(value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_BASE
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) return DEFAULT_BASE
  try {
    return new URL(trimmed).origin
  } catch {
    return DEFAULT_BASE
  }
}

/** Numbers only, `null` for anything the API omitted. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Epoch milliseconds → ISO string; anything else → null. */
function isoTime(value) {
  const ms = num(value)
  if (ms === null || ms <= 0) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Used share of a cap, clamped to 0…100 and rounded to one decimal. */
function percent(used, cap) {
  if (used === null || cap === null || cap <= 0) return null
  const value = (used / cap) * 100
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

/** Every field that crosses the Remote boundary must survive JSON. */
function sanitize(value) {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(sanitize)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = sanitize(value[key])
    return out
  }
  return value
}

/** Short, log-safe summary of a failed HTTP body. */
function bodyExcerpt(text) {
  const trimmed = String(text || '').trim().replace(/\s+/g, ' ')
  return trimmed.length > MAX_BODY_CHARS ? `${trimmed.slice(0, MAX_BODY_CHARS)}…` : trimmed
}

/**
 * One authenticated JSON GET. Uses the host process's own `fetch`, so an
 * `Authorization` header is allowed (the `ctx.web` seam deliberately is not).
 */
async function getJson(url, key) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${text ? ` — ${bodyExcerpt(text)}` : ''}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('响应不是合法 JSON')
  }
}

/** Plan label + monthly allowance for a `planId` such as `individual-goat`. */
function planInfo(planId) {
  if (typeof planId !== 'string' || planId === '') return null
  for (const entry of PLAN_CATALOG) {
    if (entry.match.test(planId)) {
      return { label: entry.label, monthlyGrant: entry.monthlyGrant }
    }
  }
  return { label: planId, monthlyGrant: null }
}

/** One rolling window (`fiveHour` / `weekly`). */
function readWindow(value) {
  if (!value || typeof value !== 'object') return null
  const used = num(value.used)
  const cap = num(value.cap)
  return {
    used,
    cap,
    percent: percent(used, cap),
    exceeded: value.exceeded === true ? true : value.exceeded === false ? false : null,
    resetAt: isoTime(value.resetAt),
  }
}

/** The monthly grant, when the ledger reports it explicitly. */
function readGrant(payload) {
  const credits = payload && payload.credits
  if (!credits || typeof credits !== 'object') return null
  for (const key of ['monthlyCreditsGranted', 'monthlyGranted', 'creditsGranted', 'grantedCredits', 'monthlyCreditsLimit']) {
    const value = num(credits[key])
    if (value !== null) return value
  }
  return null
}

/** `whoami` → the account name, and the web usage page it scopes. */
function readAccount(payload) {
  const user = payload && payload.user
  const org = payload && payload.org
  const account = {
    user: user && typeof user === 'object'
      ? {
          id: typeof user.id === 'string' ? user.id : null,
          name: typeof user.name === 'string' ? user.name : null,
          email: typeof user.email === 'string' ? user.email : null,
          userName: typeof user.userName === 'string' ? user.userName : null,
        }
      : null,
    org: org && typeof org === 'object'
      ? {
          id: typeof org.id === 'string' ? org.id : null,
          name: typeof org.name === 'string' ? org.name : null,
          slug: typeof org.slug === 'string' ? org.slug : null,
        }
      : null,
    usageUrl: null,
  }
  const slug = account.org && (account.org.slug || account.org.id)
  const userSlug = account.user && account.user.userName
  const owner = slug || userSlug
  if (typeof owner === 'string' && owner !== '') {
    account.usageUrl = `https://commandcode.ai/${owner}/settings/usage`
  }
  return account
}

/** `subscriptions` → the active plan. */
function readSubscription(payload) {
  const data = payload && payload.data
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  const active =
    list.find((entry) => entry && (entry.status === 'active' || entry.status === 'trialing')) || list[0] || null
  if (!active) return null
  const info = planInfo(active.planId)
  return {
    id: typeof active.planId === 'string' ? active.planId : null,
    label: info ? info.label : null,
    monthlyGrant: info ? info.monthlyGrant : null,
    status: typeof active.status === 'string' ? active.status : null,
    currentPeriodStart: typeof active.currentPeriodStart === 'string' ? active.currentPeriodStart : null,
    currentPeriodEnd: typeof active.currentPeriodEnd === 'string' ? active.currentPeriodEnd : null,
    cancelAtPeriodEnd: active.cancelAtPeriodEnd === true,
  }
}

/**
 * Host-side owner of the polled snapshot. One instance per host process; the
 * browser half only ever reads it.
 */
export class CommandcodeUsageService extends TypertRemoteService {
  static inject = ['timer']

  constructor(ctx, config = {}) {
    super(ctx, SERVICE)
    this.ctx = ctx
    this.config = config && typeof config === 'object' ? config : {}
    this.inflight = null
    this.state = sanitize({
      fetchedAt: null,
      keyConfigured: false,
      apiKeyEnv: this.keyRefSetting(),
      baseUrl: DEFAULT_BASE,
      usageUrl: null,
      user: null,
      org: null,
      plan: null,
      credits: null,
      windows: null,
      sandbox: null,
      errors: { whoami: null, credits: null, subscriptions: null },
      error: null,
    })

    const kick = () => {
      void this.refresh()
    }

    ctx.on('credentials/reference-updated', kick)
    ctx.on('settings/updated', (namespace) => {
      if (namespace === undefined || namespace === 'llm-pi-ai') kick()
    })
    ctx.effect(() => ctx.interval(kick, POLL_MS), 'commandcode-usage: poll')
    // The first poll is awaited by `snapshot()`, so a client that asks before the
    // network answers receives real data instead of the empty placeholder.
    this.ready = this.refresh()
    // The credential store reads its file asynchronously, so the very first poll
    // can beat it. Retry briefly instead of leaving the page keyless until the
    // next 30s tick.
    void this.bootstrapRetries()
    ctx.logger?.info?.('commandcode-usage: service started; polling api.commandcode.ai every 30s')
  }

  /** Current snapshot; pass `refresh: true` to re-read before answering. */
  async snapshot(request) {
    if (request && request.refresh === true) {
      await this.refresh()
    } else {
      await this.ready
    }
    return this.state
  }

  /** Does the snapshot still look like a credential store that is not ready yet? */
  needsCredentialRetry() {
    return this.state.keyConfigured !== true
  }

  /**
   * Re-poll a couple of times right after startup, so a credential store that is
   * still loading does not make the first paint look unconfigured.
   */
  async bootstrapRetries() {
    for (const delay of STARTUP_RETRY_DELAYS) {
      if (!this.needsCredentialRetry()) return
      await new Promise((done) => setTimeout(done, delay))
      await this.refresh()
    }
  }

  /** Force one poll now. Concurrent callers share the in-flight poll. */
  async refresh() {
    if (this.inflight) return this.inflight
    this.inflight = this.runPoll()
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  /** One poll, with the failure folded into the state. */
  async runPoll() {
    try {
      this.state = sanitize(await this.poll())
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      this.ctx.logger?.warn?.('commandcode-usage: refresh failed: %s', message)
      this.state = sanitize({ ...this.state, fetchedAt: Date.now(), error: message })
    }
    return this.state
  }

  keyRefSetting() {
    const ref = this.config && this.config.apiKeyEnv
    return typeof ref === 'string' && ref !== '' ? ref : DEFAULT_KEY_REF
  }

  /**
   * Which credential ref and base URL to poll: an `llm-pi-ai` provider whose id
   * or baseURL names Command Code wins, otherwise the standard ref.
   */
  resolveTarget() {
    let apiKeyEnv = this.keyRefSetting()
    let base = normalizeBase(this.config && this.config.baseUrl)
    try {
      const settings = this.ctx.get('settings')
      const pi = settings && typeof settings.get === 'function' ? settings.get('llm-pi-ai') : null
      const providers = pi && pi.providers
      if (providers && typeof providers === 'object') {
        for (const id of Object.keys(providers)) {
          const entry = providers[id]
          if (!entry || typeof entry !== 'object') continue
          const url = typeof entry.baseURL === 'string' ? entry.baseURL : ''
          const namesIt = id === 'commandcode' || id === 'command-code' || url.indexOf('commandcode.ai') !== -1
          if (!namesIt) continue
          if (typeof entry.apiKeyEnv === 'string' && entry.apiKeyEnv !== '') apiKeyEnv = entry.apiKeyEnv
          if (url !== '') base = normalizeBase(url)
          break
        }
      }
    } catch {
      /* settings not composed: the standard ref and base still work */
    }
    return { apiKeyEnv, base }
  }

  /** Resolve the API key from credentials, then from the process environment. */
  async resolveKey(apiKeyEnv) {
    const credentials = this.ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(apiKeyEnv)
        if (hit && typeof hit.value === 'string' && hit.value !== '') return hit.value
      } catch {
        /* unconfigured → fall through to the environment */
      }
    }
    const fromEnv = typeof process !== 'undefined' ? process.env[apiKeyEnv] : undefined
    return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : null
  }

  /** One poll: resolve the key, then read account, ledger and plan. */
  async poll() {
    const { apiKeyEnv, base } = this.resolveTarget()
    const key = await this.resolveKey(apiKeyEnv)
    const state = {
      fetchedAt: Date.now(),
      keyConfigured: key !== null,
      apiKeyEnv,
      baseUrl: base,
      usageUrl: null,
      user: null,
      org: null,
      plan: null,
      credits: null,
      windows: null,
      sandbox: null,
      errors: { whoami: null, credits: null, subscriptions: null },
      error: null,
    }
    if (!key) return state

    const [whoami, ledger, subscriptions] = await Promise.allSettled([
      getJson(`${base}/alpha/whoami`, key),
      getJson(`${base}/alpha/billing/credits`, key),
      getJson(`${base}/alpha/billing/subscriptions`, key),
    ])

    if (whoami.status === 'fulfilled') {
      const account = readAccount(whoami.value)
      state.user = account.user
      state.org = account.org
      state.usageUrl = account.usageUrl
    } else {
      state.errors.whoami = whoami.reason?.message ?? String(whoami.reason)
    }

    if (subscriptions.status === 'fulfilled') {
      state.plan = readSubscription(subscriptions.value)
    } else {
      state.errors.subscriptions = subscriptions.reason?.message ?? String(subscriptions.reason)
    }

    if (ledger.status === 'fulfilled') {
      const payload = ledger.value && typeof ledger.value === 'object' ? ledger.value : {}
      const rawCredits = payload.credits && typeof payload.credits === 'object' ? payload.credits : {}
      const remaining = num(rawCredits.monthlyCredits)
      const granted = readGrant(payload) ?? (state.plan ? state.plan.monthlyGrant : null)
      const used = granted !== null && remaining !== null ? Math.max(0, granted - remaining) : null
      state.credits = {
        remaining,
        granted,
        used,
        percent: used !== null && granted !== null && granted > 0
          ? Math.max(0, Math.min(100, Math.round((used / granted) * 1000) / 10))
          : null,
        purchased: num(rawCredits.purchasedCredits) ?? 0,
        free: num(rawCredits.freeCredits) ?? 0,
        threshold: num(rawCredits.creditThreshold),
        belowThreshold: rawCredits.belowThreshold === true,
      }
      const limits = payload.windowLimits && typeof payload.windowLimits === 'object' ? payload.windowLimits : null
      state.windows = limits
        ? { fiveHour: readWindow(limits.fiveHour), weekly: readWindow(limits.weekly) }
        : null
      const sandbox = payload.sandboxMinutes && typeof payload.sandboxMinutes === 'object' ? payload.sandboxMinutes : null
      state.sandbox = sandbox
        ? {
            usedMinutes: num(sandbox.usedMinutes),
            limitMinutes: num(sandbox.limitMinutes),
            overageUsd: num(sandbox.overageUsd),
            resetAt: isoTime(sandbox.resetAt),
          }
        : null
    } else {
      state.errors.credits = ledger.reason?.message ?? String(ledger.reason)
      // The ledger is the page's subject: a failure has to be visible even when
      // whoami and subscriptions answered.
      state.error = state.errors.credits
    }

    if (!state.error && !state.windows) {
      state.error = '响应中没有 windowLimits 字段'
    }
    return state
  }
}

// The Typert pipeline normally generates these decorators; a hand-written
// bundle applies them directly, exactly as the shipped third-party bundles do.
for (const name of ['snapshot', 'refresh']) {
  const prototype = CommandcodeUsageService.prototype
  Remote(name)(prototype[name], {
    name,
    private: false,
    static: false,
    addInitializer(fn) {
      fn.call(Object.create(prototype))
    },
  })
}

export { PLUGIN_ID, SERVICE }
export default CommandcodeUsageService
