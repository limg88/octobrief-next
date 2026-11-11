// Entry of the extraction child process (see isolated.ts for the parent side and the wire format).
// stdin: [4-byte big-endian header length][header JSON {mediaType, fileName}][file bytes]
// stdout: the Extraction as one JSON document.
import { extract } from './extract.ts'
import { startWatchdog } from './watchdog.ts'

// First, before any parsing: a stuck parser must not outlive the parent or the time limit.
startWatchdog(process.argv)

async function readStdin(): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of process.stdin) parts.push(part as Buffer)
  return Buffer.concat(parts)
}

const input = await readStdin()
const headerLength = input.readUInt32BE(0)
const header = JSON.parse(input.subarray(4, 4 + headerLength).toString('utf8')) as {
  mediaType: string
  fileName: string
}
const bytes = new Uint8Array(
  input.buffer,
  input.byteOffset + 4 + headerLength,
  input.length - 4 - headerLength,
)
const extraction = await extract(bytes, header.mediaType, header.fileName)
process.stdout.write(JSON.stringify(extraction))
