# @dr-co/dsh-voice

Voice markup for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
one format for both directions of a spoken turn, an input marker lifted out of
the prompt at `agent/pre-step`, and the prompt section that tells the model how
a spoken answer is written.

This package synthesizes nothing and sends nothing. A Host that wants audio
installs a text-to-speech provider and a layer that reads `splitReply()`; this
package only makes the turn *legible* as spoken.

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
