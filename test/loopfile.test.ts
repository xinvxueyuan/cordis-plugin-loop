/**
 * Default-task file resolution: priority, empty files, truncation, and the
 * failure that lists every candidate path.
 * @module cordis-plugin-loop/test/loopfile
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  clipToBytes,
  dshHome,
  loopFilePaths,
  missingTaskMessage,
  resolveLoopFile,
} from '../src/loopfile.ts'

/** Create one scratch directory with an optional `.dsh/loop.md`. */
async function scratch(files: { project?: string; home?: string }): Promise<{ cwd: string; dshHome: string; env: Record<string, string | undefined> }> {
  const root = await mkdtemp(join(tmpdir(), 'loopfile-'))
  const cwd = join(root, 'project')
  const dshHome = join(root, 'dsh-home')
  await mkdir(join(cwd, '.dsh'), { recursive: true })
  await mkdir(dshHome, { recursive: true })
  if (files.project !== undefined) await writeFile(join(cwd, '.dsh', 'loop.md'), files.project, 'utf8')
  if (files.home !== undefined) await writeFile(join(dshHome, 'loop.md'), files.home, 'utf8')
  return { cwd, dshHome, env: { DSH_HOME: dshHome } }
}

test('the project file wins over the DSH_HOME file', async () => {
  const { cwd, env } = await scratch({ project: 'project task\n', home: 'home task\n' })
  const resolved = resolveLoopFile(cwd, 25000, env)
  assert.equal(resolved.task, 'project task\n')
  assert.equal(resolved.path, join(cwd, '.dsh', 'loop.md'))
  assert.equal(resolved.truncated, false)
  assert.deepEqual(resolved.probes.map((probe) => probe.present), [true])
})

test('the DSH_HOME file is the fallback when the project has none', async () => {
  const { cwd, dshHome, env } = await scratch({ home: 'home task\n' })
  const resolved = resolveLoopFile(cwd, 25000, env)
  assert.equal(resolved.task, 'home task\n')
  assert.equal(resolved.path, join(dshHome, 'loop.md'))
  assert.deepEqual(resolved.probes.map((probe) => probe.present), [false, true])
})

test('an empty file is ignored rather than accepted', async () => {
  const { cwd, dshHome, env } = await scratch({ project: '   \n\n\t', home: '  ' })
  const resolved = resolveLoopFile(cwd, 25000, env)
  assert.equal(resolved.task, undefined)
  assert.equal(resolved.path, undefined)
  assert.deepEqual(resolved.probes.map((probe) => probe.ignored), ['empty', 'empty'])
  assert.ok(resolved.probes.every((probe) => probe.bytes !== undefined))
  assert.ok(!resolved.probes.some((probe) => probe.present))
  void dshHome
})

test('the project file is used when the DSH_HOME file is empty', async () => {
  const { cwd, env } = await scratch({ project: 'project task', home: '   ' })
  const resolved = resolveLoopFile(cwd, 25000, env)
  assert.equal(resolved.task, 'project task')
})

test('a file over the byte budget is truncated and marked', async () => {
  const long = 'x'.repeat(40000)
  const { cwd, env } = await scratch({ project: long })
  const resolved = resolveLoopFile(cwd, 25000, env)
  assert.equal(resolved.truncated, true)
  assert.equal(Buffer.byteLength(resolved.task ?? '', 'utf8'), 25000)
  assert.equal(resolved.probes[0]?.ignored, 'truncated')
  assert.equal(resolved.probes[0]?.bytes, 40000)
})

test('the byte budget is applied to the bytes, not to the character count', async () => {
  const multibyte = '漢'.repeat(20000)
  const { cwd, env } = await scratch({ project: multibyte })
  const resolved = resolveLoopFile(cwd, 1000, env)
  assert.equal(resolved.truncated, true)
  const bytes = Buffer.byteLength(resolved.task ?? '', 'utf8')
  assert.ok(bytes <= 1000, `clipped to ${bytes} bytes`)
  assert.equal(resolved.task, '漢'.repeat(333), 'the clip must land on a code-point boundary')
})

test('clipToBytes leaves a short string alone and cuts a long one', () => {
  assert.deepEqual(clipToBytes('abc', 3), { text: 'abc', truncated: false })
  assert.deepEqual(clipToBytes('abcd', 3), { text: 'abc', truncated: true })
  assert.deepEqual(clipToBytes('', 0), { text: '', truncated: false })
})

test('DSH_HOME is resolved from the environment or the user home', () => {
  assert.equal(dshHome({ DSH_HOME: 'C:\\custom\\.dsh' }), 'C:\\custom\\.dsh')
  assert.match(dshHome({}), /\.dsh$/u)
})

test('the candidate list is project first, then DSH_HOME', () => {
  const paths = loopFilePaths('C:\\project', { DSH_HOME: 'C:\\home\\.dsh' })
  assert.deepEqual(paths, [join('C:\\project', '.dsh', 'loop.md'), join('C:\\home\\.dsh', 'loop.md')])
})

test('the missing-task error lists both candidate paths', async () => {
  const { cwd, dshHome, env } = await scratch({})
  const message = missingTaskMessage(cwd, env)
  assert.match(message, /No task given/u)
  assert.ok(message.includes(join(cwd, '.dsh', 'loop.md')), 'the project path must be listed')
  assert.ok(message.includes(join(dshHome, 'loop.md')), 'the DSH_HOME path must be listed')
  await rm(join(cwd, '..'), { recursive: true, force: true })
})
