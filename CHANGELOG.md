# Changelog

All notable changes to this package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
