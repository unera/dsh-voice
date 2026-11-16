// The settings card of the spoken reply.
//
// Two controls, and both read their state from the Host rather than from a local
// copy: the switch and the limit are volatile configuration, so the Plugins page
// hands this card the form it already owns and a write goes through the settings
// service. What the card adds is a question the browser cannot answer by itself —
// is there a synthesizer on this Host — because a switch that stores a setting
// nothing can honour is worse than a switch that explains itself.
//
// The pure functions below are the card's behaviour and are tested directly; the
// components are a thin paint over them.

import { createElement as h, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { getState } from './api.js'
import {
  LIMIT_FIELD, LIMIT_MAX, LIMIT_MIN, LIMIT_DEFAULT, MUTE_FIELD,
  availabilityOf, availabilityText, formFromProps, format, limitDraft, parseLimit, readValues, summaryLine,
  switchDisabled,
} from './model.js'

export {
  LIMIT_FIELD, LIMIT_MAX, LIMIT_MIN, LIMIT_DEFAULT, MUTE_FIELD,
  availabilityOf, availabilityText, formFromProps, format, limitDraft, parseLimit, readValues, summaryLine,
  switchDisabled,
}

/** A field label and its control, in the page's own styling. */
const styles = {
  box: { padding: '4px 0 8px' },
  title: { margin: '0 0 6px', fontSize: 15 },
  intro: { opacity: 0.75, margin: '0 0 12px', lineHeight: 1.5 },
  row: { display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 4px' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 260 },
  hint: { opacity: 0.7, fontSize: 12, lineHeight: 1.45, margin: '2px 0 0' },
  warn: { color: '#c9863a', fontSize: 12, lineHeight: 1.45, margin: '4px 0 0' },
  error: { color: '#d05a4e', fontSize: 12, margin: '6px 0 0' },
  input: { padding: '5px 7px', width: 110 },
  retry: { padding: '2px 8px', cursor: 'pointer', fontSize: 12 },
  // A setting of the page, drawn the way the Host draws its own: the label on the
  // left, the control on the right, the explanation under both.
  setting: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '10px 0 4px' },
  settingLabel: { lineHeight: 1.4 },
}

/**
 * The Host's own switch, rebuilt rather than imitated.
 *
 * `@deepseek-ai/dsh-web-frontend` draws every toggle as
 * `<button role="switch" aria-checked><span class=thumb>` — 36×20, two pixels of
 * padding, a 16 px thumb sliding 16 px, `--dsw-alias-brand-primary` when on and
 * `--dsw-alias-border-l3` when off. The component itself is not exported to
 * plugin bundles, so the markup and the geometry are copied here, token for
 * token: a page with one native switch and one checkbox beside it looks like two
 * different products, and the checkbox is the one that looks wrong.
 *
 * @param props.checked - whether the switch is on.
 * @param props.disabled - when the Host cannot honour the setting at all.
 * @param props.label - accessible name; the visible label sits beside it.
 * @param props.onChange - called with the next state.
 * @returns the switch element.
 */
export function Switch ({ checked, disabled = false, label = '', onChange }) {
  return h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked === true,
    'aria-label': label,
    title: label,
    disabled,
    onClick: () => onChange?.(checked !== true),
    style: {
      boxSizing: 'border-box',
      position: 'relative',
      flex: '0 0 auto',
      display: 'inline-flex',
      alignItems: 'center',
      width: 36,
      height: 20,
      padding: 2,
      border: 0,
      borderRadius: 999,
      background: checked === true
        ? 'var(--dsw-alias-brand-primary, #4c6ef5)'
        : 'var(--dsw-alias-border-l3, #4a4a4a)',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'background .12s ease',
    },
  }, h('span', {
    key: 'thumb',
    style: {
      display: 'block',
      width: 16,
      height: 16,
      borderRadius: '50%',
      // The track is the brand colour when on and a border tone when off; the
      // thumb flips with it — a foreground tone inside an enabled track, a muted
      // one inside a disabled one. Copied from the Host's own rule pair.
      background: checked === true
        ? 'var(--dsw-alias-label-primary-foreground, #0f1115)'
        : 'var(--dsw-alias-switch-thumb, #adb2b8)',
      transition: 'transform .12s ease',
      transform: checked === true ? 'translateX(16px)' : 'none',
    },
  }))
}

/** Read the host's answer once, and on demand again. */
function useAvailability () {
  const [answer, setAnswer] = useState(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setAnswer(null)
    getState().then(
      (state) => { if (live) setAnswer(state) },
      (error) => { if (live) setAnswer({ error: String(error?.message ?? error) }) },
    )
    return () => { live = false }
  }, [attempt])
  return [answer, () => setAttempt((count) => count + 1)]
}

/**
 * The settings snapshot of the form this card was handed.
 *
 * One subscription for the whole card, through the store the entry was registered
 * with: `useSyncExternalStore` is what makes a value written elsewhere — another
 * page, another tab — reach this card without a reload. A card without a store
 * still renders (the row page may hand its own form instead); it then reads the
 * one snapshot its path gets and subscribes to nothing.
 *
 * @param scope - the settings controller, or undefined.
 * @returns the current snapshot, or null.
 */
