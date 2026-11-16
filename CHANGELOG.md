# Changelog

All notable changes to this package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.2] - 2026-11-17
### Changed
- The contract states the way in one sentence instead of warning about a tool: "if the answer is
  asked for by voice, this document *is* the way — the host synthesizes it, no tool is needed".
  With `dsh-text-to-speech` no longer contributing a prompt section of its own, the warning had
  nothing left to warn about.

## [0.6.1] - 2026-11-17
### Fixed
- The contract now says what the tool section used to contradict: for a reply in a chat, do not
  call `voice_say` and do not show a file with `present` — the document *is* the voice note,
  the host synthesizes it. It also forbids narrating the tools used. A fresh session asked to
  answer aloud called `voice_say` + `present` and described the two steps instead of
  answering: the trigger phrase "when the person asks to hear an answer spoken" belonged to
  the text-to-speech section, and it read as the more direct instruction.

## [0.6.0] - 2026-11-17
### Changed
- **One signature: `🔊`.** The spoken part starts with the speaker symbol and nothing else
  counts — no `▶`, no aliases. Two `---` lines alone mean "a document", which is also what a
  YAML multi-document and any reply with two horizontal rules look like; the symbol is the
  difference between "shown" and "said out loud".
- **The debug switch is gone, with its code.** `speakReplies`, `firstParagraph()` and the
  `DSH_VOICE_SPEAK_REPLIES` escape hatch are removed: one way in, the markup, and one switch,
  mute. A marked reply is spoken by default.
- A reply may open with a Markdown quote (`>` lines) before the document; the quote is shown,
  never spoken, and no longer costs the answer its voice.
- The speaker symbol may sit right against the words (`🔊ответ`); a space, a dash or a colon
  after it is decoration and is never synthesized.
### Added
- A marked reply with no synthesizer on the Host logs why: `ответ размечен, но синтеза речи
  на хосте нет` with the service name. Silence that looks like "the feature is off" is not
  an answer.

## [0.5.0] - 2026-11-17
### Changed
- **The spoken part is marked with a play sign.** The document is `---`, then a line that
  starts with `▶` (also accepted: `▶️`, `▶︎`, `🔊`, `🔈`), then `---`. Two horizontal rules
  alone no longer mean "speak this": any answer that happened to start with a rule and
  contain another one was voiced by accident, and nothing in the message told the reader
  which part would be heard. Without the mark the answer travels as it is — `no-mark` in
  the log.
- **A marked answer is spoken by default.** The old switch meant "speak replies", which in
  practice meant "speak everything", and having it off silenced the whole feature. It is now
  the debug switch `speakReplies` — "speak every reply (debug mode)" — which speaks even an
  answer without the document, using its first paragraph (headings skipped, code fences
  dropped, cut at the limit).
### Added
- `mute` (volatile): "disable spoken replies". The markup stays in the answer and the plugin
  ignores it — one switch, no format change, for the person who wants silence right now.
- `firstParagraph()` in `structure.mjs`: what the debug mode speaks when the answer carries
  no document.

## [0.4.9] - 2026-11-17
### Fixed
- The switch's thumb follows the Host's rule pair: `--dsw-alias-label-primary-foreground`
  inside an enabled track and `--dsw-alias-switch-thumb` inside a disabled one. With a
  single colour the thumb stayed grey on a white track, which read as a third state next to
  the Host's own switches.

## [0.4.8] - 2026-11-17
### Changed
- The "speak replies" control is the Host's own switch, not a checkbox: the same
  `button[role=switch]` with a 16 px thumb in a 36×20 track, `--dsw-alias-brand-primary`
  when on and `--dsw-alias-border-l3` when off, with the label on the left and the control
  on the right like every other setting on the page. The component lives in
  `@deepseek-ai/dsh-web-frontend` and is not exported to plugin bundles, so the markup and
  the design tokens are reproduced here, and a test pins the control to `role="switch"`.
- The character limit is written as it is typed instead of on blur: a commit that waited
  carried whatever the field held when the focus left, which is how the stored limit moved
  on its own between page loads.

