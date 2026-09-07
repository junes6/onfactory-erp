import { useCallback, useEffect, useState } from 'react'
import { History, RotateCcw, X } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import { ErrorState, Skeleton } from '../ui/States'
import { useDialogFocus } from '../CompletionModal'
import { formatDateTime } from '../../utils/dateTime'

/**
 * 개정 이력.
 *
 * 되돌리기는 이력을 다시 쓰지 않는다 — 새 버전을 만들고 그 사이 버전은 목록에 그대로 남는다.
 * 그래서 확인 문구가 "사라집니다"라고 말하는 것은 **문서의 지금 내용**이지 이력이 아니다.
 * 몇 개가 걷히는지는 추정하지 않고 목록에서 실제로 센다.
 *
 * 밀린 문장 하나만 되살리는 문도 여기 있다. 문서 전체를 되돌리지 않고 그 한 줄만 가져오는 것이
 * 사람이 실제로 원하는 일인 경우가 많다.
 */

export type RevisionRow = {
  id: string
  version: number
  at: string
  byId: string
  byName: string
  summary: string
  changed: { inserted: string[]; updated: string[]; deleted: string[]; moved: string[] }
  restoredFrom: number | null
  hasSnapshot: boolean
  overwriteCount: number
  hasLost: boolean
}

type DiffPreview = { id: string; type: string; preview?: string; beforePreview?: string; afterPreview?: string }
type RevisionDetail = {
  version: number
  title: string
  blocks: { id: string; type: string; text?: string }[]
  diff: { added: DiffPreview[]; removed: DiffPreview[]; changed: DiffPreview[]; moved: string[] }
  overwrites: { blockId: string; previousText: string; previousByName: string }[]
  lostEdits: { blockId: string | null; text: string; byName: string }[]
}

