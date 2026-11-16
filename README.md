# @dr-co/dsh-voice

A spoken turn for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a press on a node becomes a recording, the recording becomes a transcript, and
the answer comes back to the phone as one chat message that carries both the
line to show and the speech to play.

Four things live here, and the package ships all of them:

| part | what it does |
|---|---|
| the marker | `--- # voice` in, `--- # say`/`--- # screen` out, read by `splitReply()` |
| the loop | record → transcribe → deliver → watch the turn → answer the device |
| the prompt section | how a spoken answer is written, and what it may not contain |
| the trace | one log line per stage of every exchange, one closing line with the reason |

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
| `keepRecording` | `last` | `last` keeps the newest take of every node (older ones go), `none` removes a take as soon as it is used. Anything that is not `none` reads as `last`: a typo must not throw a recording away |

### Where things live, and what a boot removes

Every run of the loop owns one name: `<pid>-<six hex>`, made once when the loop is built (the
`runId` option overrides it; a test uses its own). The pair is what counts, not the pid alone —
the kernel reuses a number, and a directory left by a cancelled process with that number would
look like this one's own. The name stays one path segment, so the files of two processes sharing
a `cacheDir` never mix:

| what | where |
|---|---|
| a recording — uploaded by the device, or pulled in | `<cacheDir>/incoming/<run>/<node>/<id>.<ext>` |
| a rendered answer waiting for the device | `<cacheDir>/out/<run>/<id>.ogg` |
| the node → session bindings | `<cacheDir>/sessions.json` — deliberately not per run |

A boot cleans up after the runs that are gone, and the only signal it trusts is age:

- `incoming/` — every entry older than an hour goes, subdirectories and stray files alike. That
  is an earlier run, and it is also the old `<node>/` layout of 0.1.20 and before;
- `out/` — the same hour: an answer may still be downloading right after a restart, and an hour
  is far longer than the two-minute guard a live answer has;
- the directories of **this** run are never touched, however old the clock says they are — this
  process is the one using them.

Age, not ownership, because a second process may share the cache and a file may still be read:
"everything that is not mine" would delete a neighbour's live work. A leftover younger than the
hour is simply picked up by the next boot, or by the daily sweep below.

Both trees are also swept by `mtime` at boot and then once a day: a recording older than 24 hours
is removed, and an orphaned `.ogg` goes by the same rule (its fast path is the two-minute guard
that follows every answer). The sweep is the insurance policy for a process that lives for weeks;
the boot cleanup is what handles a process that is already gone.

## Who speaks

`synth=device` (default) means the phone reads the text with its own engine — the host does no
synthesis at all. `synth=host` means the answer must sound like our voice: the host synthesizes,
converts the provider's WAV to OGG/Opus with the configured tempo, and hands the file to
`voice.answer`; the device fetches it by the command it answers, and the file is removed once it
has.

Neither call is awaited: speaking takes as long as the sentence, and the next press must not
queue behind it. `voice.stop` is what cuts a speech short. When a host synthesis fails the loop
falls back to the device engine and closes the line with `reason=tts-failed`.

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

None of these is awaited and none joins the exchange queue: a screen that is off, a build without
`voice.chat`, a full queue — one warning line, and the answer still arrives. If the synthesis
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
the device is told nothing, and the closing line says `reason=too-short`. The file itself follows
`keepRecording` like any other take — a click that was heard as words is exactly what one wants to
listen to.

Both facts are visible in the trace: `stage=stt-request provider=… language=…`, and `language=…`
in the closing line.

## Two ways a recording arrives

The push path is the main one; the pull path is kept while the clients migrate.

| path | who starts it | what the loop calls |
|---|---|---|
| push | the device records and uploads | nothing — the file is already at `event.path` |
| pull (older clients) | the host asks after `voice.want` | `voice.record` → `files.copyFromDevice` |

`dsh-nodes/voice` carries `{node, nodeName, id, path, bytes, seconds}`. The `id` is the
identity of one exchange: a retry with the same id is answered `already` and produces no
second turn. The id is reserved as soon as the event is accepted, so a copy that arrives
while the first one is still waiting for the model (up to three minutes) is a duplicate,
not a second answer; a failed exchange releases it, because the client re-sends the same
id on purpose. The reservation lives in memory: a restart kills the exchange in flight
anyway, and a retry after it has to be handled again rather than declared answered.

`path` must be a recording of this device, in one of the two layouts the cache really has:

| layout | who creates it |
|---|---|
| `<cacheDir>/incoming/<run>/<node>/<id>` | the voice loop, on the pull path: `voice.record` writes on the device, `files.copyFromDevice` puts the take here |
| `<cacheDir>/incoming/<node>/<id>` | `dsh-nodes`, on the push path: it writes the file itself and knows nothing about the loop's run id |

Both are accepted; neither is the "real" one. The file is read and then removed, so an event
naming anything else — another run, another node, the cache root with `sessions.json`, `out/`
with the answers waiting for the device — is refused whole: a warning with the path and a
closing line with `reason=refused-path`, the file untouched.

What is left of the take afterwards is the `keepRecording` setting, applied to the directory the
file actually arrived in:

| value | what stays in that node directory |
|---|---|
| `last` (default) | exactly one file — the newest take of that node; its predecessors are removed |
| `none` | nothing; the take goes as soon as the exchange is over |

Anything that is not `none` reads as `last`: a typo must not throw a recording away. The kept
take does not live forever — a sweep removes recordings older than 24 hours, once at boot and
then once a day, by `mtime` alone. So "what did it actually hear" can be listened to the same day,
and the directory does not grow with every press.

Keeping works **inside one run**. The leftovers of a run that is over are cleaned by age, measured
on the files: the next boot removes every file older than an hour and then the directories that
are left empty. Writing a take updates the mtime of `<node>/` and nothing above it, so a run
directory that looks old may still hold a take written a minute ago — that one stays. After a
restart the recording of the previous session is not an archive either way: the takes are a
debugging aid of the live process.

## The voice loop

On the push path the device records and uploads, and the loop starts with the file already
here. On the still-supported pull path the phone says *"I want to talk"* (`POST /v1/events`
with `{"voice":{"want":"record"}}`, no text, no session) and the host does the asking:

1. `nodes.call(node, 'voice', 'record', {mode, maxSeconds: 30, timeout: 12})` — wait for the take;
2. `nodes.call(node, 'files', 'copyFromDevice', {path, hostPath})` — pull it into
   `<cacheDir>/incoming/<run>/<node>/`;
3. `nodes.call(node, 'shell', 'exec', {command: 'rm -f -- <device path>'})` — the device copy
   is litter once it is here;
4. `speechToText.resolve(...)` + `transcribe(...)` — the WAV is already the canonical 16 kHz mono PCM16;
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
