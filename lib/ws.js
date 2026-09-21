/**
 * Minimal RFC 6455 server-side WebSocket implementation.
 *
 * The plugin needs exactly one upgrade route carrying small JSON control frames
 * in and JPEG screencast frames out, so it ships its own ~200-line server
 * instead of a dependency: fewer moving parts for a package that is linked into
 * a running DSH host and published to npm.
 *
 * @module dsh-embedded-browser/ws
 */

import { createHash } from 'node:crypto'

/** RFC 6455 handshake magic string. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Opcodes this server understands. */
const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
}

/** Compute the `Sec-WebSocket-Accept` value for a client key. */
function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** Encode one server->client frame (never masked). */
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, body])
}

/**
 * One accepted WebSocket connection.
 *
 * Messages surface as `{ type: 'text' | 'binary', data: string | Buffer }`.
 */
export class WebSocketConnection {
  constructor(socket) {
    this.socket = socket
    this.handlers = new Map()
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = undefined
    this.closed = false
    this.socket.on('data', (chunk) => this.consume(chunk))
    this.socket.on('close', () => this.finish())
    this.socket.on('error', () => this.finish())
  }

  /** Subscribe to `message`, `close`, or `error`. */
  on(event, handler) {
    let set = this.handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  emit(event, payload) {
    const set = this.handlers.get(event)
    if (set === undefined) return
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch {
        /* a listener must not break the socket */
      }
    }
  }

  /** Send a JSON control message. */
  sendJson(value) {
    return this.sendText(JSON.stringify(value))
  }

  sendText(text) {
    return this.write(encodeFrame(OPCODE.text, text))
  }

  /** Send one binary frame (screencast image). */
  sendBinary(buffer) {
    return this.write(encodeFrame(OPCODE.binary, buffer))
  }

  write(frame) {
    if (this.closed) return false
    try {
      this.socket.write(frame)
      return true
    } catch {
      this.finish()
      return false
    }
  }

  /** Bytes queued but not yet flushed — used to drop frames under back-pressure. */
  get bufferedAmount() {
    return this.socket.writableLength ?? 0
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    const body = Buffer.alloc(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2)
    this.write(encodeFrame(OPCODE.close, body))
    this.closed = true
    this.socket.end()
  }

  finish() {
    if (this.closed && this.handlers.size === 0) return
    this.closed = true
    this.emit('close')
    this.socket.destroy()
  }

  consume(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.readFrame()
      if (frame === undefined) return
      if (frame.opcode === OPCODE.close) {
        this.closed = true
        this.write(encodeFrame(OPCODE.close, Buffer.alloc(0)))
        this.socket.end()
        return
      }
      if (frame.opcode === OPCODE.ping) {
        this.write(encodeFrame(OPCODE.pong, frame.payload))
        continue
      }
      if (frame.opcode === OPCODE.pong) continue
      if (frame.opcode === OPCODE.continuation) {
        this.fragments.push(frame.payload)
        if (!frame.fin) continue
        const payload = Buffer.concat(this.fragments)
        const opcode = this.fragmentOpcode
        this.fragments = []
        this.fragmentOpcode = undefined
        this.deliver(opcode, payload)
        continue
      }
      if (!frame.fin) {
        this.fragmentOpcode = frame.opcode
        this.fragments = [frame.payload]
        continue
      }
      this.deliver(frame.opcode, frame.payload)
    }
  }

  deliver(opcode, payload) {
    if (opcode === OPCODE.text) this.emit('message', { type: 'text', data: payload.toString('utf8') })
    else if (opcode === OPCODE.binary) this.emit('message', { type: 'binary', data: payload })
  }

  /** Parse one frame, returning undefined when the buffer holds only a fragment of it. */
  readFrame() {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined
    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return undefined
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return undefined
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(64 * 1024 * 1024)) {
        this.close(1009, 'frame too large')
        return undefined
      }
      length = Number(big)
      offset += 8
    }
    let mask
    if (masked) {
      if (buffer.length < offset + 4) return undefined
      mask = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return undefined
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (mask !== undefined) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
    }
    this.buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }
}

/**
 * Complete the upgrade handshake and hand the connection to `onConnection`.
 *
 * @param req - the HTTP upgrade request.
 * @param socket - the raw socket (ownership transfers to the connection).
 * @param head - bytes already read past the request headers.
 * @param onConnection - receives the live {@link WebSocketConnection}.
 * @returns whether the upgrade was accepted.
 */
export function acceptUpgrade(req, socket, head, onConnection) {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || key === '') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return false
  }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '\r\n',
  ]
  socket.write(headers.join('\r\n'))
  const connection = new WebSocketConnection(socket)
  if (head !== undefined && head.length > 0) connection.consume(head)
  onConnection(connection)
  return true
}
