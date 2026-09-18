import { useEffect, useState } from 'react'
import { AlertTriangle, GitCompare, Link2, Unlink, X } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import { confirmLinks, fetchCompare, fetchLinkProposals, fetchNextVersionRequest, type CompareResult, type LinkProposal, type MaterialDetail } from './materialsApi'

/**
 * 판 사이 — 애매한 짝 확인과 판 비교.
 * 애매한 짝은 **확인하기 전까지 다른 항목**이다. 의견이 엉뚱한 항목으로 옮겨 가면 되돌리기 어렵기 때문이다.
 */
export function LinksDialog({ workspaceScope, material, version, onClose, onSaved, onToast }: {
  workspaceScope?: string
  material: MaterialDetail
  version: number
  onClose: () => void
  onSaved: (material: MaterialDetail) => void
  onToast: (message: string) => void
}) {
  const [proposals, setProposals] = useState<LinkProposal[] | null>(null)
  const [choices, setChoices] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    fetchLinkProposals(workspaceScope, material.id, version).then((rows) => { if (active) setProposals(rows) }).catch((cause: unknown) => onToast(cause instanceof Error ? cause.message : '확인할 짝을 불러오지 못했습니다.'))
    return () => { active = false }
  }, [workspaceScope, material.id, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const decided = Object.keys(choices).length
  const save = async () => {
    setBusy(true)
    try {
      const result = await confirmLinks(workspaceScope, material.id, version, Object.entries(choices).map(([nextId, same]) => ({ nextId, same })))
      onToast(`${result.joined}개를 지난 판의 같은 항목에 이었습니다${result.separate ? ` · ${result.separate}개는 다른 항목으로 두었습니다` : ''}.`)
      onSaved(result.material)
      onClose()
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '짝 확인을 저장하지 못했습니다.') } finally { setBusy(false) }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal-card material-dialog is-wide" role="dialog" aria-modal="true" aria-labelledby="material-links-title">
        <header>
          <div>
            <span className="eyebrow">MATCH ITEMS</span>
            <h2 id="material-links-title">지난 판과 같은 항목인가요?</h2>
            <p>비슷하지만 확실하지 않은 짝입니다. [같은 항목]을 고르면 지난 판의 의견·결정이 이 항목을 따라옵니다. 고르지 않은 짝은 다른 항목으로 둡니다.</p>
          </div>
          <IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={21} /></IconButton>
        </header>
        <div className="material-dialog-body">
          {!proposals ? <p className="material-loading">불러오는 중입니다…</p> : proposals.length === 0 ? <p className="material-loading">확인할 짝이 없습니다.</p> : (
            <ul className="material-links">
              {proposals.map((row) => (
                <li key={row.nextId}>
                  <p className="material-links-reason">{row.status === 'key-reused' ? `번호(${row.nextKey})는 같은데 내용이 많이 다릅니다.` : `번호가 다르지만 내용이 비슷합니다(비슷한 정도 ${Math.round(row.score * 100)}%).`}</p>
                  <div className="material-links-pair">
                    <div><small>지난 판 · {row.previousKey}</small><strong>{row.previousTitle}</strong>{row.before && <span>{row.before}…</span>}</div>
                    <div><small>이번 판 · {row.nextKey}</small><strong>{row.nextTitle}</strong>{row.after && <span>{row.after}…</span>}</div>
                  </div>
                  <div className="material-links-actions" role="radiogroup" aria-label={`${row.nextTitle} 짝`}>
                    <button type="button" role="radio" aria-checked={choices[row.nextId] === true} className="material-decision-option is-apply" onClick={() => setChoices((current) => ({ ...current, [row.nextId]: true }))}><Link2 size={15} aria-hidden="true" /> 같은 항목</button>
                    <button type="button" role="radio" aria-checked={choices[row.nextId] === false} className="material-decision-option is-hold" onClick={() => setChoices((current) => ({ ...current, [row.nextId]: false }))}><Unlink size={15} aria-hidden="true" /> 다른 항목</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer>
          <Button tone="ghost" type="button" disabled={busy} onClick={onClose}>나중에</Button>
          <Button tone="primary" type="button" disabled={busy || !decided} onClick={() => void save()}>{busy ? '저장 중…' : `고른 ${decided}개 저장`}</Button>
        </footer>
      </section>
    </div>
  )
}

/**
 * 다음 판 요청서 — 결정·질문·번호 규칙을 한 글로. 이것을 앱 밖의 AI에 붙여 넣으면 다음 판이 번호대로 이어진다.
 */
export function NextVersionDialog({ workspaceScope, material, onClose, onToast }: {
  workspaceScope?: string
  material: MaterialDetail
  onClose: () => void
  onToast: (message: string) => void
}) {
  const [markdown, setMarkdown] = useState('')
  useEffect(() => {
    let active = true
    fetchNextVersionRequest(workspaceScope, material.id).then((body) => { if (active) setMarkdown(body.markdown) }).catch((cause: unknown) => onToast(cause instanceof Error ? cause.message : '다음 판 요청서를 만들지 못했습니다.'))
    return () => { active = false }
  }, [workspaceScope, material.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const copy = async () => {
    try { await navigator.clipboard.writeText(markdown); onToast('다음 판 요청서를 복사했습니다. AI 대화창에 붙여 넣으세요.') } catch { onToast('복사하지 못했습니다. 글을 직접 선택해 복사해 주세요.') }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${material.title} ${material.currentVersion + 1}판 요청서.md`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal-card material-dialog is-wide" role="dialog" aria-modal="true" aria-labelledby="material-next-title">
        <header>
          <div>
            <span className="eyebrow">NEXT VERSION</span>
            <h2 id="material-next-title">다음 판 요청서</h2>
            <p>팀의 결정·답이 필요한 질문·항목 번호 규칙을 한 글로 묶었습니다. 자료를 만든 AI(Claude 등)에 이 글을 그대로 붙여 넣으면, 다음 판을 올릴 때 항목이 번호대로 정확히 이어집니다.</p>
          </div>
          <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
        </header>
        <div className="material-dialog-body">
          {markdown ? <pre className="material-summary-text">{markdown}</pre> : <p className="material-loading">만드는 중입니다…</p>}
        </div>
        <footer>
          <Button tone="ghost" type="button" disabled={!markdown} onClick={download}>내려받기(.md)</Button>
          <Button tone="primary" type="button" disabled={!markdown} onClick={() => void copy()}>복사하기</Button>
        </footer>
      </section>
    </div>
  )
}

export function CompareDialog({ workspaceScope, material, onClose, onToast }: {
  workspaceScope?: string
  material: MaterialDetail
  onClose: () => void
  onToast: (message: string) => void
}) {
  const versions = [...material.versions].sort((left, right) => left.version - right.version)
  const [to, setTo] = useState(material.currentVersion)
  const [from, setFrom] = useState(Math.max(1, material.currentVersion - 1))
  const [result, setResult] = useState<CompareResult | null>(null)
  const [filter, setFilter] = useState<'all' | 'changed' | 'added' | 'removed'>('all')
  useEffect(() => {
    if (from === to) return
    let active = true
    setResult(null)
    fetchCompare(workspaceScope, material.id, Math.min(from, to), Math.max(from, to))
      .then((body) => { if (active) setResult(body) })
      .catch((cause: unknown) => onToast(cause instanceof Error ? cause.message : '두 판을 비교하지 못했습니다.'))
    return () => { active = false }
  }, [workspaceScope, material.id, from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const items = (result?.items ?? []).filter((item) => filter === 'all' || item.status === filter)
  const label = { changed: '바뀜', added: '새 항목', removed: '빠진 항목' } as const
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal-card material-dialog is-wide" role="dialog" aria-modal="true" aria-labelledby="material-compare-title">
        <header>
          <div>
            <span className="eyebrow">COMPARE</span>
            <h2 id="material-compare-title"><GitCompare size={20} aria-hidden="true" /> 판 비교</h2>
            <p>바뀐 곳만 모아 봅니다. 초록 밑줄은 <strong>추가</strong>, 빨간 줄은 <strong>삭제</strong>입니다.</p>
          </div>
          <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
        </header>
        <div className="material-dialog-body">
          <div className="material-compare-pick">
            <label><span>이전</span><select value={from} onChange={(event) => setFrom(Number(event.target.value))}>{versions.map((row) => <option key={row.version} value={row.version}>{row.version}판</option>)}</select></label>
            <span aria-hidden="true">→</span>
            <label><span>이후</span><select value={to} onChange={(event) => setTo(Number(event.target.value))}>{versions.map((row) => <option key={row.version} value={row.version}>{row.version}판</option>)}</select></label>
          </div>
          {from === to ? <p className="material-loading">서로 다른 두 판을 골라 주세요.</p> : !result ? <p className="material-loading">비교하는 중입니다…</p> : (
            <>
              <p className="material-compare-summary" role="status">
                {result.to}판: 바뀐 항목 <strong>{result.summary.changed}</strong> · 새 항목 <strong>{result.summary.added}</strong> · 빠진 항목 <strong>{result.summary.removed}</strong> · 그대로 {result.summary.same}
              </p>
              {result.reflection.decided > 0 && (
                <div className={`material-compare-reflection${result.reflection.unchanged.length ? ' is-warning' : ''}`}>
                  {result.reflection.unchanged.length ? <AlertTriangle size={17} aria-hidden="true" /> : null}
                  <div>
                    <strong>반영 확인</strong>: {result.from}판까지 반영하기로 한 {result.reflection.decided}건 중 {result.reflection.reflected}건은 내용이 바뀌었고, <strong>{result.reflection.unchanged.length}건은 그대로</strong>입니다.
                    {result.reflection.unchanged.length > 0 && <ul>{result.reflection.unchanged.map((row) => <li key={row.lineageId}>{row.title}</li>)}</ul>}
                  </div>
                </div>
              )}
              <div className="material-filters" role="group" aria-label="바뀐 종류">
                {(['all', 'changed', 'added', 'removed'] as const).map((id) => (
                  <button key={id} type="button" className="material-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>{id === 'all' ? '전체' : label[id]}</button>
                ))}
              </div>
              <ol className="material-compare-list">
                {items.map((item) => (
                  <li key={`${item.status}:${item.lineageId}`} className={`is-${item.status}`}>
                    <header><span className="material-compare-tag">{label[item.status]}</span><strong>{item.title}</strong>{item.previousTitle && item.previousTitle !== item.title && <small>(전: {item.previousTitle})</small>}</header>
                    {item.diff ? (
                      <p className="material-diff">
                        {item.diff.map((part, index) => part.op === 'equal' ? <span key={index}>{part.text} </span>
                          : part.op === 'insert' ? <ins key={index}><span className="sr-only">추가: </span>{part.text} </ins>
                            : <del key={index}><span className="sr-only">삭제: </span>{part.text} </del>)}
                      </p>
                    ) : <p className="material-diff">{item.after ?? item.before}</p>}
                  </li>
                ))}
                {!items.length && <li className="material-loading">이 종류의 바뀐 곳이 없습니다.</li>}
              </ol>
              {result.truncated && <p className="material-loading">바뀐 곳이 많아 앞쪽 400개만 보여 줍니다.</p>}
            </>
          )}
        </div>
        <footer><Button tone="primary" type="button" onClick={onClose}>닫기</Button></footer>
      </section>
    </div>
  )
}