## [0.4.7] - 2026-11-17
### Fixed
- **The switch now actually reaches the plugin.** A field declared `.volatile()` is handed
  over by the Loader as a live accessor — `{ get(), [cosmokit.volatile.write]() }` — not as
  the value, and `config.speakReplies === true` was therefore always false. The card showed
  the switch on, the profile said `speakReplies: true`, and the prompt section said voicing
  was off: everyone was right except the comparison. Everything scalar (`speakReplies`,
  `maxChars`, `timeoutMs`, `settleMs`, `speed`, `subagents`, `prompt`, `description`) is now
  read through `unwrapVolatile`, an accessor that cannot answer counts as "unset", and two
  regression tests pin the accessor shape.

## [0.4.6] - 2026-11-17
### Added
- The effective "speak replies" switch is logged once at mount, with the raw value the
  Loader handed over, the value the plugin really uses, the config keys it saw and the
  emergency environment variable. `speakReplies` is a volatile field: its owner is the
  settings service, so a value written by hand into a profile can differ from the one the
  plugin reads — and without this line the difference is invisible from both sides.

## [0.4.5] - 2026-11-17
### Fixed
- The settings card can reach its own host route again. `ctx.connection.fetch.register`
  was called without `requestBody`, and the shared `/api` bridge classifies a request by
  that declared mode: an undeclared one falls through to the streaming branch, where a GET
  is handed a stream body and the browser gets an empty `400`. The card therefore always
  said "cannot tell whether speech synthesis is installed", which is the one fact that
  decides whether the switch may be pressed. The route now declares
  `requestBody: 'buffered'`, and a regression test states why the field is not boilerplate.
- Mounting the route is no longer silent: one `info` line when it is mounted, one `warn`
  naming the reason when the host has no `connection.fetch.register` or the mount throws.

## [0.4.4] - 2026-11-16

### Fixed
- A voice note declared at the closing turn now actually reaches the channel. `dsh-im`
  accepts `deliverables/presented` only while the turn is open, and everything expensive
  about that acceptance happens *after* the record lands: it copies the file into its own
  snapshot directory, digests it, and only then re-checks the turn
  (`semantic/artifact.mjs:493`, `:506`). The hook is the last thing before `turn/end`, so
  that copy always outlived the turn and was deleted silently — the record was in the log,
  the answer went out, no audio arrived, and nothing said why. The closing turn is now held
  until the channel's copy is on disk (plus a 50 ms grace for its digest and re-check), so
  the claim that happens after `turn/end` finds the file.

### Added
- `settleMs` (default `600`, ceiling `5000`) bounds that wait. A Host with no `dsh-im`
  pays only the probe's creation window: the snapshot directory is created lazily with the
  channel's first copy, and its absence is decided in 150 ms rather than by the whole budget.

### Changed
- `diagnose` is gone: waiting for the channel was a diagnostic while the reason was
  unknown, and it is part of the delivery now. `handoff` is reported in the `ответ озвучен`
  line on every spoken turn, and a record the channel did not take is logged as a warning
  instead of behind a switch. A profile that still sets `diagnose` keeps working — the Host
  passes unknown keys through — it simply has no effect.

## [0.4.3] - 2026-11-16

### Changed
- The voice note is named `voice-<uuid>.ogg`. A UUID starts with a hex digit about six
  times in ten, and a file whose name begins with a digit is the one shape a receiving
  side may refuse without saying why. Costs nothing, removes a variable.

## [0.4.2] - 2026-11-16

### Fixed
- The settings card is registered the way the working `@dr-co/dsh-graceful-restart` card is:
  `configForms.get('dsh-voice')` is read **once**, at mount, and the controller travels to the
  card as the `scope` prop, which the card subscribes to with `useSyncExternalStore`. The old
  registration handed the entry a `hooks.voiceSettings` face and looked the form up lazily per
  read — a shape this Host has no injection for, and a section that did not render.
- Every early return of the client entry, and the entry itself, now writes a `[dsh-voice]` line
  to the browser console naming the reason (no settings service, a throwing `configForms.get`,
  a controller without `getSnapshot`/`subscribe`, missing slots). A card that does not appear
  is a sentence in the console instead of an absence nobody can explain.

## [0.4.1] - 2026-11-16

### Added
- `DSH_VOICE_SPEAK_REPLIES=1` turns voicing on from the environment. The settings card is
  the way a person expects to flip the switch, but a Host whose client module never mounts
  leaves no way in at all, and a feature nobody can turn on is not a feature.

