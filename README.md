# @dr-co/dsh-voice

A spoken turn for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a press on a node becomes a recording, the recording becomes a transcript, and
the answer comes back to the phone as one chat message that carries both the
line to show and the speech to play.

Five things live here, and the package ships all of them:

| part | what it does |
|---|---|
| the marker | `--- # voice` in, `--- # say`/`--- # screen` out, read by `splitReply()` |
| the loop | record → transcribe → deliver → watch the turn → answer the device |
| the prompt section | how a spoken answer is written, and what it may not contain |
| the trace | one log line per stage of every exchange, one closing line with the reason |
| the spoken reply | a switch in the Plugins page: the host synthesizes the part of a text-chat answer written between three markers and attaches the OGG to the turn |

The device commands the answer travels by are `voice.chat` (`{role, text, speak,
say, who, degraded}`) for the screen and `voice.answer` (`{id, text, speak, who,
seconds, path}`) when the host is the one speaking. `voice.say`/`voice.play` are
not the main path: `voice.say` is what the loop uses to say one short sentence on
the device when a press produced nothing to answer.

## Requirements

| what | why | needed for |
|---|---|---|
| Node.js 22+ | `node --test`, and the `engines` field says so | everything |
| `dsh-nodes` with the `voice` API | the device side of every command | everything |
| a `speechToText` service | nothing can be transcribed without it | answering words |
| `ffmpeg` on `PATH` | the host converts the provider's WAV to OGG/Opus (`libopus`) and applies the playback tempo with `atempo` | `synth=host` only |
| a `textToSpeech` service | the host voice | `synth=host` only |

Neither service is declared in `inject`: a Host may have none (no synthesizer is
the normal case for `synth=device`, the default) and a provider may register
after this plugin. Both are read at the moment they are needed, so a missing one
degrades instead of keeping the chat dead:

- no recognizer — a press is answered in words ("не могу распознать речь: нет
  сервиса распознавания") and the closing line says `reason=no-stt`;
- no synthesizer — `synth=host` falls back to the device engine, the message
  carries `degraded: {kind: "tts-failed"}`, and the closing line says
  `reason=tts-failed`.

`npm test` also needs `ffmpeg`: five tests run the real binary for the host-audio
path, so a green run means that path works. CI installs it explicitly.

## Install

`dsh plugin` forwards its arguments to `pnpm` inside the profile directory, so a
local directory and a registry name are the same command with a different target.

```sh
# from a local checkout: pnpm links the directory, so the profile runs this copy
dsh plugin --profile <profile> add /path/to/dsh-voice

# once the package is on npm — nothing else changes
dsh plugin --profile <profile> add @dr-co/dsh-voice
```

The package is not published yet; the second form starts working the moment it
is, with the same row and the same code.

The package ships `dsh.bundle.patch`, so the row mounts itself:

```yaml
- insert:
    - id: dsh-voice
      name: '@dr-co/dsh-voice'
```

## Configuration

| key | default | what it changes |
|---|---|---|
| `cacheDir` | `$DSH_HOME/cache/voice` (`./.dsh/cache/voice` without `DSH_HOME`) | where recordings wait, where rendered answers wait for the device, and where `sessions.json` keeps the node → session bindings |
| `language` | `ru` | the language the recognizer is asked for. Named, not inherited from the Host default: `auto` lets a short noisy take drift into another language, and the transcript then reaches the session as the person's own words |
| `minSeconds` | `0.4` | below this a take is a button click, not speech: it never reaches the recognizer, the session is untouched, and the closing line says `reason=too-short` |
| `runId` | `<pid>-<six hex>` | the directory name this process owns inside the cache, made once at boot. Normally left out: a host that sets it gets a stable name, and a test gets one it can predict. Anything unusable as one path segment is replaced, and an empty value gets a fresh id |
| `speakReplies` | `false` | **the switch of the spoken reply**, editable live in Settings → Plugins → `@dr-co/dsh-voice`. Off means a closing turn does nothing at all — no synthesis, no file, and no prompt section telling the model about the format |
| `maxChars` | `600` | how many **characters** the spoken part may have, editable live beside the switch. The range is `1..5000`: anything else is a configuration error, and the plugin refuses to mount rather than clamp the number to something the owner did not ask for |
| `timeoutMs` | `20000` | how long a slow engine may hold the closing turn. A timeout costs the voice note, never the answer |
| `speed` | the service's own | playback tempo for the attached voice note, `0.5..2`, applied with ffmpeg's `atempo` |
| `description` | `Озвучка ответа` | the line the Web client shows beside the file |
| `subagents` | `false` | whether subagent turns are spoken too |
| `prompt` | `true` | whether the format is explained to the model while the switch is on |
| `diagnose` | `false` | wait for `dsh-im` to take the record and say in the log whether it did; costs part of the closing turn, so it is opt-in |

### Where things live: two plugins, two directories

The cache is shared with `dsh-nodes`, and since 0.2.0 the two never write into the same directory.
A recording is copied in, and from then on only the copy is read: the original belongs to
`dsh-nodes` and is deleted the moment the copy exists.

Every run of the loop owns one name: `<pid>-<six hex>`, made once when the loop is built (the
`runId` option overrides it; a test uses its own). Everything the loop writes goes under it, so
the files of two processes sharing a `cacheDir` never mix:

| who writes | where | who removes it, and when |
|---|---|---|
| `dsh-nodes` | `<cacheDir>/incoming/<any layout>/<id>.wav` — the device uploads it and names the directory after the node number or its name | the voice loop, **immediately after copying it** |
| `dsh-voice` | `<cacheDir>/work/<run>/<id>.wav` — our copy, named after the exchange id | the voice loop, **right after it has been read** by the recognizer |
| `dsh-voice` | `<cacheDir>/out/<run>/<id>.ogg` — a rendered answer waiting for the device | the device, once it has fetched it (a two-minute guard covers one that never does) |
| `dsh-voice` | `<cacheDir>/sessions.json` — the node → session bindings | nobody; a boot never touches it |

The copy is the point of the split. The event carries a path inside `incoming/`, and that is the
only thing checked about it: the file is ours to read once and to delete, so it has to be
`dsh-nodes`' file and nothing else — not the cache root with `sessions.json`, not `out/` with the
answers waiting for the device, not a host file reached through a symlink. What our own copy is
called, where it sits, and how long it lives is nobody else's business, and it is checked by
nothing.

A boot sweeps `work/` and `out/`, at start and then once a day:

- every file older than an hour goes, and the directories it leaves empty go with it;
- nothing below `incoming/` is swept: that tree is `dsh-nodes`, not ours;
- the hour is the age of the file itself, never of the directory above it: a fresh copy can sit
  in a run directory that looks hours old.

A copy lives for the second it takes to transcribe, and an answer for the two minutes the device
gets to fetch it, so a file of an hour is the leftover of a crash in the middle of an exchange.
That is the whole insurance policy: there is no retention window, no "keep the last take" and no
setting for one. A boot cannot tell a kept recording from litter because there is nothing kept.

## Who speaks

`synth=device` (default) means the phone reads the text with its own engine — the host does no
synthesis at all. `synth=host` means the answer must sound like our voice: the host synthesizes,
converts the provider's WAV to OGG/Opus with the configured tempo, and hands the file to
`voice.answer`; the device fetches it by the command it answers, and the file is removed once it
has.

Neither call is awaited: speaking takes as long as the sentence, and nothing waits behind it.
`voice.stop` is what cuts a speech short. When a host synthesis fails the loop
falls back to the device engine and closes the line with `reason=tts-failed`.

## Spoken replies in a text chat

The device path above needs a press. A text chat has no press, so the host speaks
when the answer itself says it wants to be heard — and that is the whole decision.
Nothing reads the person's words: there is no list of "reply aloud" phrases in any
language here, and nothing to translate.

### The protocol

An answer that wants to be heard is written as three markers:

```text
---
текст для голоса
---
текст без звука
...
```

| line | meaning |
|---|---|
| the first non-empty line | `---`, the document opens |
| above the next `---` | the spoken part, spoken verbatim |
| exactly one more `---` | the separator |
| below it, up to `...` | the text that is only read |
| the last non-empty line | `...`, the document closes |

### The four rules

| rule | what the plugin does |
|---|---|
| the answer is the documented document | the first part is synthesized and the OGG is declared on the turn |
| the answer is anything else — no markers, one marker, a third `---`, no `...`, an empty part, a `---` with a trailing space | the message is passed through **as is**: no audio, no change |
| the first part is longer than `maxChars` **characters** | the same: as is, no audio, and the log says `too-long` |
| otherwise | the first part goes to the synthesizer and the OGG is attached |

Nothing is guessed. `--- ` with a trailing space, `----`, `--- # say`, a word above
the first marker: each is a deviation, and a deviation means silence. The length is
counted in characters (`[...text].length`), so a Cyrillic letter and an emoji count
as one each — a 600-character Russian answer is 1200 bytes and still fits.

The answer text is never touched: the markers stay in the message and the person
reads them. The plugin appends a record, nothing else.

### How the audio travels

The audio takes the road `present` takes: inside `agent/turn-stopping` — the turn is
still open, which is the only moment `dsh-im` accepts a presented file and the last
moment the answer text is known — the OGG is written and
`deliverables/presented` is appended with a non-empty `callId` and `description`.
Every surface that already carries files delivers it: `dsh-im` uploads a voice
note, the Web client lists the file under the answer.

Files live in `<cacheDir>/reply` — `$DSH_HOME/cache/voice/reply` by default, a
sibling of the loop's `work/` and `out/` rather than one of them, because the
loop's sweep collects those two and knows nothing about these — and a run prunes
its own files after a day. A turn that already carries a voice note — ours from an
earlier stop, or one the model attached with `voice_say` — is never spoken twice.

### Where the switch lives

Settings → **Plugins** → `@dr-co/dsh-voice` → its row. The page is a client plugin
(`lib/client.js`, built by `npm run build`), registered into the Plugins page's
`plugins.row.config` slot under the key `@dr-co/dsh-voice#dsh-voice`.

| control | behaviour |
|---|---|
| "Speak replies" | off by default. Volatile configuration: the turn-stopping hook and the prompt section read it at every turn, so flipping it works on the next answer, not on the next restart |
| "Characters to speak" | `600` by default, `1..5000`, written on blur or Enter. It is the same number the prompt tells the model and the same number the plugin enforces |
| no synthesizer | the switch is **inactive** and says so: "a synthesizer is needed". The card reads that from `GET /api/voice/state`, mounted on the Host's authenticated `/api` channel — a switch that stores a setting nothing can honour is worse than one that explains itself |
| the check failed | the switch stays inactive with "could not find out" and a retry button; it never guesses in either direction |

The two editable fields are the only `.volatile()` fields in the Config schema; the
rest is ordinary profile configuration, read at boot. Because the plugin draws
this page itself, it also tells the settings service so
(`ctx.settings.configure({ auto: false }, ctx.fiber)`): a schema-generated form
next to the card would be a second, poorer copy of the same two fields.

### Two reply formats, two transports

The formats do not fight, because they answer different questions:

| question | format | who speaks |
|---|---|---|
| a request arrived by voice, the phone should answer aloud | `--- # say` / `--- # screen` | the device, or the host for `synth=host` |
| a text answer should arrive as a voice note in the chat | `---` / `---` / `...` | the host, and the file is the message |

The first section belongs to the loop and is registered always; the second one is
contributed only while `speakReplies` is on, so a Host with the switch off never
tells the model about a format it would not act on.

## The screen sees both sides

The answer no longer travels as a `voice.say`/`voice.play` command: it is one chat message that
carries the speech, and the device queues it itself.

```
voice.chat     {role: "user",      text: "<transcript>",         id: "<exchange id>"}
voice.chat     {role: "assistant", text: "<# screen or # say>",  id: "<exchange id>",
                speak: "<the # say part>", say: true|false,
                who?: {name: "Кеша", icon: "🦜"}}
voice.answer   {id, text, speak, who, seconds, path}               ← only for synth=host
voice.activity {n, name, id}
```

`who` is the assistant's name and icon from the `assistants` service, read once per exchange; it is
absent when that plugin is not installed or nobody is assigned, and never set on the person's own
line.

`text` is what to show, `speak` is what to say: the screen may want the `# screen` block while the
voice must say exactly the `# say` part. Reading the screen text aloud was how a command dump got
spoken instead of the answer. `say: true` means "the device engine should read this"; it is `false`
on the host path (the speech travels separately) and when `# say` is empty.

`synth=host` sends one command that carries both halves: `voice.answer {id, text, speak, who,
seconds, path}`. The device downloads the OGG by that command's own `seq` — a chat message closes
the moment it is shown, and `/v1/download-file` needs an issued, unsettled command — then answers
`{"status":"ok","payload":{"queued":true}}` and plays from its own queue. The host waits for
nothing but that acknowledgement, and removes the file after it, with a two-minute guard.

While the model works, every tool call in its message becomes one `voice.activity`, numbered from
one inside the exchange and reset on the next press: `bash`, `web_search`, `nodes_call` — the name
the model used.

None of these is awaited: a screen that is off, a build without `voice.chat`, a device that does
not answer — one warning line, and the answer still goes out. If the synthesis
fails, the answer still goes out with `say: true` and no audio, and the closing line says
`reason=tts-failed`.

A wait can no longer stick: any `turn/end` clears it (`cancelled` and `error` close silently),
`session/disposed` clears it, and a deadline of three minutes releases the node with
`reason=timeout`.

## Waking the model before the first word

Opening the voice screen sends `{"type":"voice-warmup"}`, which reaches the loop as
`dsh-nodes/voice-warmup` and calls the synthesizer's `warmup()` — the model starts its worker
while the person is still deciding what to say. A host with no synthesizer closes the stage with
`warmup=no-service` and nothing else happens. Nothing else happens: no session, no exchange, no
line on the screen, nothing spoken.

The warmup is debounced to one per node per minute — entering, leaving and entering again is not a
reason to wake the model twice — and only nodes that declare the `voice` API are warmed at all. A
failure is a warning: a cold model costs a slow first answer, a broken warmup must cost nothing.

The model still sleeps after ten idle minutes (`idleTimeoutMs`, 600000 by default).

## When the voice degrades

A failed synthesis is not hidden: the answer still goes out, spoken by the device engine, and the
message carries

```json
"degraded": { "kind": "tts-failed", "message": "silero provider has been stopped" }
```

so the screen can show it. The closing trace line says `reason=tts-failed` as before.

The device can also report a degradation itself:
`{"type":"bug-report","id":"ex-1","kind":"tts-failed","text":"…","app":"0.10.41"}` reaches
`dsh-nodes/bug-report`, and the loop injects it into the node's session as a fact:

```
отчёт с устройства: синтез речи не удался
обмен: ex-1
приложение: 0.10.41
ошибка: silero provider has been stopped
```

with `source: {kind: 'dsh-nodes', bugReport: true}`. It is injected rather than followed up, so an
idle session is not woken, and nothing is spoken — it is a fact for the host, not a person talking.

## Where the time goes

Every exchange writes one line per stage it reached, milliseconds counted from the moment the
event arrived, and exactly one closing line with the deltas:

```
[dsh-voice] exchange take-1 node=A059P stage=received ms=0
[dsh-voice] exchange take-1 node=A059P stage=transcribed ms=312
[dsh-voice] exchange take-1 node=A059P stage=delivered ms=340
[dsh-voice] exchange take-1 node=A059P stage=turn-start ms=351 turn=7
[dsh-voice] exchange take-1 node=A059P stage=turn-end ms=4120 reason=completed
[dsh-voice] exchange take-1 node=A059P stage=split ms=4122 speakChars=68
[dsh-voice] exchange take-1 node=A059P stage=synthesized ms=5030 seconds=6.8
[dsh-voice] exchange take-1 node=A059P stage=answered ms=5310 via=voice.answer
[dsh-voice] exchange take-1 node=A059P done total=5310ms
            segments={record: 4800, upload: 180, stt: 312, model: 3769, tts: 908}
```

`record` and `upload` come from the device (`x-record-start/-stop`, `x-sent-at` against the
server's `receivedAt`); a segment that never happened is absent from the line, not a zero. A
failed exchange closes with its own reason: `empty`, `no-stt`, `no-recording`, `no-copy`,
`no-session`, `silent`, `too-short`, `refused-path`, `timeout`, `disposed`, `tts-failed`.

## A new conversation on demand

`{"type":"voice","action":"new-session"}` from the device means "forget this conversation". The
loop drops the node's binding in `sessions.json`, so the next input creates a fresh session, and it
says nothing — the person started it themselves.

A reset never interrupts a running exchange: if the answer to the sentence they already spoke is
still being prepared, the binding is dropped when that exchange ends. Losing words someone has
already said would be worse than a conversation that lives one answer longer.

## Language and silence

The recognizer is asked for a named language (`language`, `ru` by default), not for whatever the
host default happens to be: a Host left on `auto` decodes a 0.2-second cough into whatever its
model drifts to — a Japanese sentence once reached a session as the person's own words. A provider
that refuses the language is a warning and a fallback to the service default, never a lost
recording.

A take shorter than `minSeconds` (0.4 by default) is not speech at all: the session is untouched,
the device is told nothing, and the closing line says `reason=too-short`. The copy is removed like
any other — nothing is kept for listening afterwards.

Both facts are visible in the trace: `stage=stt-request provider=… language=…`, and `language=…`
in the closing line.

## Two ways a recording arrives

The push path is the main one; the pull path is kept while the clients migrate.

| path | who starts it | what the loop calls |
|---|---|---|
| push | the device records and uploads | nothing — the file is already at `event.path` |
| pull (older clients) | the host asks after `voice.want` | `voice.record` → `files.copyFromDevice` |

`dsh-nodes/voice` carries `{node, nodeName, id, path, bytes, seconds}`. The loop copies the file
to `work/<run>/<id>.wav`, removes the original, and from then on reads only the copy.

Nothing is deduplicated. The same `id` sent twice is two exchanges: when the link is flaky the
model answers twice, or does not answer at all, and both are accepted — a retry swallowed as
"already answered" loses the person's words, which is the worse failure. There is no `seen` map,
no reservation and no `already` status to look for.

`path` has to be inside `<cacheDir>/incoming/`, and that is all that is checked about it:

| accepted | refused |
|---|---|
| `<cacheDir>/incoming/<node>/<id>` — what `dsh-nodes` writes | the cache root, with `sessions.json` |
| `<cacheDir>/incoming/<run>/<node>/<id>` — the older per-run layout | `out/`, with the answers waiting for the device |
| any other depth below `incoming/` | a host file reached through a symlink |

The layout below `incoming/` is `dsh-nodes`' business: it names the directory after the node
number or after the node name, and neither is a reason to refuse a recording. A refused path is a
warning with the path, a closing line with `reason=refused-path`, and the file left untouched —
it is not ours to delete.

Exchanges are not serialised either. Two presses, or two takes, on one device run side by side:
the answers may come back in either order, and a slow turn never holds the next one. That is
accepted on purpose: a queue made the person wait behind a turn that could take three minutes.

## The voice loop

On the push path the device records and uploads, and the loop starts with the file already
here. On the still-supported pull path the phone says *"I want to talk"* (`POST /v1/events`
with `{"voice":{"want":"record"}}`, no text, no session) and the host does the asking:

1. `nodes.call(node, 'voice', 'record', {mode, maxSeconds: 30, timeout: 12})` — wait for the take;
2. `nodes.call(node, 'files', 'copyFromDevice', {path, hostPath})` — the device writes it straight
   into `<cacheDir>/work/<run>/`, our own directory;
3. `nodes.call(node, 'shell', 'exec', {command: 'rm -f -- <device path>'})` — the device copy
   is litter once it is here;
4. `speechToText.resolve(...)` + `transcribe(...)` on that copy — the WAV is already the canonical
   16 kHz mono PCM16 — and the copy is removed as soon as it has been read;
5. an empty transcript is answered out loud (`voice.say`) and never reaches a session;
6. otherwise the text goes into the session as a user message with `source: {kind: 'dsh-nodes', voice: true}`;
7. the turn is watched: on a completed turn the last assistant text is cut with `splitReply`,
   the `# screen` part (or `# say` when there is none) goes to `voice.chat`, and — on
   `synth=host` — the `# say` part also becomes an OGG that `voice.answer` carries.

Every refusal on this way ends in a sentence the person hears, not in a log line: a
timeout, a permission denial, a cancelled take, a `status: ok` without a path, a rejected
`voice.record` or `copyFromDevice` ("не смог начать запись: <причина>"), a session that
cannot be created, and a missing recognizer each have their own words and their own
`reason=` in the closing line.

## The format

A channel that received speech writes its transcript as a service block, because
the prompt RPC cannot carry a message source:

```text
--- # voice device=pixel speed=1.2
включи свет в коридоре
```

A message assembled in-process (the Android node) needs no block: it sets
`source.voice = true` on the message it delivers.

The answer names what is meant to be heard and what is only meant to be read:

```text
--- # say
Свет включил, в коридоре горит.
--- # screen
Датчик сработал в 21:14, лампа была выключена 40 минут.
```

| marker | meaning |
| --- | --- |
| `--- # voice`, `--- # say` | spoken |
| `--- # screen`, `--- # text` | shown only |
| a document with no marker | the first one is spoken and shown, later ones are shown only |
| no marker at all | the whole reply is spoken and shown |

A marker is a **whole line** starting with `---` and carrying a `#` comment. A
bare `---` is a markdown rule or a table separator far more often than a voice
marker, so it is not one. Lines inside a fenced code block are never markers,
and an unterminated fence swallows the rest instead of arming the parser.

The marker tail carries `key=value` options (`device=pixel`, `speed=1.2`). The
parser keeps unknown keys: the notice passes them to the model, and a later
layer may read them for itself.

## What the plugin does

1. On `agent/pre-step` it lifts a `--- # voice` block out of a claimed user
   message and records it as its own `plugin:dsh-voice` context message next to
   the user's words — the same trick `dsh-im` uses for quoted replies. A message
   marked only in its `source` gets the notice without any rewriting.
2. It registers one system-prompt section (`dsh-voice:reply-contract`, order
   119) with the rules for a spoken answer: one to three sentences, no markdown,
   no tables, no code blocks, no links, details in the `# screen` part.

A failed split never costs the user their message: the listener returns the
original decision and the marker stays inline, exactly as it would on a Host
without this plugin.

## Use the parser without the plugin

```js
import { readVoiceMarkup, splitReply } from '@dr-co/dsh-voice/markup'

const { text, voice } = readVoiceMarkup(incoming) // user words, or voice: null
const { speak, screen } = splitReply(answer)      // what to say, what to show
```

## Test

```sh
npm test
```