function useScopeSnapshot (scope) {
  const subscribe = useMemo(
    () => (typeof scope?.subscribe === 'function' ? (listener) => scope.subscribe(listener) : () => {}),
    [scope],
  )
  const read = useCallback(
    () => (typeof scope?.getSnapshot === 'function' ? scope.getSnapshot() : null),
    [scope],
  )
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * The card.
 *
 * @param props - `{view, t, scope}` from the entry's own `inject` face, plus the
 *   owner `{state, mutate}` a row page hands over.
 * @returns the summary or the page, or the "form unavailable" line when this host
 *   offers nothing to write.
 */
export function VoiceSettingsView (props) {
  const view = props?.view === 'summary' ? 'summary' : 'page'
  const t = typeof props?.t === 'function' ? props.t : (key) => key
  // Called unconditionally: a hook that appears only on some renders changes the
  // hook order between them, and React fails the whole subtree.
  const snapshot = useScopeSnapshot(props?.scope)
  const form = formFromProps(props, snapshot)
  const values = readValues(form)

  if (view === 'summary') return h('span', null, summaryLine(t, values))

  return h(VoiceSettingsPage, { t, form, values })
}

/** The page view: switch, limit, and the reason the switch may be inactive. */
export function VoiceSettingsPage ({ t, form, values }) {
  const [draft, setDraft] = useState(() => limitDraft(values.maxChars))
  const [error, setError] = useState('')
  const [availability, retry] = useAvailability()
  const status = availabilityOf(availability)

  // The Host is the source of truth: a value it accepted (or one another page
  // wrote) replaces the draft, unless the person is in the middle of typing one.
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched) setDraft(limitDraft(values.maxChars))
  }, [values.maxChars, touched])

  if (!form || !values.known) {
    return h('p', { style: styles.hint }, t('form.unavailable'))
  }

  const write = async (ops) => {
    setError('')
    try {
      const accepted = await form.mutate(ops)
      if (!accepted) setError(t('write.refused'))
      return accepted
    } catch (problem) {
      setError(String(problem?.message ?? problem))
      return false
    }
  }

  const toggleMute = (next) => {
    void write([{ op: 'set', path: [MUTE_FIELD], value: next === true }])
  }

  const commitLimit = () => {
    const parsed = parseLimit(draft)
    if (!parsed.ok) {
      setError(t('limit.invalid'))
      return
    }
    if (parsed.value === values.maxChars) {
      setError('')
      return
    }
    void write([{ op: 'set', path: [LIMIT_FIELD], value: parsed.value }])
  }

  return h('div', { style: styles.box }, [
    h('h3', { style: styles.title, key: 'title' }, t('title')),
    h('p', { style: styles.intro, key: 'intro' }, t('intro')),
    // The switch a person reaches for: silence, with the markup left alone.
    h('div', { style: styles.setting, key: 'mute' }, [
      h('span', { style: styles.settingLabel, key: 'label' }, t('mute.label')),
      h(Switch, {
        key: 'switch',
        checked: values.mute,
        disabled: switchDisabled(values, availability),
        label: t('mute.label'),
        onChange: toggleMute,
      }),
    ]),
    h('p', { style: styles.hint, key: 'muteHint' }, t('mute.hint')),
    status.code === 'ok'
      ? null
      : h('p', { style: styles.warn, key: 'availability' }, [
        availabilityText(t, status),
        status.code === 'failed' || status.code === 'no-synth'
          ? h('button', { style: { ...styles.retry, marginLeft: 8 }, onClick: retry, key: 'retry' }, t('availability.retry'))
          : null,
      ]),
    h('label', { style: { ...styles.field, marginTop: 12 }, key: 'limit' }, [
      h('span', null, t('limit.label')),
      h('input', {
        type: 'number',
        style: styles.input,
        min: LIMIT_MIN,
        max: LIMIT_MAX,
        step: 1,
        value: draft,
        disabled: !values.writable,
        key: 'input',
        onChange: (event) => {
          const raw = event.target.value
          setTouched(true)
          setDraft(raw)
          // The Host is the source of truth and the field is a draft over it: a
          // commit that waits for blur can carry a value the person already
          // replaced. A valid number typed here is written at once; an invalid one
          // waits for the error the commit path reports.
          const parsed = parseLimit(raw)
          if (parsed.ok && parsed.value !== values.maxChars) {
            void write([{ op: 'set', path: [LIMIT_FIELD], value: parsed.value }])
          }
        },
        onBlur: commitLimit,
        onKeyDown: (event) => { if (event.key === 'Enter') commitLimit() },
      }),
    ]),
    h('p', { style: styles.hint, key: 'limitHint' }, t('limit.hint')),
    error === '' ? null : h('p', { style: styles.error, key: 'error' }, error),
  ])
}
