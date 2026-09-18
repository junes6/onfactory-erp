import { parentPort, workerData } from 'node:worker_threads'

import { prepareMaterial } from './material-html.mjs'

/**
 * 검토 자료 분석은 별도 스레드에서 돈다. 수십 MB짜리 HTML을 읽는 동안 서버의 다른 요청이 멈추지 않게 하고,
 * 이상한 자료가 무한히 돌아도 부르는 쪽이 시간 제한으로 이 스레드를 끝낼 수 있게 한다.
 * 그림 바이트는 복사하지 않고 넘긴다(transfer).
 */
try {
  const result = prepareMaterial(workerData.html, workerData.options ?? {})
  const transfer = []
  const assets = result.assets.map((asset) => {
    const bytes = asset.bytes.buffer.slice(asset.bytes.byteOffset, asset.bytes.byteOffset + asset.bytes.byteLength)
    transfer.push(bytes)
    return { ...asset, bytes }
  })
  parentPort.postMessage({ ok: true, result: { ...result, assets } }, transfer)
} catch (error) {
  parentPort.postMessage({ ok: false, error: { code: error?.code ?? 'MATERIAL_PARSE_FAILED', message: error?.message ?? String(error) } })
}
