const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function dosTimestamp(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date('1980-01-01T00:00:00.000Z')
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()))
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

export function safeArchiveSegment(value, fallback = 'file') {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\\/\0\r\n\t:*?"<>|]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 120)
  return normalized || fallback
}

export function createStoredZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('ZIP 항목이 비어 있습니다.')
  if (entries.length > 200) throw new RangeError('ZIP 항목은 200개까지 만들 수 있습니다.')

  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry?.body) ? entry.body : Buffer.from(entry?.body ?? '')
    if (body.length > 50 * 1024 * 1024) throw new RangeError('ZIP의 단일 파일은 50MB를 넘을 수 없습니다.')
    const name = String(entry?.name ?? '')
    if (!name || /(?:^|\/)\.\.(?:\/|$)|[\0\r\n]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      throw new TypeError('안전하지 않은 ZIP 파일 경로입니다.')
    }
    const nameBytes = Buffer.from(name, 'utf8')
    const checksum = crc32(body)
    const stamp = dosTimestamp(entry?.modifiedAt ? new Date(entry.modifiedAt) : undefined)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(stamp.time, 10)
    localHeader.writeUInt16LE(stamp.date, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(body.length, 18)
    localHeader.writeUInt32LE(body.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, nameBytes, body)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(stamp.time, 12)
    centralHeader.writeUInt16LE(stamp.date, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(body.length, 20)
    centralHeader.writeUInt32LE(body.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBytes)
    offset += localHeader.length + nameBytes.length + body.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}
