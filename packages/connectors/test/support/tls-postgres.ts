import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSSocket } from 'node:tls'

/** A throwaway self-signed certificate for `name`, made now and never stored. */
export function selfSigned(name: string): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'octobrief-pg-tls-'))
  try {
    const key = join(dir, 'server.key')
    const cert = join(dir, 'server.crt')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        `/CN=${name}`,
        '-addext',
        `subjectAltName=DNS:${name}`,
      ],
      { stdio: 'ignore' },
    )
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A throwaway company authority, made now and never stored: a root, an issuing authority it
 * signed, and a certificate for `name` the issuing authority signed. `chain` is the issuing
 * authority then the root, as an Admin would paste them.
 */
export function signedByAuthority(name: string): {
  key: string
  cert: string
  root: string
  chain: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'octobrief-pg-ca-'))
  const at = (file: string) => join(dir, file)
  const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' })
  const newKey = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes']
  try {
    openssl(
      'req',
      '-x509',
      ...newKey,
      '-keyout',
      at('root.key'),
      '-out',
      at('root.crt'),
      '-days',
      '1',
      '-subj',
      '/CN=Synthetic Root CA',
    )
    writeFileSync(
      at('ca.ext'),
      'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n',
    )
    writeFileSync(at('leaf.ext'), `subjectAltName=DNS:${name}\n`)
    openssl(
      'req',
      ...newKey,
      '-keyout',
      at('issuing.key'),
      '-out',
      at('issuing.csr'),
      '-subj',
      '/CN=Synthetic Issuing CA',
    )
    openssl(
      'x509',
      '-req',
      '-in',
      at('issuing.csr'),
      '-CA',
      at('root.crt'),
      '-CAkey',
      at('root.key'),
      '-CAcreateserial',
      '-out',
      at('issuing.crt'),
      '-days',
      '1',
      '-extfile',
      at('ca.ext'),
    )
    openssl(
      'req',
      ...newKey,
      '-keyout',
      at('server.key'),
      '-out',
      at('server.csr'),
      '-subj',
      `/CN=${name}`,
    )
    openssl(
      'x509',
      '-req',
      '-in',
      at('server.csr'),
      '-CA',
      at('issuing.crt'),
      '-CAkey',
      at('issuing.key'),
      '-CAcreateserial',
      '-out',
      at('server.crt'),
      '-days',
      '1',
      '-extfile',
      at('leaf.ext'),
    )
    const read = (file: string) => readFileSync(at(file), 'utf8')
    return {
      key: read('server.key'),
      cert: read('server.crt'),
      root: read('root.crt'),
      chain: read('issuing.crt') + read('root.crt'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The SSLRequest code of the Postgres protocol. */
const SSL_REQUEST = 80_877_103

/**
 * A Postgres that speaks TLS: it answers the client's SSLRequest, terminates TLS with the given
 * certificate and passes the decrypted protocol to the plain test Postgres. It records the
 * server name each client asked for.
 */
export interface TlsPostgres {
  port: number
  servernames: string[]
  close(): Promise<void>
}

export async function startTlsPostgres(
  certificate: { key: string; cert: string },
  upstream: { host: string; port: number },
): Promise<TlsPostgres> {
  const servernames: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', (first) => {
      if (first.length !== 8 || first.readUInt32BE(4) !== SSL_REQUEST) {
        socket.destroy()
        return
      }
      socket.write('S')
      const secure = new TLSSocket(socket, { isServer: true, ...certificate })
      secure.on('error', () => socket.destroy())
      secure.once('secure', () => {
        servernames.push(String((secure as unknown as { servername?: string }).servername ?? ''))
        const plain = connect(upstream.port, upstream.host)
        sockets.add(plain)
        plain.on('error', () => secure.destroy())
        plain.on('close', () => sockets.delete(plain))
        secure.pipe(plain).pipe(secure)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    servernames,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
