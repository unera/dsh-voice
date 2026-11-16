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

import { createElement as h, useEffect, useState } from 'react'

import { getState } from './api.js'
import {
  LIMIT_FIELD, LIMIT_MAX, LIMIT_MIN, LIMIT_DEFAULT, SPEAK_FIELD,
  availabilityOf, availabilityText, format, limitDraft, parseLimit, readValues, summaryLine, switchDisabled,
} from './model.js'

export {
  LIMIT_FIELD, LIMIT_MAX, LIMIT_MIN, LIMIT_DEFAULT, SPEAK_FIELD,
  availabilityOf, availabilityText, format, limitDraft, parseLimit, readValues, summaryLine, switchDisabled,
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
 * The card.
 *
 * @param props - `{view, form, t}` from the Plugins page.
 * @returns the summary or the page, or null when the page has nothing to show.
 */
export function VoiceSettingsView (props) {
  const view = props?.view === 'summary' ? 'summary' : 'page'
  const t = typeof props?.t === 'function' ? props.t : (key) => key
  const form = props?.form ?? null
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

  const toggle = (event) => {
    const next = event?.target?.checked === true
    void write([{ op: 'set', path: [SPEAK_FIELD], value: next }])
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
    h('label', { style: styles.row, key: 'speak' }, [
      h('input', {
        type: 'checkbox',
        key: 'box',
        checked: values.speakReplies,
        disabled: switchDisabled(values, availability),
        onChange: toggle,
      }),
      h('span', null, t('speak.label')),
    ]),
    h('p', { style: styles.hint, key: 'speakHint' }, t('speak.hint')),
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
        onChange: (event) => { setTouched(true); setDraft(event.target.value) },
        onBlur: commitLimit,
        onKeyDown: (event) => { if (event.key === 'Enter') commitLimit() },
      }),
    ]),
    h('p', { style: styles.hint, key: 'limitHint' }, t('limit.hint')),
    error === '' ? null : h('p', { style: styles.error, key: 'error' }, error),
  ])
}
