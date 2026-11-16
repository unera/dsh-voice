window.__ModuleLoader__.load({
  id: "@dr-co/dsh-voice",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  BUNDLE_SECTION_KEY: () => BUNDLE_SECTION_KEY,
  DICTIONARIES: () => DICTIONARIES,
  ENTRY: () => ENTRY,
  LIMIT_DEFAULT: () => LIMIT_DEFAULT,
  LIMIT_FIELD: () => LIMIT_FIELD,
  LIMIT_MAX: () => LIMIT_MAX,
  LIMIT_MIN: () => LIMIT_MIN,
  MUTE_FIELD: () => MUTE_FIELD,
  NS: () => NS,
  PACKAGE: () => PACKAGE,
  SECTION_KEY: () => SECTION_KEY,
  SECTION_ORDER: () => SECTION_ORDER,
  SETTINGS_NAMESPACE: () => SETTINGS_NAMESPACE,
  VoiceSettingsPage: () => VoiceSettingsPage,
  VoiceSettingsView: () => VoiceSettingsView,
  apply: () => apply,
  availabilityOf: () => availabilityOf,
  availabilityText: () => availabilityText,
  formFromProps: () => formFromProps,
  format: () => format,
  inject: () => inject,
  limitDraft: () => limitDraft,
  parseLimit: () => parseLimit,
  readValues: () => readValues,
  summaryLine: () => summaryLine,
  switchDisabled: () => switchDisabled
});
module.exports = __toCommonJS(index_exports);

// src/client/card.js
var import_react = require("react");