## [0.4.0] - 2026-11-16

### Changed
- The closing `...` marker is gone: two markers are the whole document. In YAML a `...`
  ends a document, which promises another one that never comes, while a third `---` says
  a new document starts — neither is what the answer means. Anything after the second
  marker is simply the part without sound.

### Fixed
- The contract asks for a blank line around each marker: markdown reads the line above
  `---` as a setext heading, and a rendered Telegram message showed the spoken part
  arriving as a large heading with the marker swallowed.

## [0.3.4] - 2026-11-16

### Fixed
- The contract now requires a blank line around every marker. Without it markdown reads
  the line above `---` as a setext heading: the spoken part arrived as a large heading and
  the marker itself disappeared, as a rendered Telegram message showed.

## [0.3.3] - 2026-11-16

### Fixed
- The client module declared a dependency on `@deepseek-ai/dsh-client-ui-plugin-manager`,
  which is not a client module of this Host: an unsatisfied dependency kept the module
  from activating, so the settings card never appeared. The working restart plugin
  declares only `@deepseek-ai/dsh-client-locale` and gets `configForms` anyway.

## [0.3.2] - 2026-11-16

### Fixed
- **The settings card is on the plugin's own page now.** It was registered only
  into `plugins.row.config`, which the Plugins page reaches through a configure
  control on the row — so with no control there was no card and the two settings
  were unreachable. The same card is now also registered into
  `plugins.bundle.config`, under the package name, and renders as a section of the
  plugin's page itself.
- **The card reads the settings service instead of the page's props.** A bundle
  page hands its entry no form at all, so the card could only say "the form is
  unavailable". It is registered with `configForms.get('dsh-voice')` — a live
  snapshot hook plus the write action — and still prefers an owner form when a row
  page passes one.
- The spoken-answer contract reached the model only with the switch on, so the format
  could not be written until someone found the switch — and the switch lives in a page
  the model cannot open. The contract is shown always now, and its own text says whether
  the answer will actually sound.

## [0.3.1] - 2026-11-16

### Fixed
- A volatile setting with no saved value arrives as an empty object, and the range
  check treated it as a bad number: the plugin then failed to mount, taking the
  whole voice loop down. It now reads as unset and falls back to the default.

## [0.3.0] - 2026-11-16

The host can now speak a text chat by itself, and the plugin it was meant to be
merged from — `@dr-co/dsh-voice-reply` — is gone: everything it did lives here,
under one switch.

### Added

- **The spoken reply of a closing turn.** An answer that wants to be heard is
  written as three markers — `---`, the spoken part, `---`, the rest, `...` — and
  the host synthesizes the first part into an OGG, attached to the turn as
  `deliverables/presented` from inside `agent/turn-stopping`, exactly as `present`
  does it. `structure.mjs` keeps the protocol, `reply.mjs` the delivery.
- **The switch and the limit are configuration**, editable live in Settings →
  Plugins → `@dr-co/dsh-voice`: `speakReplies` (default `false` — a new feature
  nobody asked for is off) and `maxChars` (default `600`, range `1..5000`, counted
  in characters, not bytes). Both are `.volatile()`, so the hook, the prompt
  section and the form all read the value of the moment.
- **A client half**: `src/client/` builds `lib/client.js` (`npm run build`) and
  registers the card into the Plugins page's `plugins.row.config` slot under the
  key `@dr-co/dsh-voice#dsh-voice`. Dictionaries in English, Russian and Chinese.
- **`GET /api/voice/state`** answers whether this Host has a synthesizer. Without
  one the switch is inactive and says "a synthesizer is needed" instead of
  storing a setting nothing can honour; a failed check leaves it inactive with a
  retry, never a guess.
- **A second prompt section**, contributed only while the switch is on: three
  markers, the configured limit, and the fact that a broken format means no
  sound. The `--- # say` contract of the device path is untouched and stays.

### Changed

- The Config schema is now declared (`settings.mjs`) and exported as
  `apply.Config`, so the Loader validates a profile and the settings service can
  project the two live fields. The plugin also tells the settings service that it
  draws its own page (`configure({auto: false})`), so a schema-generated form does
  not appear beside the card.
- A voice note is only made for a well-formed document: one marker, three
  markers, a missing `...`, an empty part, or a `---` with a trailing space all
  pass the message through as it is, without audio.
