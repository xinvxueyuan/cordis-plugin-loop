/**
 * Platform neutrality of the whole suite's expectations.
 *
 * CI run 38431103637 failed on the Linux runner (115 pass / 2 fail) because
 * `test/loopfile.test.ts` asserted a Windows drive-letter path back verbatim: a
 * drive-letter path is absolute only on win32, so a POSIX runner's
 * `path.resolve` treats it as a relative *name* and prefixes the process cwd.
 *
 * The scan below reads every test source and refuses a drive-letter literal that
 * is not exempt **as a literal**: either the platform itself makes it absolute
 * (the literal is an argument of `resolve(`/`join(`), or the assertion branches
 * on `process.platform`, or the line carries the `platform-probe-literal`
 * marker. A `resolve(` elsewhere on the same line does not excuse it.
 * @module cordis-plugin-loop/test/platform-neutral
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/** One test source, as the scan sees it. */
export interface SourceFile {
  /** File name, for the report. */
  readonly name: string
  /** Full file text. */
  readonly text: string
}

/** A single backslash, built without writing one next to a drive letter. */
const backslash = String.fromCharCode(92)

/**
 * Matches a string-ish literal that opens with a drive-letter path.
 *
 * Covers single quotes, double quotes and template literals, and both
 * separators: a backslash (the win32 form) and a forward slash (`C:/…`, which is
 * absolute on win32 and relative on POSIX — the same class of failure).
 * Requiring the opening quote keeps comment prose and regex escapes such as a
 * newline inside a pattern out of the report.
 */
const driveLiteral = /(['"`])([A-Za-z]):[\\/]/gu

/** Calls that make the platform's own absoluteness decision for their argument. */
const pathCalls = new Set(['resolve', 'join'])

/** Marker that exempts a deliberate platform probe. */
const probeMarker = 'platform-probe-literal'

/** How far back to look for the call enclosing a literal. */
const enclosingScanLimit = 500

/**
 * Replace comment text with spaces, keeping every offset and newline.
 *
 * Prose is not an expectation: this repository writes code samples in backticks
 * inside comments, which the template-literal rule would otherwise report. The
 * replacement is length-preserving, so a match index in the blanked text is the
 * same index in the original and can be reported verbatim.
 *
 * @param text - Source text.
 * @returns The same text with `//` and block comments blanked out.
 */
export function blankComments(text: string): string {
  const out = [...text]
  let quote: string | undefined
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (quote !== undefined) {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === quote) quote = undefined
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') {
        out[index] = ' '
        index += 1
      }
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      let cursor = index
      while (cursor < text.length && !(text[cursor] === '*' && text[cursor + 1] === '/')) {
        if (text[cursor] !== '\n') out[cursor] = ' '
        cursor += 1
      }
      for (let tail = cursor; tail < Math.min(cursor + 2, text.length); tail += 1) out[tail] = ' '
      index = cursor + 2
      continue
    }
    index += 1
  }
  return out.join('')
}

/**
 * Find the call enclosing one literal, walking back to its opening paren.
 *
 * @param text - Whole file text.
 * @param index - Index of the literal's opening quote.
 * @returns The callee name, when the literal sits inside a call.
 */
function enclosingCall(text: string, index: number): string | undefined {
  let depth = 0
  const floor = Math.max(0, index - enclosingScanLimit)
  for (let cursor = index - 1; cursor >= floor; cursor -= 1) {
    const char = text[cursor]!
    if (char === ')') depth += 1
    else if (char === '(') {
      if (depth > 0) {
        depth -= 1
        continue
      }
      const callee = /([A-Za-z_$][\w$]*)\s*$/u.exec(text.slice(floor, cursor))
      return callee?.[1]
    }
  }
  return undefined
}

/**
 * Scan sources for drive-letter literals that are not exempt as literals.
 *
 * @param files - Test sources to scan.
 * @returns One `name:line: text` entry per offending literal.
 */
