/**
 * Bundle manifest tests: the official-bundle shape this package declares, and
 * the invariant that ties that shape back to the runtime.
 *
 * `package.json` declares `dsh.bundle.patch` (the bundle layer) next to the
 * existing `dsh.client` half, and ships display metadata (`locale/*.json`,
 * `icon.svg`) through `exports`/`files`. The patch lists the official service
 * nodes this plugin cannot work without, which is the same fact as
 * `src/index.ts`'s exported `inject`: the patch drives the Loader's activation
 * order, the export drives Cordis's service injection. Both lists are extracted
 * by regex here — never hard-coded — so a one-sided edit fails this suite.
 *
 * Everything is read from the repository, so this file depends on no `lib/`
 * output and runs without a preceding build (`npm test` does not build).
 * @module cordis-plugin-loop/test/manifest
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The package root, one directory above this test. */
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

/** Read a package-relative UTF-8 file. */
function read(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), 'utf8')
}

/** The subset of `package.json` these tests assert on. */
interface PackageManifest {
  readonly name: string
  readonly icon?: unknown
  readonly exports: Record<string, unknown>
  readonly files: readonly string[]
  readonly dsh?: {
    readonly bundle?: { readonly patch?: unknown }
    readonly client?: {
      readonly platform?: unknown
      readonly immediately?: unknown
      readonly inject?: unknown
    }
  }
}

const manifest = JSON.parse(read('package.json')) as PackageManifest

/** Parse the patch's `inject: [service, …]` line. */
function patchInject(text: string): string[] {
  const match = /^\s*inject:\s*\[([^\]]*)\]\s*$/mu.exec(text)
  assert.ok(match !== null, 'cordis.patch.yml must declare `inject: [service, …]`')
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/gu, ''))
    .filter((item) => item.length > 0)
}

/** Parse the exported `inject` list from `src/index.ts`. */
function sourceInject(text: string): string[] {
  const match = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/u.exec(text)
  assert.ok(match !== null, 'src/index.ts must export `const inject = [...]`')
  return [...match[1].matchAll(/['"]([^'"]+)['"]/gu)].map((entry) => entry[1])
}

test('the bundle patch is declared and shipped', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  const patchPath = join(packageRoot, 'cordis.patch.yml')
  assert.ok(existsSync(patchPath), 'cordis.patch.yml must exist')
  assert.ok(statSync(patchPath).isFile(), 'cordis.patch.yml must be a regular file')
})

test('the client half stays declared next to the bundle layer', () => {
  const client = manifest.dsh?.client
  assert.ok(client !== undefined, 'dsh.client must survive the bundle declaration')
  assert.equal(client.platform, 'web')
  assert.equal(client.immediately, true)
  assert.ok(Array.isArray(client.inject) && client.inject.length > 0, 'dsh.client.inject must list the client packages')
  for (const entry of client.inject) assert.equal(typeof entry, 'string')
})

test('the patch inserts exactly one Loader row named after this package', () => {
  const text = read('cordis.patch.yml')
  const ids = [...text.matchAll(/^\s*(?:-\s*)?id:\s*(\S+)\s*$/gmu)].map((match) => match[1])
  assert.deepEqual(ids, ['loop'], `expected exactly one row with id "loop", saw ${JSON.stringify(ids)}`)
  const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gmu)].map((match) => match[1])
  assert.deepEqual(names, [manifest.name], `the inserted row must be named ${manifest.name}`)
})

test('the patch and src/index.ts declare the same injected services', () => {
  const fromPatch = patchInject(read('cordis.patch.yml'))
  const fromSource = sourceInject(read('src/index.ts'))
  assert.ok(fromPatch.length > 0, 'the patch must inject at least one service')
  assert.ok(fromSource.length > 0, 'src/index.ts must inject at least one service')
  assert.deepEqual([...fromPatch].sort(), [...fromSource].sort())
})

test('both locales parse and carry display metadata', () => {
  for (const locale of ['en', 'zh']) {
    const parsed = JSON.parse(read(`locale/${locale}.json`)) as {
      meta?: { title?: unknown; description?: unknown }
    }
    assert.ok(parsed.meta !== undefined, `${locale}.json must carry meta`)
    for (const key of ['title', 'description'] as const) {
      const value: unknown = parsed.meta[key]
      assert.equal(typeof value, 'string', `${locale}.json meta.${key} must be a string`)
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${locale}.json meta.${key} must not be empty`)
    }
  }
})

test('the icon ships as an inline SVG within the size budget', () => {
  const iconPath = join(packageRoot, 'icon.svg')
  assert.ok(existsSync(iconPath), 'icon.svg must exist')
  const bytes = statSync(iconPath).size
  assert.ok(bytes <= 256 * 1024, `icon.svg is ${bytes} bytes, over the 256 KiB budget`)
  const svg = read('icon.svg')
  assert.match(svg, /<svg/u)
  assert.match(svg, /viewBox="0 0 32 32"/u)
  assert.doesNotMatch(svg, /<text/iu)
  assert.doesNotMatch(svg, /<script/iu)
  assert.doesNotMatch(svg, /(?:href|src)\s*=/iu)
  // The Host ships icons as a data URI (dsh-app-boot), so `currentColor` resolves to
  // the initial colour instead of following the page theme: pin fixed colours.
  assert.doesNotMatch(svg, /currentColor/iu, 'the icon must use fixed colours, not currentColor')
  assert.doesNotMatch(svg, /url\(\s*['"]?(?:https?:|\/\/|data:)/iu, 'the icon must not load external resources')
})

test('package metadata exposes the locale and icon files', () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  for (const entry of ['cordis.patch.yml', 'locale', 'icon.svg']) {
    assert.ok(manifest.files.includes(entry), `files must include ${entry}`)
  }
  for (const entry of ['.', './client', './src/*', './package.json']) {
    assert.ok(entry in manifest.exports, `exports must keep ${entry}`)
  }
})

test('package.json declares the top-level icon field the Host reads first', () => {
  // dsh-app-boot resolves `package.json#icon` before falling back to `<pkg>/icon`.
  assert.equal(manifest.icon, 'icon.svg', 'package.json must declare icon: "icon.svg"')
  assert.ok(existsSync(join(packageRoot, 'icon.svg')), 'the icon field target must exist')
})