- The first part is synthesized verbatim: no markdown cleaning, no truncation.
  Longer than the limit means no sound at all.
- `diagnose` is off by default; the probe waits only when a profile asks for it.
- CI installs its dependencies: `@deepseek-ai/schemastery` is a peer of the host
  and `esbuild` builds the client half.

### Removed

- `@dr-co/dsh-voice-reply` as a separate package, together with its
  `trigger.mjs` — the regexes over the person's words (`ответь голосом`, `скажи
  вслух`, the refusals, the `plugin:dsh-voice` notice), the `mode`
  `request`/`always`/`off` setting, and the "first section up to a blank line"
  heuristic of `spoken.mjs`. The decision is the structure of the answer alone,
  which is the same in every language.

## [0.2.0] - 2026-11-16

The cache is no longer divided with another plugin: a recording is copied into our own directory,
and the voice loop works with the copy alone.

### Changed

Every item below breaks a host that relied on 0.1.x: a recording is no longer kept, the setting
that decided it is gone, exchanges are no longer serialised and a repeated `id` is no longer
deduplicated.

- **A copy instead of reading in place.** The path in `dsh-nodes/voice` still names a file under
  `<cacheDir>/incoming/`, but the loop no longer reads or keeps it: the file is copied to
  `<cacheDir>/work/<run>/<id>.wav`, the original is removed **right after the copy** — before
  recognition, so a crash in the middle of an exchange cannot leave another plugin's file on disk
  — and only the copy is read. The copy is removed as soon as it has been read. The pull path
  copies straight into `work/<run>/` with `files.copyFromDevice`; nothing is written into
  `incoming/` by this plugin any more.
- **The path guard is simpler.** It used to ask "is this inside this run's `incoming/<run>/<node>/`",
  and had to know both layouts. Now it asks one question: is the path inside `<cacheDir>/incoming/`,
  any layout below it. That is the whole boundary, because the file is ours to delete: the cache
  root (`sessions.json`), `out/` (the answers waiting for the device) and a host file reached
  through a symlink are still refused whole with `reason=refused-path`. A copy needs no check at
  all — it is our own file.
- **`keepRecording` is gone, with everything that implemented it.** No `last`, no `none`, no
  `pruneRecordings`, no thinning of the node directories by age, no "keep the newest take". The
  setting is removed from the config, from `index.mjs` and from the README. In its place the loop
  sweeps its own trees — `work/` and `out/` — at start and then once a day, removing every file
  older than an hour and the directories it leaves empty. That is insurance against a crash in
  the middle of an exchange and nothing else: there is no retention window, and a recording can
  no longer be listened to afterwards.
- **The queue is gone.** Two exchanges on one device no longer serialise: `enqueue` is removed
  from both paths, and with it the per-node chain map. **The order of answers is no longer
  guaranteed** — a slow turn does not hold the next one, and two answers may arrive in either
  order. The owner accepted this: waiting behind a turn that can take three minutes was worse.
- **Deduplication is gone.** No `seen`, no `inFlight`, no `rememberId`, no `SEEN_LIMIT`, and no
  `already` status: a repeat of the same `id` is simply a second exchange. When the link is
  flaky the model answers twice or does not answer at all, and both are accepted — a retry
  swallowed as "already answered" loses the person's words.

### Unchanged

- the session and its binding (`sessions.json`), and creating a new session;
- the transcript reaching the device as `voice.chat` with `role: user` **before** the model's
  answer;
- `markup.mjs` reply parsing, synthesis, the single `voice.answer` command, `degraded`;
- the trace and its stages;
- every refusal said out loud: no recording, no recognizer, a timeout, a session that could not
  be created;
- the `out/` sweep of orphaned answers.

## [0.1.23] - 2026-11-16

### Fixed
- The cleanup of a used recording asks the same question as the receiving path — both layouts,
  `matchNodeSegment`'s rule — and prunes the directory the file is really in. `dsh-nodes` writes
  `<incoming>/<node>/`, the loop writes `<incoming>/<run>/<node>/`, and the single-layout guard
  refused the first: with `keepRecording: none` the take stayed on disk, `last` never pruned its
  directory, and every upload logged a false "refusing to touch a file outside the voice cache".
- The boot cleanup measures age on the files, not on the run directory above them. A take updates
  `<node>/` and nothing higher up, so a run directory older than an hour was removed whole
  together with a recording written a minute ago; now every file older than an hour goes, the
  directories it leaves empty follow, and a fresh file inside an old run stays.
- The deduplication key of an upload is the node number, not its name: `${node}:${id}`. A name is
  edited by hand and two devices may carry the same one; keyed by the name, the words of the
  second device were answered `already` instead of being delivered.
- An exchange that passes its deadline now speaks: "Ответ не пришёл — слишком долго. Попробуйте
  короче." goes to the device, and the closing trace line carries `said=timeout`. Three minutes of
  silence were indistinguishable from a dead button.
- The README describes both upload layouts and who creates each, and states that the leftovers of
  a finished run are cleaned by the age of the files, not by the age of its directory.

## [0.1.22] - 2026-11-16

### Fixed
- The upload guard accepts the layout `dsh-nodes` really writes (`incoming/<node>/`) as well
  as our own per-run one (`incoming/<run>/<node>/`). The host that writes the file does not
  know the voice loop's run id, and requiring it sent every recording to `refused-path`.

## [0.1.21] - 2026-11-16

### Changed

- The cache is laid out per run. Recordings go to `<cacheDir>/incoming/<run>/<node>/<id>.<ext>`
  and rendered answers to `<cacheDir>/out/<run>/<id>.ogg`, where `<run>` is `<pid>-<six hex>`,
  made once when the loop is built (the `runId` option overrides it). The pid alone is not
  identity — the kernel reuses the number, and a directory left by an earlier process with that
  number looked like this one's own. Now a file on disk belongs to a named run, and both paths
  (upload and pull) agree on where it lives.
- The path guard is `<cacheDir>/incoming/<run>/<node>/`. A recording of another run is refused
  with `reason=refused-path` even under the same node name; the node **number** and the node
  **name** are still both accepted as the segment, as in 0.1.20.
- A boot removes what earlier runs left behind, and it trusts age alone: everything under
  `incoming/` and `out/` older than an hour goes — subdirectories and stray files alike, the old
  `<node>/` layout included — while the directories of the current run are never touched,
  however old they look. Age, not ownership, because a second process may share the cache and a
  file may still be read or downloaded: "everything that is not mine" would delete live work of
  a neighbour. A leftover younger than an hour is picked up by the next boot or by the daily
  sweep, which stays as the insurance policy for a process that lives for weeks.
- **`keepRecording` now works inside one run.** `last` leaves the newest take in
  `incoming/<run>/<node>/` and `none` leaves nothing, but the directory of a finished run is a
  leftover: once it is an hour old the next boot removes it whole, so after a restart the
  previous recording can no longer be listened to. That is the conscious price of naming the
  directories after the run, and it buys a cache where nothing has to be guessed by age.

## [0.1.20] - 2026-11-16

### Changed
- The node **number** is the directory key on both paths. It is an auto-increment id: it never
  changes and it is unique, while a name can be edited and two devices may share one. The
  pull path used to write under the name, so the two paths disagreed; the name remains only
  as a reading fallback for recordings written by older versions.

## [0.1.19] - 2026-11-16

### Fixed
- A recording is accepted when it lives in the directory named after the node **number**
  (that is what `dsh-nodes` writes) as well as after the node name. The 0.1.18 guard
  checked only the name and refused every real recording with `refused-path`.
- Pruning uses the directory that actually holds the file, so `keepRecording` still works
  for the number-named directory.

## [0.1.18] - 2026-11-16

A recording path is now checked against the filesystem, not against a string:
three boundary defects of the 0.1.17 path guard, one of them a way to read a
host file into the recognizer.

### Fixed

- A recording path is checked with `realpathSync`, not with a lexical `resolve`:
  a symlink inside `incoming/` that pointed at `/etc/shadow` passed the old
  check and the recognizer was handed the target's bytes. A path that does not
  exist yet is resolved through its nearest existing ancestor, and a path that
  cannot be resolved at all (a symlink loop, a permission wall) is refused.
- The guard now asks for `<cacheDir>/incoming/<node>/`, not for "under the
  cache": the cache root holds `sessions.json` and `out/` holds the answers
  waiting for the device, and an event naming `cacheDir/evil.wav` was accepted,
  delivered, and then pruned "its" directory — the node → session bindings were
  gone. A path outside the node's own upload directory is answered
  `refused-path`, and the file is left alone.
- A retry of a recording that is still in flight no longer deletes the file the
  running exchange is reading. The push path names the file
  `<cacheDir>/incoming/<node>/<id>.wav`, so a retry of one id writes the same
  path: the duplicate branch removed exactly that file, and with
  `keepRecording: last` a normally retried take disappeared. A synchronous
  double delivery ended the first exchange as `empty` for the same reason.
  `inFlight` now remembers the path, and only a different file is dropped.

## [0.1.17] - 2026-11-16

The first published release. The history below is the whole of it: the package
grew in the open and every line of it was a separate decision.

### Added

- The voice markup: a `--- # voice` block carries a transcript in, `--- # say`
  and `--- # screen` carry what must be spoken and what only shown. `splitReply`
  and `readVoiceMarkup` are usable without the plugin (`@dr-co/dsh-voice/markup`).
