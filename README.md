# @dr-co/dsh-voice

Voice markup for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
one format for both directions of a spoken turn, an input marker lifted out of
the prompt at `agent/pre-step`, and the prompt section that tells the model how
a spoken answer is written.

This package synthesizes nothing and sends nothing. A Host that wants audio
installs a text-to-speech provider and a layer that reads `splitReply()`; this
package only makes the turn *legible* as spoken.

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
[dsh-voice] exchange take-1 node=A059P stage=spoken ms=5310
[dsh-voice] exchange take-1 node=A059P done total=5310ms
            segments={record: 4800, upload: 180, stt: 312, model: 3769, tts: 908, play: 280}
```

`record` and `upload` come from the device (`x-record-start/-stop`, `x-sent-at` against the
server's `receivedAt`); a segment that never happened is absent from the line, not a zero. A
failed exchange closes with `reason=empty`, `reason=no-session`, `reason=silent` and so on.

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

A take shorter than `minSeconds` (0.4 by default) is not speech at all: the file is removed, the
session is untouched, the device is told nothing, and the closing line says `reason=too-short`.

Both facts are visible in the trace: `stage=stt-request provider=… language=…`, and `language=…`
in the closing line.

## Two ways a recording arrives

| path | who starts it | what the loop calls |
|---|---|---|
| push (new) | the device records and uploads | nothing — the file is already at `event.path` |
| pull (old, still supported) | the host asks after `voice.want` | `voice.record` → `files.copyFromDevice` |

`dsh-nodes/voice` carries `{node, nodeName, id, path, bytes, seconds}`. The `id` is the
identity of one exchange: a retry with the same id is answered `already` and produces no
second turn. The recording is deleted once it is used, whether it produced words or not.

## The voice loop

A device cannot push a recording: the transfer endpoint accepts only an answer to a
`copyFromDevice` command. So the phone says *"I want to talk"* (`POST /v1/events` with
`{"voice":{"want":"record"}}`, no text, no session), and the host does the asking.

For one exchange the loop:

1. `nodes.call(node, 'voice', 'record', {mode, maxSeconds: 30, timeout: 45})` — wait for the take;
2. `nodes.call(node, 'files', 'copyFromDevice', {path, hostPath})` — pull it into `<DSH_HOME>/cache/voice`;
3. `nodes.call(node, 'shell', 'exec', {command: 'rm -f <device path>'})` — the device copy is litter once it is here;
4. `speechToText.resolve(...)` + `transcribe(...)` — the WAV is already the canonical 16 kHz mono PCM16;
5. an empty transcript is answered out loud (`voice.say`) and never reaches a session;
6. otherwise the text goes into the session as a user message with `source: {kind: 'dsh-nodes', voice: true}`;
7. the turn is watched: on a completed turn the last assistant text is cut with `splitReply`,
   only the `# say` part is spoken, and the phone says it through `voice.say`.

The audio is synthesized on the host as well — the file is produced and dropped, so the
moment `voice.play` exists nothing on this side has to change. Recordings and rendered
speech are removed after each exchange.

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

## Install

```sh
dsh plugin --profile <profile> add @dr-co/dsh-voice
```

The package ships `dsh.bundle.patch`, so the row mounts itself:

```yaml
- insert:
    - id: dsh-voice
      name: '@dr-co/dsh-voice'
```

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
