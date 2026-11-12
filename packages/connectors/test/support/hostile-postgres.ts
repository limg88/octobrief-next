import { type AddressInfo, createServer, type Socket } from 'node:net'

/**
 * How the hostile server misbehaves:
 * - `rows`: answers every query with `count` rows, whatever LIMIT says;
 * - `huge_row`: answers with one row of `bytes` bytes;
 * - `flood`: answers with rows of 64 KiB for ever, until the client cuts;
 * - `cleartext` / `md5`: asks for the password in clear or as MD5 instead of SCRAM;
 * - `silent`: never answers a query, and keeps the connection open when the client says goodbye;
 * - `typed`: answers with one row of the given columns, each with its type oid and its text (as
 *   the real server sends `int8`, `numeric`, `date`, `timestamp`: text), or NULL;
 * - `error`: answers with an error of the given SQLSTATE and message.
 */
export type HostileMode =
  | { kind: 'rows'; count: number }
  | { kind: 'huge_row'; bytes: number }
  | { kind: 'flood' }
  | { kind: 'cleartext' }
  | { kind: 'md5' }
  | { kind: 'silent' }
  | { kind: 'typed'; columns: { name: string; oid: number; text: string | null }[] }
  | { kind: 'error'; sqlstate: string; message: string }

export interface HostilePostgres {
  port: number
  /** Every byte the clients sent, in order. */
  received: Buffer[]
  /** Bytes of rows sent before the client cut the connection. */
  sent: number
  /** Whether a client closed the connection while the server was still sending. */
  cut: boolean
  close(): Promise<void>
}

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.write(type, 0, 'latin1')
  head.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([head, body])
}

const int32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n)
  return b
}
const int16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeInt16BE(n)
  return b
}

const AUTH_OK = message('R', int32(0))
const READY = message('Z', Buffer.from('I'))
const PARSE_COMPLETE = message('1', Buffer.alloc(0))
const BIND_COMPLETE = message('2', Buffer.alloc(0))
const COMPLETE = message('C', Buffer.from('SELECT 1\0'))
// One text column named "v".
const ROW_DESCRIPTION = message(
  'T',
  Buffer.concat([
    int16(1),
    Buffer.from('v\0'),
    int32(0),
    int16(0),
    int32(25),
    int16(-1),
    int32(-1),
    int16(0),
  ]),
)
const dataRow = (value: Buffer) =>
  message('D', Buffer.concat([int16(1), int32(value.length), value]))

function typedAnswer(columns: { name: string; oid: number; text: string | null }[]): Buffer {
  const description = message(
    'T',
    Buffer.concat([
      int16(columns.length),
      ...columns.map((c) =>
        Buffer.concat([
          Buffer.from(`${c.name}\0`),
          int32(0),
          int16(0),
          int32(c.oid),
          int16(-1),
          int32(-1),
          int16(0),
        ]),
      ),
    ]),
  )
  const row = message(
    'D',
    Buffer.concat([
      int16(columns.length),
      ...columns.map((c) =>
        c.text === null
          ? int32(-1)
          : Buffer.concat([int32(Buffer.byteLength(c.text)), Buffer.from(c.text)]),
      ),
    ]),
  )
  return Buffer.concat([description, row])
}

function errorAnswer(sqlstate: string, text: string): Buffer {
  return message(
    'E',
    Buffer.concat([Buffer.from(`SERROR\0C${sqlstate}\0M${text}\0`), Buffer.from([0])]),
  )
}

/**
 * A server that speaks just enough of the Postgres protocol (no TLS) to misbehave: it accepts
 * any startup, then answers each simple query, or each extended query at its Sync, as its mode
 * says. It never honours LIMIT.
 */
export async function startHostilePostgres(mode: HostileMode): Promise<HostilePostgres> {
  const sockets = new Set<Socket>()
  const state: HostilePostgres = {
    port: 0,
    received: [],
    sent: 0,
    cut: false,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }

  function answer(socket: Socket, extended: boolean) {
    if (extended) socket.write(Buffer.concat([PARSE_COMPLETE, BIND_COMPLETE]))
    if (mode.kind === 'error') {
      socket.write(Buffer.concat([errorAnswer(mode.sqlstate, mode.message), READY]))
      return
    }
    if (mode.kind === 'typed') {
      socket.write(Buffer.concat([typedAnswer(mode.columns), COMPLETE, READY]))
      return
    }
    socket.write(ROW_DESCRIPTION)
    if (mode.kind === 'rows') {
      const row = dataRow(Buffer.from('x'))
      for (let i = 0; i < mode.count && !socket.destroyed; i += 1) {
        socket.write(row)
        state.sent += row.length
      }
    } else if (mode.kind === 'huge_row') {
      socket.write(dataRow(Buffer.alloc(mode.bytes, 'a')))
      state.sent += mode.bytes
    } else if (mode.kind === 'flood') {
      const row = dataRow(Buffer.alloc(64 * 1024, 'a'))
      const pump = () => {
        while (!socket.destroyed) {
          state.sent += row.length
          if (!socket.write(row)) {
            socket.once('drain', pump)
            return
          }
        }
      }
      pump()
      return
    }
    if (!socket.destroyed) socket.write(Buffer.concat([COMPLETE, READY]))
  }

  // Silent, it keeps its side open when the client ends its own (half-open).
  const server = createServer({ allowHalfOpen: mode.kind === 'silent' }, (socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => {
      sockets.delete(socket)
      if (mode.kind === 'flood' || mode.kind === 'rows' || mode.kind === 'huge_row') {
        state.cut = true
      }
    })
    let buffer = Buffer.alloc(0)
    let started = false
    socket.on('data', (chunk: Buffer) => {
      state.received.push(chunk)
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (!started) {
          if (buffer.length < 4) return
          const length = buffer.readInt32BE(0)
          if (buffer.length < length) return
          buffer = buffer.subarray(length)
          started = true
          if (mode.kind === 'cleartext') socket.write(message('R', int32(3)))
          else if (mode.kind === 'md5') {
            socket.write(message('R', Buffer.concat([int32(5), Buffer.from([1, 2, 3, 4])])))
          } else socket.write(Buffer.concat([AUTH_OK, READY]))
          continue
        }
        if (buffer.length < 5) return
        const type = String.fromCharCode(buffer[0] as number)
        const length = buffer.readInt32BE(1)
        if (buffer.length < length + 1) return
        buffer = buffer.subarray(length + 1)
        if (mode.kind === 'silent') continue
        if (type === 'Q') answer(socket, false)
        else if (type === 'S') answer(socket, true)
        else if (type === 'X') socket.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.port = (server.address() as AddressInfo).port
  return state
}
