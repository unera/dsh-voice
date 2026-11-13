// Turning the provider's WAV into something a phone plays.
//
// The provider speaks at its own natural rate — Silero refuses a tempo it cannot honour — so the
// playback tempo is applied here, by ffmpeg's `atempo`, exactly as `voice_say` does it for the
// Telegram path. One implementation, two callers, one sound.
import { spawn } from 'node:child_process'

/** Run one command; resolve on a zero exit, reject with its stderr tail otherwise. */
function run (command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve(stderr)
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(0, 300)}`))
    })
  })
}

/**
 * Convert a WAV into OGG/Opus, optionally changing the tempo.
 *
 * @param input - the provider's WAV file.
 * @param output - where the voice note goes.
 * @param speed - 1 keeps the original tempo; >1 speaks faster at the same pitch.
 * @param options - `signal` for cancellation.
 * @returns the output path.
 */
export async function toVoiceNote (input, output, speed = 1, { signal } = {}) {
  const tempo = Number(speed)
  const filters = Number.isFinite(tempo) && tempo > 0 && tempo !== 1 ? ['-filter:a', `atempo=${tempo}`] : []
  await run('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', input,
    ...filters,
    '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1',
    output,
  ], { signal })
  return output
}
