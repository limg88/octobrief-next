import { Inflate, strFromU8, unzipSync } from 'fflate'
import { MAX_UNCOMPRESSED_BYTES, MAX_ZIP_ENTRIES } from './limits.ts'

export type ZipOutcome =
  | { ok: true; files: Record<string, Uint8Array> }
  | { ok: false; reason: 'encrypted' | 'unsupported' }

/**
 * Start of the old Office container (OLE). A password-protected .docx/.xlsx/.pptx is stored in it,
 * but so are the legacy .doc/.xls/.ppt formats, which are not encrypted: they are reported as
 * `encrypted` too. That is deliberately conservative (nothing is read, and the PM is told the file
 * cannot be opened), not a claim that every such file has a password.
 */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]

/**
 * Reads the wanted entries of a zip. Entry count and total declared size are checked before
 * anything is inflated, and each inflated entry is bounded by its declared size, so a zip bomb is
 * refused instead of unpacked. Never throws.
 */
export function readZip(bytes: Uint8Array, wanted: (name: string) => boolean): ZipOutcome {
  if (OLE_MAGIC.every((b, i) => bytes[i] === b)) return { ok: false, reason: 'encrypted' }
  try {
    let entries = 0
    let total = 0
    unzipSync(bytes, {
      filter: (file) => {
        entries++
        total += file.originalSize
        return false
      },
    })
    if (entries > MAX_ZIP_ENTRIES || total > MAX_UNCOMPRESSED_BYTES) {
      return { ok: false, reason: 'unsupported' }
    }
    const files = unzipSync(bytes, { filter: (file) => wanted(file.name) })
    return { ok: true, files }
  } catch {
    return { ok: false, reason: 'unsupported' }
  }
}

/** An entry of a zip as its central directory declares it. */
export interface ZipEntry {
  name: string
  /** 0 (stored) or 8 (deflated). */
  method: number
  compressedSize: number
  declaredSize: number
  /** Where its data starts, after its local header. */
  dataOffset: number
}

/** A zip that cannot be read exactly as it declares itself. */
export class ZipUnreadable extends Error {}

const u16 = (b: Uint8Array, at: number): number => {
  if (at + 2 > b.length) throw new ZipUnreadable()
  return (b[at] as number) | ((b[at + 1] as number) << 8)
}
const u32 = (b: Uint8Array, at: number): number => {
  if (at + 4 > b.length) throw new ZipUnreadable()
  return (u16(b, at) + u16(b, at + 2) * 0x10000) >>> 0
}
const END_OF_DIRECTORY = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50
const utf8Names = new TextDecoder('utf-8', { fatal: true })

/**
 * The entries of a zip, from its central directory, as `fflate` names them (UTF-8 when the entry
 * says so, Latin-1 otherwise). Stricter than `fflate`: a zip64 archive (a template never needs
 * one), an encrypted entry, a compression other than stored or deflated, a wrong signature or an
 * offset outside the file throws `ZipUnreadable`. Nothing is inflated.
 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  let end = bytes.length - 22
  while (end >= 0 && u32(bytes, end) !== END_OF_DIRECTORY) {
    if (bytes.length - end > 65_557) throw new ZipUnreadable()
    end--
  }
  if (end < 0) throw new ZipUnreadable()
  if (end >= 20 && u32(bytes, end - 20) === ZIP64_LOCATOR) throw new ZipUnreadable()
  // The directory is read exactly where the end record says it lies and as long as it says, on a
  // single disk, with nothing after the end record but its own comment: then every reader (Python's
  // `zipfile` in the renderer too) sees the same entries this gate scans.
  if (u16(bytes, end + 4) !== 0 || u16(bytes, end + 6) !== 0) throw new ZipUnreadable()
  const count = u16(bytes, end + 10)
  if (u16(bytes, end + 8) !== count) throw new ZipUnreadable()
  const directorySize = u32(bytes, end + 12)
  const directoryOffset = u32(bytes, end + 16)
  if (directoryOffset + directorySize !== end) throw new ZipUnreadable()
  if (u16(bytes, end + 20) !== bytes.length - end - 22) throw new ZipUnreadable()
  let at = directoryOffset
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== DIRECTORY_ENTRY) throw new ZipUnreadable()
    const flags = u16(bytes, at + 8)
    const method = u16(bytes, at + 10)
    const compressedSize = u32(bytes, at + 20)
    const declaredSize = u32(bytes, at + 24)
    const nameLength = u16(bytes, at + 28)
    const next = at + 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32)
    const local = u32(bytes, at + 42)
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) throw new ZipUnreadable()
    if (at + 46 + nameLength > bytes.length) throw new ZipUnreadable()
    const raw = bytes.subarray(at + 46, at + 46 + nameLength)
    let name: string
    try {
      name = (flags & 2048) !== 0 ? utf8Names.decode(raw) : strFromU8(raw, true)
    } catch {
      throw new ZipUnreadable()
    }
    if (u32(bytes, local) !== LOCAL_HEADER) throw new ZipUnreadable()
    const dataOffset = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28)
    if (dataOffset + compressedSize > bytes.length) throw new ZipUnreadable()
    entries.push({ name, method, compressedSize, declaredSize, dataOffset })
    at = next
  }
  // As many records as the directory holds: none hidden after the declared count.
  if (at !== end) throw new ZipUnreadable()
  return entries
}

/** Compressed input handed to the inflater at a time: bounds what one step can produce. */
const INFLATE_STEP = 16 * 1024

/**
 * The data of one entry, which must be exactly as long as the entry declares: inflated without a
 * buffer of fixed size (one would silently cut what lies beyond it), step by step, stopping as
 * soon as it grows past the declared size. A shorter, a longer or a broken entry throws
 * `ZipUnreadable`.
 */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const input = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  if (entry.method === 0) {
    if (input.length !== entry.declaredSize) throw new ZipUnreadable()
    return input.slice()
  }
  const out = new Uint8Array(entry.declaredSize)
  let written = 0
  const inflater = new Inflate((chunk) => {
    if (written + chunk.length > out.length) throw new ZipUnreadable()
    out.set(chunk, written)
    written += chunk.length
  })
  try {
    if (input.length === 0) inflater.push(input, true)
    for (let at = 0; at < input.length; at += INFLATE_STEP) {
      inflater.push(input.subarray(at, at + INFLATE_STEP), at + INFLATE_STEP >= input.length)
    }
  } catch {
    throw new ZipUnreadable()
  }
  if (written !== entry.declaredSize) throw new ZipUnreadable()
  return out
}