export function findDriveLiteralOffenders(files: readonly SourceFile[]): string[] {
  const offenders: string[] = []
  for (const file of files) {
    // Comments are blanked first (keeping offsets) so prose cannot be reported.
    const code = blankComments(file.text)
    for (const match of code.matchAll(driveLiteral)) {
      const index = match.index
      const lineStart = code.lastIndexOf('\n', index) + 1
      const lineEnd = code.indexOf('\n', index)
      const line = file.text.slice(lineStart, lineEnd === -1 ? file.text.length : lineEnd)
      const lineNumber = code.slice(0, index).split('\n').length

      // Exemptions that belong to the literal itself, then to its line.
      const callee = enclosingCall(code, index)
      if (callee !== undefined && pathCalls.has(callee)) continue
      if (line.includes(probeMarker)) continue
      if (line.includes('process.platform')) continue

      offenders.push(`${file.name}:${lineNumber}: ${line.trim()}`)
    }
  }
  return offenders
}

/** The directory these tests live in. */
const testDir = fileURLToPath(new URL('.', import.meta.url))

/** Read every test source in this directory. */
async function readSources(): Promise<SourceFile[]> {
  const names = (await readdir(testDir)).filter((name) => name.endsWith('.ts')).sort()
  const files: SourceFile[] = []
  for (const name of names) files.push({ name, text: await readFile(join(testDir, name), 'utf8') })
  return files
}

test('no test source asserts a platform-specific path literal back', async () => {
  const files = await readSources()
  const offenders = findDriveLiteralOffenders(files)
  assert.deepEqual(
    offenders,
    [],
    `platform-specific path expectation(s) found — make the literal an argument of resolve()/join(), branch on process.platform, or mark it ${probeMarker}:\n${offenders.join('\n')}`,
  )
  assert.ok(files.length >= 10, `expected the whole suite to be scanned, saw ${files.length} files`)
})

test('the scan catches every shape that broke CI, including the ones it once missed', () => {
  const drive = `C:${backslash}slash${backslash}.dsh`
  const forward = 'C:' + '/' + 'fwd/.dsh'
  const cases: readonly { readonly label: string; readonly source: string }[] = [
    { label: 'single-quoted literal', source: `const a = '${drive}'\n` },
    { label: 'double-quoted literal', source: `const a = "${drive}"\n` },
    { label: 'template literal', source: `const a = \`${drive}\`\n` },
    { label: 'forward-slash drive letter', source: `const a = '${forward}'\n` },
    {
      label: 'an unrelated resolve() elsewhere on the line does not excuse it',
      source: `assert.equal(dshHome({ DSH_HOME: '${drive}' }), resolve('other'))\n`,
    },
  ]
  for (const { label, source } of cases) {
    const offenders = findDriveLiteralOffenders([{ name: 'sample.test.ts', text: source }])
    assert.equal(offenders.length, 1, `${label} must be reported, saw ${JSON.stringify(offenders)}`)
  }
})

test('the scan leaves every legitimate form alone', () => {
  const drive = `C:${backslash}custom${backslash}.dsh`
  const allowed: readonly { readonly label: string; readonly source: string }[] = [
    { label: 'the marked probe literal', source: `const p = '${drive}' // ${probeMarker}\n` },
    { label: 'a resolve() argument', source: `assert.equal(dshHome({ DSH_HOME: resolve('${drive}') }), 1)\n` },
    { label: 'a join() argument', source: `const p = join('${drive}', 'loop.md')\n` },
    {
      label: 'a platform branch',
      source: `if (process.platform === 'win32') assert.equal(p, '${drive}')\n`,
    },
    { label: 'prose in a comment', source: `// the runner reported /home/runner/C:${backslash}custom in CI\n` },
    { label: 'a regex escape that looks similar', source: `assert.match(text, /Task:${backslash}n/u)\n` },
  ]
  for (const { label, source } of allowed) {
    const offenders = findDriveLiteralOffenders([{ name: 'sample.test.ts', text: source }])
    assert.deepEqual(offenders, [], `${label} must not be reported`)
  }
})
