// Interface dictionaries: English, Russian, Chinese.
//
// Every key exists in all three — `test/client.test.mjs` compares the key sets,
// because a missing key only shows on somebody else's screen.

export const NS = 'dsh-voice'

export const en = {
  'title': 'Spoken replies',
  'intro': 'The host can speak the first part of a reply: it is synthesized into an OGG voice note and attached to the answer, so a chat that carries files sends it beside the text.',
  'speak.label': 'Speak replies',
  'speak.hint': 'The part of the answer between the three markers is spoken; an answer without them travels as it is, without sound.',
  'limit.label': 'Characters to speak',
  'limit.hint': 'Between 1 and 5000. A longer first part means no sound at all — it is never cut short.',
  'limit.invalid': 'A whole number from 1 to 5000 is needed here',
  'availability.checking': 'Checking for a speech synthesizer…',
  'availability.noSynth': 'A synthesizer is needed: there is nothing to speak with yet. Install a speech provider (for example @dr-co/dsh-text-to-speech) and check again.',
  'availability.failed': 'Could not find out whether a synthesizer is installed',
  'availability.retry': 'Check again',
  'summary.off': 'replies are not spoken',
  'summary.on': 'replies are spoken, up to {limit} characters',
  'summary.unknown': 'spoken replies: the switch cannot be read',
  'write.refused': 'The host did not accept the value',
  'form.unavailable': 'This configuration cannot be read here',
}

export const ru = {
  'title': 'Озвучка ответов',
  'intro': 'Хост может озвучить первую часть ответа: она синтезируется в голосовое сообщение OGG и прикладывается к ответу, поэтому канал, который умеет передавать файлы, отправит её рядом с текстом.',
  'speak.label': 'Озвучивать ответы',
  'speak.hint': 'Прозвучит та часть ответа, что стоит между тремя маркерами; ответ без них уходит как есть, без звука.',
  'limit.label': 'Сколько символов озвучивать',
  'limit.hint': 'От 1 до 5000. Более длинная первая часть не озвучивается вовсе — она никогда не обрезается.',
  'limit.invalid': 'Здесь нужно целое число от 1 до 5000',
  'availability.checking': 'Проверяю, есть ли синтез речи…',
  'availability.noSynth': 'Нужен синтез речи: озвучивать пока нечем. Установите провайдера синтеза (например, @dr-co/dsh-text-to-speech) и проверьте снова.',
  'availability.failed': 'Не удалось узнать, установлен ли синтез речи',
  'availability.retry': 'Проверить снова',
  'summary.off': 'ответы не озвучиваются',
  'summary.on': 'ответы озвучиваются, до {limit} символов',
  'summary.unknown': 'озвучка ответов: переключатель не читается',
  'write.refused': 'Хост не принял значение',
  'form.unavailable': 'Эту настройку здесь прочитать нельзя',
}

export const zh = {
  'title': '语音回复',
  'intro': '主机可以把回复的第一部分合成 OGG 语音，并作为附件随回复一起发送，因此支持文件的频道会在文字旁发送它。',
  'speak.label': '朗读回复',
  'speak.hint': '三个标记之间的那部分会被朗读；没有标记的回复按原样发送，不带语音。',
  'limit.label': '朗读字符数',
  'limit.hint': '从 1 到 5000。更长的第一部分完全不朗读——它不会被截断。',
  'limit.invalid': '这里需要 1 到 5000 的整数',
  'availability.checking': '正在检查语音合成…',
  'availability.noSynth': '需要语音合成：目前没有可用的合成器。请安装语音提供方（例如 @dr-co/dsh-text-to-speech）后重试。',
  'availability.failed': '无法确认是否安装了语音合成',
  'availability.retry': '重新检查',
  'summary.off': '不朗读回复',
  'summary.on': '朗读回复，最多 {limit} 个字符',
  'summary.unknown': '语音回复：无法读取开关',
  'write.refused': '主机没有接受这个值',
  'form.unavailable': '此处无法读取该设置',
}

export const DICTIONARIES = { en, ru, zh }