- The input marker is lifted out of a claimed user message at `agent/pre-step`
  and recorded as its own `plugin:dsh-voice` context message beside the user's
  words; a message marked only in its `source` gets the notice without rewriting.
- The reply contract: one system-prompt section (`dsh-voice:reply-contract`,
  order 119) with the rules for a spoken answer.
- The voice loop: a press on the device becomes a recording, a transcript, a
  delivered turn, a watched answer and a line the phone speaks.
- The push path: a device uploads its own recording and the loop answers it
  without asking for anything (`dsh-nodes/voice`).
- One answer command, `voice.answer`, carrying the line and the host's audio
  together, so the file has a live ticket for the download route; `voice.chat`
  carries both sides of the exchange to the device screen, `voice.activity`
  counts the model's tool calls while the answer is being built.
- `synth=device|host`: the phone reads the answer with its own engine, or the
  host synthesizes it, converts it to OGG/Opus at the configured tempo and hands
  the file over. A failed or absent synthesis degrades to the device voice and
  says so in the message (`degraded`) and in the closing trace line.
- The assistant's name and icon travel with the answer, read once per exchange
  from the `assistants` service.
- A stage trace for every exchange: one line per stage with milliseconds, and
  exactly one closing line with the deltas and the reason.
- `keepRecording: last|none` — the newest take of every node is kept so "what
  did it actually hear" can be listened to, or every take is removed once used.
  A sweep removes recordings older than 24 hours at boot and once a day.
