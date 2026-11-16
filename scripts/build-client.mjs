/**
 * Client build: bundle the browser half into the harness' plugin-bundle format.
 *
 * A DSH client bundle is not an ES module the page imports — it is a script that
 * registers a factory with `window.__ModuleLoader__.load({ id, factory })`, where
 * `factory(require)` returns the bundle's exports and `require` resolves only the
 * module table the shell seeds (react and the harness' own client packages). This
 * script produces the JS with esbuild and writes that wrapper around it, the same
 * way `@dr-co/dsh-text-to-speech` and `@dr-co/dsh-storage` do.
 *
 * The output path is `lib/client.js` because that is what `exports["./client"]`
 * points at — and `lib/` is in `files`, so the published package carries it. The
 * bundling itself is exported so a test can rebuild and prove the committed file
 * is the one these sources produce: a stale bundle is a card that silently runs
 * last week's code.
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, from this script's own location. */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Bundle the client half.
 *
 * @param directory - the package root to build.
 * @returns the wrapped bundle text, ready to be written as `lib/client.js`.
 */
export async function bundleClient (directory = root) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))

  const result = await build({
    entryPoints: [join(directory, 'src/client/index.js')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome110'],
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    write: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'silent',
  })

  const bundled = result.outputFiles?.[0]?.text
  if (typeof bundled !== 'string' || bundled === '') throw new Error('dsh-voice: esbuild produced no client bundle')

  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`
}

/**
 * Build and write `lib/client.js`.
 *
 * @param directory - the package root to build.
 * @returns the output path.
 */
export async function writeClient (directory = root) {
  const wrapped = await bundleClient(directory)
  const outfile = join(directory, 'lib/client.js')
  await mkdir(dirname(outfile), { recursive: true })
  await writeFile(outfile, wrapped, 'utf8')
  console.log(`dsh-voice: client bundle written to ${outfile} (${wrapped.length} bytes)`)
  return outfile
}

// Run only when invoked as a script; importing this module bundles nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeClient()
}