// src/client/api.js
var BASE = "/api/voice";
async function getState() {
  const response = await fetch(`${BASE}/state`, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    cache: "no-store"
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = new Error(parsed?.error ?? `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return parsed ?? {};
}

// src/client/model.js
var MUTE_FIELD = "mute";
var LIMIT_FIELD = "maxChars";
var LIMIT_MIN = 1;
var LIMIT_MAX = 5e3;
var LIMIT_DEFAULT = 600;
function format(t, key, vars = {}) {
  const text = typeof t === "function" ? t(key) : key;
  return String(text).replace(/\{(\w+)\}/gu, (whole, name) => name in vars ? String(vars[name]) : whole);
}
function readValues(form) {
  const state = form?.state ?? null;
  const value = state?.value ?? null;
  const status = typeof state?.status === "string" ? state.status : "loading";
  const raw = Number(value?.[LIMIT_FIELD]);
  const maxChars = Number.isInteger(raw) && raw >= LIMIT_MIN && raw <= LIMIT_MAX ? raw : LIMIT_DEFAULT;
  return {
    status,
    writable: state?.writable === true,
    known: status === "ready",
    mute: value?.[MUTE_FIELD] === true,
    maxChars
  };
}
function formFromProps(props, snapshot) {
  const owner = props?.form;
  if (owner !== null && typeof owner === "object" && typeof owner.mutate === "function") return owner;
  const scope = props?.scope;
  if (typeof scope?.mutate !== "function" || snapshot === void 0 || snapshot === null) return null;
  return { state: snapshot, mutate: (ops, revision) => scope.mutate(ops, revision) };
}
function limitDraft(maxChars) {
  return String(maxChars);
}
function parseLimit(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return { ok: false, code: "empty" };
  if (!/^\d+$/u.test(trimmed)) return { ok: false, code: "not-integer" };
  const value = Number(trimmed);
  if (value < LIMIT_MIN || value > LIMIT_MAX) return { ok: false, code: "range" };
  return { ok: true, value };
}
function availabilityOf(answer) {
  if (answer === null || answer === void 0) return { known: false, canSpeak: false, code: "checking" };
  if (answer.error !== void 0 && answer.error !== null) return { known: false, canSpeak: false, code: "failed" };
  const ready = answer.textToSpeech === true;
  return { known: true, canSpeak: ready, code: ready ? "ok" : "no-synth" };
}
function summaryLine(t, values) {
  if (!values.known) return typeof t === "function" ? t("summary.unknown") : "summary.unknown";
  if (values.mute) return t("summary.muted");
  return format(t, "summary.on", { limit: values.maxChars });
}
function switchDisabled(values, answer) {
  return !values.writable || !availabilityOf(answer).canSpeak;
}
function availabilityText(t, availability) {
  if (availability.code === "ok") return "";
  if (availability.code === "no-synth") return t("availability.noSynth");
  if (availability.code === "failed") return t("availability.failed");
  return t("availability.checking");
}

// src/client/card.js
var styles = {
  box: { padding: "4px 0 8px" },
  title: { margin: "0 0 6px", fontSize: 15 },
  intro: { opacity: 0.75, margin: "0 0 12px", lineHeight: 1.5 },
  row: { display: "flex", alignItems: "center", gap: 8, margin: "10px 0 4px" },
  field: { display: "flex", flexDirection: "column", gap: 4, maxWidth: 260 },
  hint: { opacity: 0.7, fontSize: 12, lineHeight: 1.45, margin: "2px 0 0" },
  warn: { color: "#c9863a", fontSize: 12, lineHeight: 1.45, margin: "4px 0 0" },
  error: { color: "#d05a4e", fontSize: 12, margin: "6px 0 0" },
  input: { padding: "5px 7px", width: 110 },
  retry: { padding: "2px 8px", cursor: "pointer", fontSize: 12 },
  // A setting of the page, drawn the way the Host draws its own: the label on the
  // left, the control on the right, the explanation under both.
  setting: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, margin: "10px 0 4px" },
  settingLabel: { lineHeight: 1.4 }
};
function Switch({ checked, disabled = false, label = "", onChange }) {
  return (0, import_react.createElement)("button", {
    type: "button",
    role: "switch",
    "aria-checked": checked === true,
    "aria-label": label,
    title: label,
    disabled,
    onClick: () => onChange?.(checked !== true),
    style: {
      boxSizing: "border-box",
      position: "relative",
      flex: "0 0 auto",
      display: "inline-flex",
      alignItems: "center",
      width: 36,
      height: 20,
      padding: 2,
      border: 0,
      borderRadius: 999,
      background: checked === true ? "var(--dsw-alias-brand-primary, #4c6ef5)" : "var(--dsw-alias-border-l3, #4a4a4a)",
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.5 : 1,
      transition: "background .12s ease"
    }
  }, (0, import_react.createElement)("span", {
    key: "thumb",
    style: {
      display: "block",
      width: 16,
      height: 16,
      borderRadius: "50%",
      // The track is the brand colour when on and a border tone when off; the
      // thumb flips with it — a foreground tone inside an enabled track, a muted
      // one inside a disabled one. Copied from the Host's own rule pair.
      background: checked === true ? "var(--dsw-alias-label-primary-foreground, #0f1115)" : "var(--dsw-alias-switch-thumb, #adb2b8)",
      transition: "transform .12s ease",
      transform: checked === true ? "translateX(16px)" : "none"
    }
  }));
}
function useAvailability() {
  const [answer, setAnswer] = (0, import_react.useState)(null);
  const [attempt, setAttempt] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    let live = true;
    setAnswer(null);
    getState().then(
      (state) => {
        if (live) setAnswer(state);
      },
      (error) => {
        if (live) setAnswer({ error: String(error?.message ?? error) });
      }
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  return [answer, () => setAttempt((count) => count + 1)];
}
function useScopeSnapshot(scope) {
  const subscribe = (0, import_react.useMemo)(
    () => typeof scope?.subscribe === "function" ? (listener) => scope.subscribe(listener) : () => {
    },
    [scope]
  );
  const read = (0, import_react.useCallback)(
    () => typeof scope?.getSnapshot === "function" ? scope.getSnapshot() : null,
    [scope]
  );
  return (0, import_react.useSyncExternalStore)(subscribe, read, read);
}
function VoiceSettingsView(props) {
  const view = props?.view === "summary" ? "summary" : "page";
  const t = typeof props?.t === "function" ? props.t : (key) => key;
  const snapshot = useScopeSnapshot(props?.scope);
  const form = formFromProps(props, snapshot);
  const values = readValues(form);
  if (view === "summary") return (0, import_react.createElement)("span", null, summaryLine(t, values));
  return (0, import_react.createElement)(VoiceSettingsPage, { t, form, values });
}
function VoiceSettingsPage({ t, form, values }) {
  const [draft, setDraft] = (0, import_react.useState)(() => limitDraft(values.maxChars));
  const [error, setError] = (0, import_react.useState)("");
  const [availability, retry] = useAvailability();
  const status = availabilityOf(availability);
  const [touched, setTouched] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    if (!touched) setDraft(limitDraft(values.maxChars));
  }, [values.maxChars, touched]);
  if (!form || !values.known) {
    return (0, import_react.createElement)("p", { style: styles.hint }, t("form.unavailable"));
  }
  const write = async (ops) => {
    setError("");
    try {
      const accepted = await form.mutate(ops);
      if (!accepted) setError(t("write.refused"));
      return accepted;
    } catch (problem) {
      setError(String(problem?.message ?? problem));
      return false;
    }
  };
  const toggleMute = (next) => {
    void write([{ op: "set", path: [MUTE_FIELD], value: next === true }]);
  };
  const commitLimit = () => {
    const parsed = parseLimit(draft);
    if (!parsed.ok) {
      setError(t("limit.invalid"));
      return;
    }
    if (parsed.value === values.maxChars) {
      setError("");
      return;
    }
    void write([{ op: "set", path: [LIMIT_FIELD], value: parsed.value }]);
  };
  return (0, import_react.createElement)("div", { style: styles.box }, [
    (0, import_react.createElement)("h3", { style: styles.title, key: "title" }, t("title")),
    (0, import_react.createElement)("p", { style: styles.intro, key: "intro" }, t("intro")),
    // The switch a person reaches for: silence, with the markup left alone.
    (0, import_react.createElement)("div", { style: styles.setting, key: "mute" }, [
      (0, import_react.createElement)("span", { style: styles.settingLabel, key: "label" }, t("mute.label")),
      (0, import_react.createElement)(Switch, {
        key: "switch",
        checked: values.mute,
        disabled: switchDisabled(values, availability),
        label: t("mute.label"),
        onChange: toggleMute
      })
    ]),
    (0, import_react.createElement)("p", { style: styles.hint, key: "muteHint" }, t("mute.hint")),
    status.code === "ok" ? null : (0, import_react.createElement)("p", { style: styles.warn, key: "availability" }, [
      availabilityText(t, status),
      status.code === "failed" || status.code === "no-synth" ? (0, import_react.createElement)("button", { style: { ...styles.retry, marginLeft: 8 }, onClick: retry, key: "retry" }, t("availability.retry")) : null
    ]),
    (0, import_react.createElement)("label", { style: { ...styles.field, marginTop: 12 }, key: "limit" }, [
      (0, import_react.createElement)("span", null, t("limit.label")),
      (0, import_react.createElement)("input", {
        type: "number",
        style: styles.input,
        min: LIMIT_MIN,
        max: LIMIT_MAX,
        step: 1,
        value: draft,
        disabled: !values.writable,
        key: "input",
        onChange: (event) => {
          const raw = event.target.value;
          setTouched(true);
          setDraft(raw);
          const parsed = parseLimit(raw);
          if (parsed.ok && parsed.value !== values.maxChars) {
            void write([{ op: "set", path: [LIMIT_FIELD], value: parsed.value }]);
          }
        },
        onBlur: commitLimit,
        onKeyDown: (event) => {
          if (event.key === "Enter") commitLimit();
        }
      })
    ]),
    (0, import_react.createElement)("p", { style: styles.hint, key: "limitHint" }, t("limit.hint")),
    error === "" ? null : (0, import_react.createElement)("p", { style: styles.error, key: "error" }, error)
  ]);
}

// src/client/locales.js
var NS = "dsh-voice";
var en = {
  "title": "Spoken replies",
  "intro": "A reply marked with \u{1F50A} in its first part is spoken: the host synthesizes it into an OGG voice note and attaches it to the answer, so a chat that carries files sends it beside the text.",
  "mute.label": "Disable spoken replies",
  "mute.hint": "The markup stays in the answer and the plugin ignores it: no synthesis, no sound. With this off, a marked reply is spoken.",
  "limit.label": "Characters to speak",
  "limit.hint": "Between 1 and 5000. A longer first part means no sound at all \u2014 it is never cut short.",
  "limit.invalid": "A whole number from 1 to 5000 is needed here",
  "availability.checking": "Checking for a speech synthesizer\u2026",
  "availability.noSynth": "A synthesizer is needed: there is nothing to speak with yet. Install a speech provider (for example @dr-co/dsh-text-to-speech) and check again.",
  "availability.failed": "Could not find out whether a synthesizer is installed",
  "availability.retry": "Check again",
  "summary.muted": "Spoken replies are disabled",
  "summary.muted": "\u041E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u043D\u0438\u0435 \u043E\u0442\u0432\u0435\u0442\u043E\u0432 \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u043E",
  "summary.off": "replies are not spoken",
  "summary.on": "replies are spoken, up to {limit} characters",
  "summary.unknown": "spoken replies: the switch cannot be read",
  "write.refused": "The host did not accept the value",
  "form.unavailable": "This configuration cannot be read here"
};
var ru = {
  "title": "\u041E\u0437\u0432\u0443\u0447\u043A\u0430 \u043E\u0442\u0432\u0435\u0442\u043E\u0432",
  "intro": "\u041E\u0442\u0432\u0435\u0442, \u0443 \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E \u043F\u0435\u0440\u0432\u0430\u044F \u0447\u0430\u0441\u0442\u044C \u043F\u043E\u043C\u0435\u0447\u0435\u043D\u0430 \u0437\u043D\u0430\u0447\u043A\u043E\u043C \u{1F50A}, \u043E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F: \u0445\u043E\u0441\u0442 \u0441\u0438\u043D\u0442\u0435\u0437\u0438\u0440\u0443\u0435\u0442 \u0435\u0451 \u0432 \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 OGG \u0438 \u043F\u0440\u0438\u043A\u043B\u0430\u0434\u044B\u0432\u0430\u0435\u0442 \u043A \u043E\u0442\u0432\u0435\u0442\u0443, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u043A\u0430\u043D\u0430\u043B, \u043A\u043E\u0442\u043E\u0440\u044B\u0439 \u0443\u043C\u0435\u0435\u0442 \u043F\u0435\u0440\u0435\u0434\u0430\u0432\u0430\u0442\u044C \u0444\u0430\u0439\u043B\u044B, \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442 \u0435\u0451 \u0440\u044F\u0434\u043E\u043C \u0441 \u0442\u0435\u043A\u0441\u0442\u043E\u043C.",
  "mute.label": "\u041E\u0442\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u043E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u043D\u0438\u0435 \u043E\u0442\u0432\u0435\u0442\u043E\u0432",
  "mute.hint": "\u0420\u0430\u0437\u043C\u0435\u0442\u043A\u0430 \u043E\u0441\u0442\u0430\u0451\u0442\u0441\u044F \u0432 \u043E\u0442\u0432\u0435\u0442\u0435, \u043F\u043B\u0430\u0433\u0438\u043D \u0435\u0451 \u0438\u0433\u043D\u043E\u0440\u0438\u0440\u0443\u0435\u0442: \u043D\u0438 \u0441\u0438\u043D\u0442\u0435\u0437\u0430, \u043D\u0438 \u0437\u0432\u0443\u043A\u0430. \u041A\u043E\u0433\u0434\u0430 \u0433\u0430\u043B\u043A\u0430 \u0441\u043D\u044F\u0442\u0430, \u0440\u0430\u0437\u043C\u0435\u0447\u0435\u043D\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442 \u043E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F.",
  "limit.label": "\u0421\u043A\u043E\u043B\u044C\u043A\u043E \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432 \u043E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u0442\u044C",
  "limit.hint": "\u041E\u0442 1 \u0434\u043E 5000. \u0411\u043E\u043B\u0435\u0435 \u0434\u043B\u0438\u043D\u043D\u0430\u044F \u043F\u0435\u0440\u0432\u0430\u044F \u0447\u0430\u0441\u0442\u044C \u043D\u0435 \u043E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0432\u043E\u0432\u0441\u0435 \u2014 \u043E\u043D\u0430 \u043D\u0438\u043A\u043E\u0433\u0434\u0430 \u043D\u0435 \u043E\u0431\u0440\u0435\u0437\u0430\u0435\u0442\u0441\u044F.",
  "limit.invalid": "\u0417\u0434\u0435\u0441\u044C \u043D\u0443\u0436\u043D\u043E \u0446\u0435\u043B\u043E\u0435 \u0447\u0438\u0441\u043B\u043E \u043E\u0442 1 \u0434\u043E 5000",
  "availability.checking": "\u041F\u0440\u043E\u0432\u0435\u0440\u044F\u044E, \u0435\u0441\u0442\u044C \u043B\u0438 \u0441\u0438\u043D\u0442\u0435\u0437 \u0440\u0435\u0447\u0438\u2026",
  "availability.noSynth": "\u041D\u0443\u0436\u0435\u043D \u0441\u0438\u043D\u0442\u0435\u0437 \u0440\u0435\u0447\u0438: \u043E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u0442\u044C \u043F\u043E\u043A\u0430 \u043D\u0435\u0447\u0435\u043C. \u0423\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u0435 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430 \u0441\u0438\u043D\u0442\u0435\u0437\u0430 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, @dr-co/dsh-text-to-speech) \u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0441\u043D\u043E\u0432\u0430.",
  "availability.failed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0443\u0437\u043D\u0430\u0442\u044C, \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D \u043B\u0438 \u0441\u0438\u043D\u0442\u0435\u0437 \u0440\u0435\u0447\u0438",
  "availability.retry": "\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u0441\u043D\u043E\u0432\u0430",
  "summary.muted": "Spoken replies are disabled",
  "summary.muted": "\u041E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u043D\u0438\u0435 \u043E\u0442\u0432\u0435\u0442\u043E\u0432 \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u043E",
  "summary.off": "\u043E\u0442\u0432\u0435\u0442\u044B \u043D\u0435 \u043E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u044E\u0442\u0441\u044F",
  "summary.on": "\u043E\u0442\u0432\u0435\u0442\u044B \u043E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u044E\u0442\u0441\u044F, \u0434\u043E {limit} \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432",
  "summary.unknown": "\u043E\u0437\u0432\u0443\u0447\u043A\u0430 \u043E\u0442\u0432\u0435\u0442\u043E\u0432: \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0430\u0442\u0435\u043B\u044C \u043D\u0435 \u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F",
  "write.refused": "\u0425\u043E\u0441\u0442 \u043D\u0435 \u043F\u0440\u0438\u043D\u044F\u043B \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435",
  "form.unavailable": "\u042D\u0442\u0443 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0443 \u0437\u0434\u0435\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u043D\u0435\u043B\u044C\u0437\u044F"
};
var zh = {
  "summary.muted": "\u8BED\u97F3\u56DE\u590D\u5DF2\u5173\u95ED",
  "title": "\u8BED\u97F3\u56DE\u590D",
  "intro": "\u4E3B\u673A\u53EF\u4EE5\u628A\u56DE\u590D\u7684\u7B2C\u4E00\u90E8\u5206\u5408\u6210 OGG \u8BED\u97F3\uFF0C\u5E76\u4F5C\u4E3A\u9644\u4EF6\u968F\u56DE\u590D\u4E00\u8D77\u53D1\u9001\uFF0C\u56E0\u6B64\u652F\u6301\u6587\u4EF6\u7684\u9891\u9053\u4F1A\u5728\u6587\u5B57\u65C1\u53D1\u9001\u5B83\u3002",
  "mute.label": "\u5173\u95ED\u8BED\u97F3\u56DE\u590D",
  "mute.hint": "\u6807\u8BB0\u4FDD\u7559\u5728\u56DE\u590D\u4E2D\uFF0C\u63D2\u4EF6\u5FFD\u7565\u5B83\uFF1A\u4E0D\u5408\u6210\uFF0C\u4E5F\u6CA1\u6709\u58F0\u97F3\u3002\u53D6\u6D88\u52FE\u9009\u540E\uFF0C\u5E26\u6807\u8BB0\u7684\u56DE\u590D\u4F1A\u88AB\u6717\u8BFB\u3002",
  "limit.label": "\u6717\u8BFB\u5B57\u7B26\u6570",
  "limit.hint": "\u4ECE 1 \u5230 5000\u3002\u66F4\u957F\u7684\u7B2C\u4E00\u90E8\u5206\u5B8C\u5168\u4E0D\u6717\u8BFB\u2014\u2014\u5B83\u4E0D\u4F1A\u88AB\u622A\u65AD\u3002",
  "limit.invalid": "\u8FD9\u91CC\u9700\u8981 1 \u5230 5000 \u7684\u6574\u6570",
  "availability.checking": "\u6B63\u5728\u68C0\u67E5\u8BED\u97F3\u5408\u6210\u2026",
  "availability.noSynth": "\u9700\u8981\u8BED\u97F3\u5408\u6210\uFF1A\u76EE\u524D\u6CA1\u6709\u53EF\u7528\u7684\u5408\u6210\u5668\u3002\u8BF7\u5B89\u88C5\u8BED\u97F3\u63D0\u4F9B\u65B9\uFF08\u4F8B\u5982 @dr-co/dsh-text-to-speech\uFF09\u540E\u91CD\u8BD5\u3002",
  "availability.failed": "\u65E0\u6CD5\u786E\u8BA4\u662F\u5426\u5B89\u88C5\u4E86\u8BED\u97F3\u5408\u6210",
  "availability.retry": "\u91CD\u65B0\u68C0\u67E5",
  "summary.muted": "Spoken replies are disabled",
  "summary.muted": "\u041E\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u043D\u0438\u0435 \u043E\u0442\u0432\u0435\u0442\u043E\u0432 \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u043E",
  "summary.off": "\u4E0D\u6717\u8BFB\u56DE\u590D",
  "summary.on": "\u6717\u8BFB\u56DE\u590D\uFF0C\u6700\u591A {limit} \u4E2A\u5B57\u7B26",
  "summary.unknown": "\u8BED\u97F3\u56DE\u590D\uFF1A\u65E0\u6CD5\u8BFB\u53D6\u5F00\u5173",
  "write.refused": "\u4E3B\u673A\u6CA1\u6709\u63A5\u53D7\u8FD9\u4E2A\u503C",
  "form.unavailable": "\u6B64\u5904\u65E0\u6CD5\u8BFB\u53D6\u8BE5\u8BBE\u7F6E"
};
var DICTIONARIES = { en, ru, zh };

// src/client/index.js
var PACKAGE = "@dr-co/dsh-voice";
var ENTRY = "dsh-voice";
var SETTINGS_NAMESPACE = ENTRY;
var SECTION_KEY = `${PACKAGE}#${ENTRY}`;
var BUNDLE_SECTION_KEY = PACKAGE;
var SECTION_ORDER = 40;
var PLACEMENTS = [
  ["plugins.bundle.config", BUNDLE_SECTION_KEY],
  ["plugins.row.config", SECTION_KEY]
];
function say(message, detail) {
  console.warn(`[dsh-voice] ${message}`, ...detail === void 0 ? [] : [detail]);
}
var inject = ["slots", "locale", "configForms"];
function safeMount(ctx, label, run) {
  try {
    run();
    return true;
  } catch (error) {
    say(`${label} \u043D\u0435 \u0441\u043C\u043E\u043D\u0442\u0438\u0440\u043E\u0432\u0430\u043D: ${error?.message ?? error}`);
    return false;
  }
}
function readScope(ctx) {
  let scope = null;
  try {
    scope = ctx.configForms.get(ENTRY);
  } catch (error) {
    say(`configForms.get('${ENTRY}') \u0443\u043F\u0430\u043B: ${error?.message ?? error}`);
    return null;
  }
  if (!scope) {
    say(`configForms.get('${ENTRY}') \u0432\u0435\u0440\u043D\u0443\u043B \u043F\u0443\u0441\u0442\u043E: \u0444\u043E\u0440\u043C\u0430 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043A \u044D\u0442\u043E\u0433\u043E \u043F\u043B\u0430\u0433\u0438\u043D\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430`);
    return null;
  }
  const missing = ["getSnapshot", "subscribe"].filter((name) => typeof scope[name] !== "function");
  if (missing.length > 0) {
    say(`\u0444\u043E\u0440\u043C\u0430 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043A '${ENTRY}' \u043D\u0435 \u0433\u043E\u0434\u0438\u0442\u0441\u044F \u0432 \u0441\u0442\u043E\u0440: \u043D\u0435\u0442 ${missing.join(", ")}`);
    return null;
  }
  return scope;
}
function apply(ctx) {
  say("client apply: \u0441\u0442\u0430\u0440\u0442", {
    package: PACKAGE,
    entry: ENTRY,
    services: ["slots", "locale", "configForms"].filter((name) => ctx?.[name] !== void 0)
  });
  let t = (key) => key;
  try {
    t = ctx.locale.bind(NS);
  } catch (error) {
    say(`locale \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430, \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u044E \u043A\u043B\u044E\u0447\u0438: ${error?.message ?? error}`);
  }
  safeMount(ctx, "dictionaries", () => {
    ctx.effect(() => {
      ctx.locale.register(NS, "en", DICTIONARIES.en);
      ctx.locale.register(NS, "ru", DICTIONARIES.ru);
      ctx.locale.register(NS, "zh", DICTIONARIES.zh);
      return () => {
      };
    }, "dsh-voice: dictionaries");
  });
  for (const [id, label] of [["ru", "\u0420\u0443\u0441\u0441\u043A\u0438\u0439"], ["zh", "\u4E2D\u6587"]]) {
    safeMount(ctx, `${id} language`, () => {
      ctx.effect(() => {
        try {
          return ctx.locale.addLanguage({ id, label, fallback: "en" });
        } catch (error) {
          if (!/already/i.test(String(error?.message ?? error))) throw error;
          return () => {
          };
        }
      }, `dsh-voice: ${id} language`);
    });
  }
  if (typeof ctx?.slots?.inject !== "function" || typeof ctx.slots.register !== "function") {
    say("\u0441\u043B\u043E\u0442\u044B \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B: ctx.slots.inject/register \u043E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0443\u044E\u0442, \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u043D\u0435 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u0430");
    return;
  }
  const scope = readScope(ctx);
  if (!scope) return;
  for (const [name, key] of PLACEMENTS) {
    safeMount(ctx, name, () => {
      ctx.slots.inject(
        name,
        () => ctx.slots.register(
          {
            name,
            key,
            order: SECTION_ORDER,
            // Without `locale` the host does not inject `t` and the card draws keys.
            locale: NS,
            label: () => t("title"),
            // The store travels as one prop, read once above: the card owns no
            // path back to the settings service and cannot ask for a form twice.
            inject: () => ({ t, scope })
          },
          VoiceSettingsView
        )
      );
      say(`\u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u0430: ${name} key=${key}`);
    });
  }
}

    return module.exports;
  }
});
