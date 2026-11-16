# Changelog

All notable changes to this package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
