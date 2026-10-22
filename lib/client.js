/**
 * Command Code usage for DeepSeek Harness — browser half.
 *
 * Registers a "Command Code 用量" page into the Settings dialog through the
 * official `settings.section` slot, and reads the plan's rolling windows and
 * monthly credits from the host half over the Typert Remote namespace
 * `commandcodeUsage`.
 *
 * Written against the plain `window.__ModuleLoader__` contract, so no build
 * step and no JSX toolchain are required: React comes from the module loader.
 */
window.__ModuleLoader__.load({
  id: 'commandcode-usage-dsh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // ---------------------------------------------------------------- wire ---

    const PLUGIN_ID = 'commandcode-usage-dsh'
    const SERVICE = 'commandcodeUsage'

    /** Strict JSON codec for the hand-written request payload. */
    const codec = () => ({
      mode: 'strict',
      typeSymbol: `${PLUGIN_ID}#json`,
      create: () => ({ parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) }),
    })

    /** One direct-invocation descriptor, hand-written in place of codegen. */
    function descriptor(method, withRequest) {
      return {
        id: `${PLUGIN_ID}#${SERVICE}/${method}`,
        service: SERVICE,
        namespace: SERVICE,
        method,
        invocation: { kind: 'direct' },
        ...(withRequest
          ? { parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec() }] }
          : { parameters: [] }),
        result: { mode: 'src-json' },
        cancellation: { parameter: 'signal' },
      }
    }

    const TYPERT_REMOTE = {
      package: PLUGIN_ID,
      descriptors: [descriptor('snapshot', true), descriptor('refresh', false)],
    }

    // -------------------------------------------------------------- locale ---

    const NS = 'settings.commandcodeUsage'

    const en = {
      nav: 'Command Code usage',
      title: 'Command Code usage',
      intro: 'Your Command Code plan at a glance: the 5-hour and weekly rolling windows, plus this billing cycle’s monthly credits.',
      fiveHour: '5-hour window',
      weekly: 'Weekly window',
      monthly: 'Monthly credits',
      usedSuffix: '% used',
      resetPrefix: 'Resets in ',
      resetPending: 'resetting now',
      periodEnd: 'Period ends ',
      remaining: 'remaining',
      purchased: 'purchased',
      free: 'free',
      sandbox: 'Cloud sandbox',
      minutes: ' min',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Reading usage…',
      unavailable: 'The commandcode-usage-dsh host half is not running in this profile.',
      noKey: 'No Command Code API key is configured (COMMANDCODE_API_KEY).',
      failed: 'Could not read usage',
      updated: 'Updated ',
      unavailableWindow: 'not reported',
      webPage: 'Web usage page: ',
      planPrefix: 'Plan ',
      cancelling: 'cancelling',
      noPlan: 'no active subscription',
      unknownPlan: 'unknown plan',
    }

    const zh = {
      nav: 'Command Code 用量',
      title: 'Command Code 用量',
      intro: '当前 Command Code 方案的使用量：5 小时与每周滚动窗口，以及本计费周期的每月额度。',
      fiveHour: '5 小时窗口',
      weekly: '每周窗口',
      monthly: '每月额度',
      usedSuffix: '% 已用',
      resetPrefix: '重置于 ',
      resetPending: '即将重置',
      periodEnd: '本期结束 ',
      remaining: '剩余',
      purchased: '加购',
      free: '赠送',
      sandbox: '云端沙盒',
      minutes: ' 分钟',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在读取用量…',
      unavailable: '当前 profile 没有加载 commandcode-usage-dsh 的宿主半。',
      noKey: '没有配置 Command Code 的 API key（COMMANDCODE_API_KEY）。',
      failed: '读取用量失败',
      updated: '更新于 ',
      unavailableWindow: '未返回',
      webPage: '网页用量页：',
      planPrefix: '方案 ',
      cancelling: '到期取消',
      noPlan: '没有生效中的订阅',
      unknownPlan: '未知方案',
    }

    // ------------------------------------------------------------- helpers ---

    /** A finite number, or null. */
    function number(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    /** `$0.07`, `$14.00`, `$69.93` — small values keep a third decimal. */
    function money(value) {
      const amount = number(value)
      if (amount === null) return '—'
      const digits = amount !== 0 && Math.abs(amount) < 0.1 ? 3 : 2
      return `$${amount.toFixed(digits)}`
    }

    /** Compact countdown, e.g. `4h 19m`, `2d 10h`, `30d 23h`. */
    function countdown(resetAt, now) {
      if (typeof resetAt !== 'string') return null
      const target = Date.parse(resetAt)
      if (Number.isNaN(target)) return null
      const diff = target - now
      if (diff <= 0) return ''
      const minutes = Math.floor(diff / 60_000)
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const mins = minutes % 60
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${mins}m`
      return `${mins}m`
    }

    /** Green → amber → red as the consumed share grows. */
    function barColor(used) {
      if (used === null) return 'rgba(128,128,128,.5)'
      if (used > 85) return '#d05a4e'
      if (used > 60) return '#d99a2b'
      return '#2f9e60'
    }

    /** Percent for the badge: one decimal below 10, whole numbers above. */
    function percentText(value) {
      const percent = number(value)
      if (percent === null) return null
      return percent < 10 ? percent.toFixed(1) : String(Math.round(percent))
    }

    function message(error) {
      if (!error) return ''
      if (typeof error === 'string') return error
      return error.message || String(error)
    }

    /** Unwrap the Remote call's discriminated result. */
    function unwrap(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return result.value
        const failure = result.error
        throw new Error(message(failure))
      }
      return result
    }

    // --------------------------------------------------------------- store ---

    /** Minimal observable the slot engine can turn into a `useX` hook. */
    function createStore() {
      let current = { phase: 'loading', data: null, fetchedAt: null, error: null }
      const listeners = new Set()
      return {
        getSnapshot: () => current,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          current = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    // ------------------------------------------------------------------ ui ---

    const styles = {
      head: { margin: '0 0 6px', fontSize: 18, fontWeight: 600 },
      intro: { margin: '0 0 18px', fontSize: 13, lineHeight: 1.55, opacity: 0.72 },
      card: { border: '1px solid rgba(128,128,128,.28)', borderRadius: 12, padding: '16px 18px', marginBottom: 14 },
      cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 },
      cardTitle: { fontSize: 14, fontWeight: 600 },
      cardSub: { marginTop: 3, fontSize: 12, opacity: 0.66 },
      planBadge: {
        display: 'inline-block',
        marginLeft: 8,
        fontSize: 11,
        fontWeight: 600,
        background: 'rgba(128,128,128,.12)',
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 6,
        padding: '1px 7px',
        verticalAlign: 'middle',
      },
      button: {
        border: '1px solid rgba(128,128,128,.35)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '5px 12px',
        fontSize: 12,
        cursor: 'pointer',
      },
      row: { marginTop: 14 },
      rowHead: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 },
      windowLabel: { fontSize: 14, fontWeight: 600, minWidth: 92 },
      badge: {
        fontSize: 12,
        background: 'rgba(128,128,128,.10)',
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 6,
        padding: '1px 7px',
      },
      reset: { marginLeft: 'auto', fontSize: 13, opacity: 0.7 },
      amount: { marginBottom: 6, fontSize: 12, opacity: 0.8 },
      track: { height: 8, borderRadius: 999, background: 'rgba(128,128,128,.22)', overflow: 'hidden' },
      hint: { fontSize: 13, lineHeight: 1.6, opacity: 0.8 },
      small: { fontSize: 12, lineHeight: 1.6, opacity: 0.55 },
      error: { fontSize: 13, lineHeight: 1.6, color: '#d05a4e' },
    }

    /** One label + bar + amount line. */
    function renderMeter(t, options) {
      const used = number(options.percent)
      const amount = options.amount
      return React.createElement(
        'div',
        { key: options.key, style: styles.row },
        React.createElement(
          'div',
          { style: styles.rowHead },
          React.createElement('span', { style: styles.windowLabel }, options.label),
          React.createElement(
            'span',
            {
              style: used === null ? styles.badge : { ...styles.badge, color: barColor(used), borderColor: barColor(used) },
            },
            used === null ? t('unavailableWindow') : `${percentText(used)}${t('usedSuffix')}`,
          ),
          options.resetText ? React.createElement('span', { style: styles.reset }, options.resetText) : null,
        ),
        amount ? React.createElement('div', { style: styles.amount }, amount) : null,
        React.createElement(
          'div',
          { style: styles.track },
          React.createElement('div', {
            style: {
              height: '100%',
              width: `${used === null ? 0 : used}%`,
              background: barColor(used),
              transition: 'width .3s ease',
            },
          }),
        ),
      )
    }

    /** Partner / plan line under the account name. */
    function subtitle(t, data) {
      const parts = []
      if (data.user && data.user.email) parts.push(data.user.email)
      if (data.org && data.org.name) parts.push(data.org.name)
      if (data.plan && data.plan.label) {
        const tail = data.plan.cancelAtPeriodEnd ? `${data.plan.label} · ${t('cancelling')}` : data.plan.label
        parts.push(`${t('planPrefix')}${tail}`)
      } else if (data.keyConfigured) {
        parts.push(t('noPlan'))
      }
      parts.push(data.apiKeyEnv)
      return parts.filter(Boolean).join(' · ')
    }

    /** The Settings section itself. */
    function UsageSection(props) {
      const t = props.t
      const state = props.useCommandcodeUsage((value) => value)
      const reload = props.reload
      const busy = props.useCommandcodeUsageBusy ? props.useCommandcodeUsageBusy((value) => value) : false
      const [, tick] = React.useState(0)

      // The countdowns are wall-clock facts: re-render them on their own cadence
      // instead of waiting for the next poll.
      React.useEffect(() => {
        const id = setInterval(() => tick((value) => value + 1), 30_000)
        return () => clearInterval(id)
      }, [])

      const now = Date.now()
      const body = []
      if (state.phase === 'loading') {
        body.push(React.createElement('p', { key: 'loading', style: styles.hint }, t('loading')))
      } else if (state.phase === 'unavailable') {
        body.push(React.createElement('p', { key: 'unavailable', style: styles.hint }, t('unavailable')))
      } else {
        const data = state.data || {}
        if (state.error) {
          body.push(React.createElement('p', { key: 'error', style: styles.error }, `${t('failed')}：${state.error}`))
        }
        if (!data.keyConfigured) {
          body.push(React.createElement('p', { key: 'empty', style: styles.hint }, t('noKey')))
        } else {
          const rows = []
          const windows = data.windows || {}
          const fiveHour = windows.fiveHour
          const weekly = windows.weekly
          if (fiveHour) {
            rows.push(
              renderMeter(t, {
                key: 'five-hour',
                label: t('fiveHour'),
                percent: fiveHour.percent,
                amount: `${money(fiveHour.used)} / ${money(fiveHour.cap)}`,
                resetText: resetText(t, fiveHour.resetAt, now),
              }),
            )
          } else if (windows) {
            rows.push(
              renderMeter(t, { key: 'five-hour', label: t('fiveHour'), percent: null, resetText: '' }),
            )
          }
          if (weekly) {
            rows.push(
              renderMeter(t, {
                key: 'weekly',
                label: t('weekly'),
                percent: weekly.percent,
                amount: `${money(weekly.used)} / ${money(weekly.cap)}`,
                resetText: resetText(t, weekly.resetAt, now),
              }),
            )
          } else if (windows) {
            rows.push(renderMeter(t, { key: 'weekly', label: t('weekly'), percent: null, resetText: '' }))
          }

          const credits = data.credits
          if (credits) {
            const extra = []
            if (credits.purchased) extra.push(`${t('purchased')} ${money(credits.purchased)}`)
            if (credits.free) extra.push(`${t('free')} ${money(credits.free)}`)
            const amount = [
              credits.granted !== null && credits.used !== null
                ? `${money(credits.used)} / ${money(credits.granted)}`
                : null,
              credits.remaining !== null ? `${t('remaining')} ${money(credits.remaining)}` : null,
              ...extra,
            ]
              .filter(Boolean)
              .join(' · ')
            rows.push(
              renderMeter(t, {
                key: 'monthly',
                label: t('monthly'),
                percent: credits.percent,
                amount,
                resetText: data.plan && data.plan.currentPeriodEnd
                  ? `${t('periodEnd')}${formatDate(data.plan.currentPeriodEnd)}`
                  : '',
              }),
            )
          }

          const sandbox = data.sandbox
          if (sandbox && number(sandbox.limitMinutes)) {
            rows.push(
              renderMeter(t, {
                key: 'sandbox',
                label: t('sandbox'),
                percent: number(sandbox.usedMinutes) !== null
                  ? Math.max(0, Math.min(100, (sandbox.usedMinutes / sandbox.limitMinutes) * 100))
                  : null,
                amount: `${sandbox.usedMinutes ?? 0}${t('minutes')} / ${sandbox.limitMinutes}${t('minutes')}`,
                resetText: resetText(t, sandbox.resetAt, now),
              }),
            )
          }

          body.push(
            React.createElement(
              'div',
              { key: 'account', style: styles.card },
              React.createElement(
                'div',
                { style: styles.cardHead },
                React.createElement(
                  'div',
                  null,
                  React.createElement(
                    'div',
                    { style: styles.cardTitle },
                    (data.user && (data.user.name || data.user.userName)) || 'Command Code',
                    data.plan && data.plan.label
                      ? React.createElement('span', { style: styles.planBadge }, data.plan.label)
                      : null,
                  ),
                  React.createElement('div', { style: styles.cardSub }, subtitle(t, data)),
                ),
                React.createElement(
                  'button',
                  { type: 'button', style: styles.button, onClick: reload, disabled: busy },
                  busy ? t('refreshing') : t('refresh'),
                ),
              ),
              ...rows,
            ),
          )

          if (data.usageUrl) {
            body.push(
              React.createElement('p', { key: 'web', style: styles.small }, `${t('webPage')}${data.usageUrl}`),
            )
          }
        }
        if (state.fetchedAt) {
          const at = new Date(state.fetchedAt)
          body.push(
            React.createElement('p', { key: 'stamp', style: styles.small }, `${t('updated')}${at.toLocaleTimeString()}`),
          )
        }
      }

      return React.createElement(
        'div',
        null,
        React.createElement('h2', { style: styles.head }, t('title')),
        React.createElement('p', { style: styles.intro }, t('intro')),
        ...body,
      )
    }

    /** `重置于 4h 19m` / `Resets in resetting now`. */
    function resetText(t, resetAt, now) {
      const remaining = countdown(resetAt, now)
      if (remaining === null) return ''
      if (remaining === '') return t('resetPending')
      return `${t('resetPrefix')}${remaining}`
    }

    /** `2026/11/22`-style local date for the billing period end. */
    function formatDate(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleDateString()
    }

    // ---------------------------------------------------------------- plugin ---

    const inject = ['slots', 'locale', 'remote', 'timer']

    async function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'commandcode-usage: dictionaries')

      const store = createStore()
      const busyStore = createStore()
      let namespace = null
      let disposed = false

      const setBusy = (busy) => busyStore.set(busy)

      const load = async (force) => {
        if (disposed) return
        if (!namespace) return
        setBusy(true)
        try {
          if (force) {
            try {
              unwrap(await namespace.refresh())
            } catch {
              /* the snapshot call below reports the same failure */
            }
          }
          // Always send the declared `request` parameter explicitly: the wire
          // descriptor expects one, and an absent JSON payload is not the same
          // as `{}`.
          const state = unwrap(await namespace.snapshot({ refresh: false }))
          if (disposed) return
          store.set({
            phase: 'ready',
            data: state || null,
            fetchedAt: (state && state.fetchedAt) || null,
            error: (state && state.error) || null,
          })
        } catch (error) {
          if (disposed) return
          store.set({ phase: 'error', data: null, fetchedAt: null, error: message(error) })
        } finally {
          setBusy(false)
        }
      }

      ctx.slots.inject(
        'settings.section',
        () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'commandcode-usage',
              order: 41,
              label: () => t('nav'),
              locale: NS,
              inject: () => ({
                hooks: { commandcodeUsage: store, commandcodeUsageBusy: busyStore },
                reload: () => {
                  void load(true)
                },
              }),
            },
            UsageSection,
          ),
      )

      let mountError = null
      try {
        await ctx.remote.$mount(TYPERT_REMOTE)
      } catch (error) {
        mountError = message(error)
        ctx.logger?.warn?.('commandcode-usage: failed to mount the %s Remote namespace: %o', SERVICE, error)
      }

      ctx.inject([`remote.${SERVICE}`], (child) => {
        namespace = child.remote[SERVICE]
        void load(false)
      })

      ctx.effect(() => ctx.interval(() => void load(false), 30_000), 'commandcode-usage: poll')

      ctx.effect(
        () =>
          ctx.timeout(() => {
            if (disposed || namespace) return
            store.set({
              phase: 'unavailable',
              data: null,
              fetchedAt: null,
              error: mountError,
            })
          }, 5000),
        'commandcode-usage: host-half grace period',
      )

      ctx.effect(
        () => () => {
          disposed = true
        },
        'commandcode-usage: disposal',
      )
    }

    exports.NS = NS
    exports.SERVICE = SERVICE
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