- A warmup for the synthesizer when the voice screen opens, debounced to one per
  node per minute.
- Bug reports from the device are injected into the node's session as a fact,
  never spoken.
- `voice-new-session`: the device forgets its conversation; a running exchange
  is left to finish, and the binding is dropped after it.
- Recognition is asked for a named language (`language`, `ru` by default) and a
  take shorter than `minSeconds` never reaches it.

### Fixed

- A recording path from an event is checked against the voice cache before it is
  read or removed: `keepRecording: none` could otherwise unlink a file anywhere
  on the host, and `last` could prune somebody else's directory.
- The loop no longer refuses to start over a missing synthesizer: `textToSpeech`
  is read lazily, and `synth=host` on a host without it degrades to the device
  voice. A missing recognizer is named to the person instead of staying silent.
- Every refused recording is said out loud, not only a timeout: permission
  denials, cancelled takes, a `status: ok` without a path and a rejected
  `voice.record` or `copyFromDevice` all end with a sentence and a closing line.
- A session that cannot be created is said out loud and closes the exchange with
  `reason=no-session`, on both the push and the pull path.
- A recording id is reserved when the event is accepted, so two copies of one
  recording arriving during the same exchange no longer become two answers; the
  reservation is released on failure, because the client re-sends the id.
- The per-node queue and warmup maps no longer grow with every device ever seen:
  a queue entry is dropped when nothing waits behind it, and a warmup entry
  expires with the debounce window.
- `keepRecording` is honoured on the pull path as well as the push path.
- Orphaned rendered answers in `cache/voice/out` are swept, not left forever.
- `ctx.inject(['systemPrompt'])` is guarded, so a host whose prompt service
  cannot be declared still gets the marker lifted and the loop running.
- A device that cannot be reached no longer turns a report into a crash.
