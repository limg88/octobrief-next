import { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { extract } from '../src/extract/extract.ts'
import { childTimeoutMs, EXTRACTION_TIMEOUT_MS, extractIsolated } from '../src/extract/isolated.ts'
import { MAX_TIMER_MS } from '../src/extract/watchdog.ts'
import { docx, pdfWithPages, utf8, xlsx } from './support/files.ts'
import { hostile } from './support/modes.ts'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

describe('extractIsolated: happy path', () => {
  it('equals the in-process extraction for pdf, text, docx, xlsx and unknown', async () => {
    const cases: Array<[Uint8Array, string, string]> = [
      [
        await pdfWithPages(['Hello page one', 'Second page'], { created: new Date('2024-03-04') }),
        'application/pdf',
        'a.pdf',
      ],
      [utf8('first line\nsecond line\n'), 'text/plain', 'a.txt'],
      [docx(['Paragraph one', 'Paragraph two']), DOCX, 'a.docx'],
      [docx(['Riunione'], { created: '2026-06-03T08:00:00Z' }), DOCX, 'b.docx'],
      [
        xlsx([
          {
            name: 'Budget',
            rows: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Voce</t></is></c><c r="B1"><v>12</v></c></row></sheetData>',
          },
        ]),
        XLSX,
        'a.xlsx',
      ],
      [utf8('x'), 'application/octet-stream', 'a.bin'],
    ]
    for (const [bytes, type, name] of cases) {
      expect(await extractIsolated(bytes, type, name)).toEqual(await extract(bytes, type, name))
    }
  }, 60_000)
})

describe('extractIsolated: hostile child', () => {
  it('a spinning parser is stopped at the timeout', async () => {
    const start = performance.now()
    const r = await extractIsolated(
      utf8('x'),
      'text/plain',
      'a.txt',
      hostile('spin', { timeoutMs: 700 }),
    )
    expect(r.warnings).toEqual(['timeout'])
    expect(r.chunks).toEqual([])
    expect(r.truncated).toBe(false)
    expect(performance.now() - start).toBeLessThan(15_000)
  }, 30_000)

  it('memory exhaustion is a failed extraction, and the parent keeps working', async () => {
    const r = await extractIsolated(
      utf8('x'),
      'text/plain',
      'a.txt',
      hostile('oom', { timeoutMs: 40_000 }),
    )
    expect(r.warnings).toEqual(['extraction_failed'])
    const next = await extractIsolated(utf8('ok\n'), 'text/plain', 'a.txt')
    expect(next.chunks.length).toBe(1)
  }, 60_000)

  it('a non-zero exit and garbage output are failed extractions', async () => {
    for (const mode of ['exit', 'garbage']) {
      const r = await extractIsolated(utf8('x'), 'text/plain', 'a.txt', hostile(mode))
      expect(r.warnings).toEqual(['extraction_failed'])
    }
  }, 30_000)

  it('oversize output is cut: truncated, no chunks', async () => {
    const r = await extractIsolated(utf8('x'), 'text/plain', 'a.txt', hostile('big'))
    expect(r.truncated).toBe(true)
    expect(r.warnings).toEqual(['truncated'])
    expect(r.chunks).toEqual([])
  }, 30_000)

  it('the child sees only PATH', async () => {
    process.env.OCTOBRIEF_SECRET_PROBE = 'leak'
    try {
      const r = await extractIsolated(utf8('x'), 'text/plain', 'a.txt', hostile('env'))
      // macOS adds __CF_USER_TEXT_ENCODING to every exec: not ours, not inherited.
      const names = (JSON.parse(r.extractor) as string[]).filter(
        (n) => n !== '__CF_USER_TEXT_ENCODING',
      )
      expect(names).toEqual(['PATH'])
    } finally {
      delete process.env.OCTOBRIEF_SECRET_PROBE
    }
  }, 30_000)

  it('runs one child at a time', async () => {
    const started = performance.now()
    await Promise.all([
      extractIsolated(utf8('x'), 'text/plain', 'a.txt', hostile('spin', { timeoutMs: 800 })),
      extractIsolated(utf8('x'), 'text/plain', 'a.txt', hostile('spin', { timeoutMs: 800 })),
    ])
    expect(performance.now() - started).toBeGreaterThanOrEqual(1500)
  }, 30_000)
})

describe('extractIsolated: the timeout of the child', () => {
  it('stays within what a timer takes, and falls back to the default when not a duration', () => {
    expect(childTimeoutMs(undefined)).toBe(EXTRACTION_TIMEOUT_MS)
    expect(childTimeoutMs(700)).toBe(700)
    expect(childTimeoutMs(2 ** 40)).toBe(MAX_TIMER_MS)
    expect(childTimeoutMs(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_MS)
    for (const bad of [0, -5, Number.NaN]) expect(childTimeoutMs(bad)).toBe(EXTRACTION_TIMEOUT_MS)
  })
})

describe('extractIsolated: a stopped child', () => {
  it('gets one polite stop, and no forced one once it has exited (its PID may be reused)', async () => {
    const signals: unknown[] = []
    const send = ChildProcess.prototype.kill
    const spy = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
      this: ChildProcess,
      signal?: NodeJS.Signals | number,
    ) {
      signals.push(signal)
      return send.call(this, signal)
    })
    try {
      const r = await extractIsolated(
        utf8('x'),
        'text/plain',
        'a.txt',
        hostile('spin', { timeoutMs: 300 }),
      )
      expect(r.warnings).toEqual(['timeout'])
      // Past the grace of the forced stop: nothing more is sent to the exited child.
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      expect(signals).toEqual(['SIGTERM'])
    } finally {
      spy.mockRestore()
    }
  }, 30_000)
})

describe('extractIsolated: abort', () => {
  it('an abort stops the child promptly', async () => {
    const controller = new AbortController()
    const start = performance.now()
    const pending = extractIsolated(utf8('x'), 'text/plain', 'a.txt', {
      ...hostile('spin', { timeoutMs: 50_000 }),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 500)
    const r = await pending
    expect(r.warnings).toEqual(['extraction_failed'])
    expect(performance.now() - start).toBeLessThan(10_000)
  }, 30_000)

  it('an already aborted signal starts nothing', async () => {
    const r = await extractIsolated(utf8('x'), 'text/plain', 'a.txt', {
      ...hostile('spin', { timeoutMs: 50_000 }),
      signal: AbortSignal.abort(),
    })
    expect(r.warnings).toEqual(['extraction_failed'])
  }, 30_000)

  it('an abort after the end changes nothing and the next extraction works', async () => {
    const controller = new AbortController()
    const r = await extractIsolated(utf8('ok\n'), 'text/plain', 'a.txt', {
      signal: controller.signal,
    })
    controller.abort()
    expect(r.chunks.length).toBe(1)
    expect((await extractIsolated(utf8('ok\n'), 'text/plain', 'a.txt')).chunks.length).toBe(1)
  }, 30_000)
})
