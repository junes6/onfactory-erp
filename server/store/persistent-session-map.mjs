import { createHash } from 'node:crypto'

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export class PersistentSessionMap extends Map {
  constructor(entries = [], { onSet, onDelete } = {}) {
    super()
    this.onSet = onSet
    this.onDelete = onDelete
    this.pending = Promise.resolve()
    for (const [key, value] of entries) Map.prototype.set.call(this, key, value)
  }

  #key(tokenOrHash) {
    const value = String(tokenOrHash)
    return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : tokenHash(value)
  }

  canonicalKey(token) { return this.#key(token) }

  get(token) { return super.get(this.#key(token)) }
  has(token) { return super.has(this.#key(token)) }

  set(token, session) {
    const key = this.#key(token)
    super.set(key, session)
    // 앞선 저장이 실패했어도 이번 저장은 돈다. flush()는 마지막 저장의 결과만 말한다 —
    // 전에는 한 번 실패하면 사슬 전체가 거절 상태로 굳어 그 뒤의 모든 로그인이 503이 됐다.
    if (this.onSet) this.pending = this.pending.catch(() => undefined).then(() => this.onSet(key, structuredClone(session)))
    return this
  }

  delete(token) {
    const key = this.#key(token)
    const deleted = super.delete(key)
    if (deleted && this.onDelete) this.pending = this.pending.catch(() => undefined).then(() => this.onDelete(key))
    return deleted
  }

  async flush() { await this.pending }
}

export { tokenHash as hashSessionToken }
