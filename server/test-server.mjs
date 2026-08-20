import { once } from 'node:events'

// WHATWG Fetch blocks these ports even on localhost. Windows may occasionally
// hand one of them to listen(0), so tests must reject it before building a URL.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
])

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

export async function withServer(app, run) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address && typeof address === 'object' && !FETCH_BLOCKED_PORTS.has(address.port)) {
      try {
        return await run(`http://127.0.0.1:${address.port}`)
      } finally {
        await closeServer(server)
      }
    }
    await closeServer(server)
  }
  throw new Error('Fetch가 허용하는 로컬 테스트 포트를 확보하지 못했습니다.')
}