export function WikiRevisions({ documentId, currentVersion, canWrite, headers, focusVersion, onClose, onRestored, onToast }: {
  documentId: string
  currentVersion: number
  canWrite: boolean
  headers: Record<string, string>
  /** 인라인 '이력에서 보기'가 지목한 버전. 열자마자 그 상세를 편다. */
  focusVersion: number | null
  onClose: () => void
  onRestored: () => void
  onToast: (message: string) => void
}) {
  const [rows, setRows] = useState<RevisionRow[] | null>(null)
  const [oldestVersion, setOldestVersion] = useState<number | null>(null)
  const [retention, setRetention] = useState<{ maxRevisions: number; budgetChars: number } | null>(null)
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [openVersion, setOpenVersion] = useState<number | null>(focusVersion)
  const [detail, setDetail] = useState<RevisionDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [confirming, setConfirming] = useState<RevisionRow | null>(null)
  const [busy, setBusy] = useState(false)
  const confirmRef = useDialogFocus(Boolean(confirming))

  /**
   * 한 쪽을 읽는다. 서버는 한 번에 `MAX_REVISION_PAGE`(50)줄까지만 준다 —
   * 인자를 보내지 않으면 첫 쪽만 오고, 그 뒤 버전들은 보관돼 있고 복원까지 되는데 화면에서 닿을 길이 없다.
   */
  const load = useCallback(async (before?: number) => {
    setError('')
    if (before !== undefined) setLoadingMore(true)
    try {
      const query = before === undefined ? '' : `?before=${encodeURIComponent(String(before))}`
      const response = await fetch(`/api/wiki/${encodeURIComponent(documentId)}/revisions${query}`, { headers })
      const body = await response.json().catch(() => ({})) as {
        revisions?: RevisionRow[]; oldestVersion?: number | null
        retention?: { maxRevisions: number; budgetChars: number }; error?: { message?: string }
      }
      if (!response.ok) throw new Error(body.error?.message || '이력을 불러오지 못했습니다.')
      const page = body.revisions ?? []
      // 이어 읽기는 **덧붙인다**. 다시 읽기(before 없음)는 갈아 끼운다 — 되돌리기 뒤에는 목록이 통째로 바뀐다.
      setRows((current) => (before === undefined || current === null ? page : [...current, ...page]))
      setOldestVersion(body.oldestVersion ?? null)
      setRetention(body.retention ?? null)
    } catch (cause) {
      if (before === undefined) setRows([])
      setError(cause instanceof Error ? cause.message : '이력을 불러오지 못했습니다.')
    } finally {
      setLoadingMore(false)
    }
  }, [documentId, headers])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (openVersion === null) { setDetail(null); setDetailError(''); return }
    let cancelled = false
    setDetail(null)
    setDetailError('')
    void (async () => {
      try {
        const response = await fetch(`/api/wiki/${encodeURIComponent(documentId)}/revisions/${openVersion}`, { headers })
        const body = await response.json().catch(() => ({})) as RevisionDetail & { error?: { message?: string } }
        if (cancelled) return
        if (!response.ok) throw new Error(body.error?.message || '그 버전을 불러오지 못했습니다.')
        setDetail(body)
      } catch (cause) {
        if (!cancelled) setDetailError(cause instanceof Error ? cause.message : '그 버전을 불러오지 못했습니다.')
      }
    })()
    return () => { cancelled = true }
  }, [documentId, headers, openVersion])

  const restore = async (row: RevisionRow) => {
    setBusy(true)
    try {
      const response = await fetch(`/api/wiki/${encodeURIComponent(documentId)}/restore`, {
        method: 'POST', headers, body: JSON.stringify({ version: row.version, expectedCurrentVersion: currentVersion }),
      })
      const body = await response.json().catch(() => ({})) as { version?: number; error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '되돌리지 못했습니다.')
      onToast(`버전 ${row.version}의 내용으로 되돌렸습니다. 되돌리기 자체도 새 버전으로 남습니다.`)
      setConfirming(null)
      await load()
      onRestored()
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '되돌리지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const reinstate = async (version: number, blockId: string) => {
    setBusy(true)
    try {
      const response = await fetch(`/api/wiki/${encodeURIComponent(documentId)}/revisions/${version}/blocks/${encodeURIComponent(blockId)}/reinstate`, {
        method: 'POST', headers, body: JSON.stringify({}),
      })
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '그 문장을 되살리지 못했습니다.')
      onToast('밀렸던 문장을 그 문단에 다시 넣었습니다.')
      await load()
      onRestored()
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '그 문장을 되살리지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 되돌리면 문서에서 걷히는 변경 수.
   *
   * 목록에서 세지 않는다 — 목록은 한 쪽(50줄)에서 끊기므로, 그 뒤에 121번째 버전이 있어도 "49개가
   * 사라집니다"라고 말하게 된다. 버전은 한 번에 하나씩만 오르므로 두 버전의 차가 곧 그 수다(설계 §4-5).
   */
  const dropCount = (version: number) => Math.max(0, currentVersion - version)

  const shown = rows ?? []
  const oldestShown = shown.length ? Math.min(...shown.map((row) => Number(row.version))) : null
  /** 보관돼 있는데 아직 안 가져온 쪽이 있는가. 서버가 준 `oldestVersion`은 **전체** 기준이다. */
  const hasMore = oldestShown !== null && oldestVersion !== null && oldestShown > oldestVersion
  /** 지금 펼친 버전이 목록 밖(다음 쪽)에 있는가 — 인라인 '이력에서 보기'가 그리로 보낼 수 있다. */
  const focusOutsidePage = openVersion !== null && shown.every((row) => row.version !== openVersion)

  const revisionDetail = (version: number) => (
    <div className="wiki-revisions-detail">
      {detailError && <ErrorState detail={detailError} onRetry={() => setOpenVersion(version)} />}
      {!detail && !detailError && <Skeleton rows={2} variant="text" />}
      {detail && detail.version === version && (
        <>
          <ul className="wiki-diff">
            {detail.diff.added.map((entry) => <li key={`a${entry.id}`} data-diff="added"><span>추가</span>{entry.preview}</li>)}
            {detail.diff.removed.map((entry) => <li key={`r${entry.id}`} data-diff="removed"><span>삭제</span>{entry.preview}</li>)}
            {detail.diff.changed.map((entry) => (
              <li key={`c${entry.id}`} data-diff="changed">
                <span>수정</span>
                <del>{entry.beforePreview}</del>
                <ins>{entry.afterPreview}</ins>
              </li>
            ))}
            {detail.diff.moved.length > 0 && <li data-diff="moved"><span>이동</span>문단 {detail.diff.moved.length}개의 자리가 바뀌었습니다</li>}
          </ul>
          {detail.overwrites.map((entry) => (
            <div className="wiki-revisions-lost" key={`o${entry.blockId}`}>
              <p><strong>{entry.previousByName || '다른 사람'}</strong>님이 쓰던 문장이 이 버전에서 밀렸습니다.</p>
              <blockquote>{entry.previousText}</blockquote>
              {canWrite && (
                <Button tone="quiet" size="sm" disabled={busy} onClick={() => void reinstate(version, entry.blockId)}>
                  이 문장으로 다시 쓰기
                </Button>
              )}
            </div>
          ))}
          {detail.lostEdits.map((entry, index) => (
            <div className="wiki-revisions-lost" key={`l${entry.blockId ?? 'none'}${index}`}>
              <p><strong>{entry.byName || '누군가'}</strong>님의 편집이 대상 문단을 잃어 저장되지 못했습니다.</p>
              <blockquote>{entry.text}</blockquote>
              {canWrite && entry.blockId && (
                <Button tone="quiet" size="sm" disabled={busy} onClick={() => void reinstate(version, entry.blockId as string)}>
                  이 문장으로 다시 쓰기
                </Button>
              )}
            </div>
          ))}
          {canWrite && version !== currentVersion && (
            <Button
              tone="secondary" size="sm" disabled={busy}
              onClick={() => setConfirming(shown.find((row) => row.version === version) ?? {
                id: `WREV-${version}`, version, at: '', byId: '', byName: '', summary: '',
                changed: { inserted: [], updated: [], deleted: [], moved: [] },
                restoredFrom: null, hasSnapshot: false, overwriteCount: 0, hasLost: false,
              })}
            >
              <RotateCcw size={14} /> 이 버전으로 되돌리기
            </Button>
          )}
        </>
      )}
    </div>
  )

  return (
    <aside className="wiki-revisions" aria-label="개정 이력">
      <header className="wiki-revisions-head">
        <h2><History size={16} aria-hidden="true" /> 개정 이력</h2>
        <IconButton aria-label="이력 닫기" tone="quiet" size="sm" onClick={onClose}><X size={16} /></IconButton>
      </header>
      {oldestVersion !== null && oldestVersion > 1 && (
        <p className="wiki-revisions-note">버전 {oldestVersion}보다 앞선 이력은 보관 기간이 지나 정리되었습니다.</p>
      )}
      {error && <ErrorState detail={error} onRetry={() => { void load() }} />}
      {rows === null && !error && <Skeleton rows={4} />}
      {rows !== null && shown.length === 0 && !error && <p className="wiki-revisions-note">아직 남은 이력이 없습니다.</p>}
      {/* 목록 밖(다음 쪽)의 버전을 인라인 안내가 지목했을 때. 상세를 목록 안에서만 그리면 아무것도 안 뜬다. */}
      {focusOutsidePage && openVersion !== null && (
        <div className="wiki-revisions-focus">
          <p className="wiki-revisions-note">
            버전 {openVersion} · {hasMore ? '목록에서는 아래 ‘더 보기’로 닿습니다.' : '이 버전은 목록에 남아 있지 않습니다.'}
          </p>
          {revisionDetail(openVersion)}
        </div>
      )}
      <ol className="wiki-revisions-list">
        {shown.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="wiki-revisions-row"
              aria-expanded={openVersion === row.version}
              onClick={() => setOpenVersion(openVersion === row.version ? null : row.version)}
            >
              <strong>버전 {row.version}{row.version === currentVersion ? ' · 지금' : ''}</strong>
              <span>{row.summary}</span>
              <small>{row.byName || '알 수 없음'} · {formatDateTime(row.at)}</small>
              {row.overwriteCount > 0 && <em className="wiki-revisions-flag">밀린 문장 {row.overwriteCount}건</em>}
            </button>
            {openVersion === row.version && revisionDetail(row.version)}
          </li>
        ))}
      </ol>
      {/*
        목록이 어디서 끝났는지 말한다. 서버는 한 번에 50줄까지만 주므로, 이 줄이 없으면 헤더가
        '이력 121'이라고 말하는 동안 서랍은 50줄만 그리고 나머지 71개 버전은 화면에서 닿을 길이 없다.
      */}
      {shown.length > 0 && hasMore && oldestShown !== null && (
        <Button tone="quiet" size="sm" disabled={loadingMore} onClick={() => { void load(oldestShown) }}>
          {loadingMore ? '불러오는 중…' : `더 보기 (버전 ${oldestShown - 1}부터)`}
        </Button>
      )}
      {shown.length > 0 && !hasMore && retention && (
        <p className="wiki-revisions-note">
          여기까지 보관합니다 · {retention.maxRevisions}개 또는 {Math.round(retention.budgetChars / 1_000_000)}MB 중 먼저 닿는 쪽
        </p>
      )}

      {confirming && (
        <div className="wiki-dialog-backdrop" role="presentation">
          <section className="wiki-dialog" role="dialog" aria-modal="true" aria-labelledby="wiki-restore-title" ref={confirmRef}>
            <h3 id="wiki-restore-title">버전 {confirming.version}으로 되돌릴까요?</h3>
            <p>
              지금 본문은 버전 {confirming.version}의 내용으로 바뀌고, 그 뒤 {dropCount(confirming.version)}개의 변경이 본문에서 사라집니다.
              되돌리기도 새 버전으로 남으므로 지금 내용은 이력에서 다시 꺼낼 수 있습니다.
            </p>
            <div className="wiki-dialog-actions">
              <Button tone="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>취소</Button>
              <Button tone="secondary" size="sm" disabled={busy} onClick={() => void restore(confirming)}>
                {busy ? '되돌리는 중…' : '되돌리기'}
              </Button>
            </div>
          </section>
        </div>
      )}
    </aside>
  )
}
