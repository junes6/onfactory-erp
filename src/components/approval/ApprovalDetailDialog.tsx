import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Download, Lock, Printer, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { formatDateTime } from '../../utils/dateTime'
import { formatKrw, stepLabel } from '../../utils/approvalLine'
import { downloadAttachmentFrom } from '../../utils/documentAttachments'
import { StatusBadge } from '../StatusBadge'
import { Button, IconButton } from '../ui/Button'
import {
  APPROVAL_ATTACHMENT_CLOSED_MESSAGE,
  APPROVAL_REASON_REQUIRED_MESSAGE,
  APPROVAL_STATUS_TONE,
  type ApprovalDocument,
  type ApprovalForm,
  type ApprovalPermissions,
} from './approvalTypes'
import './approval.css'

const MIN_REJECTION_REASON = 5
const MAX_REJECTION_REASON = 500

/** 인쇄 창을 브라우저가 막았을 때의 한 문장. 열지 못한 이유와 푸는 길을 함께 말한다. */
const PRINT_BLOCKED = '인쇄 창이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.'

type DetailResponse = {
  document?: ApprovalDocument
  form?: ApprovalForm | null
  /**
   * 이 문서가 붙잡은 자료의 id와 이름. 이름의 출처는 서버 하나다(인쇄물·증빙과 같은 답).
   * `canRead` 는 **이 요청을 보낸 사람이** 그 파일을 실제로 열 수 있는가 — 서버가 매 요청 다시 잰다.
   * 열 수 없으면 서버가 **이름을 아예 주지 않는다**: 이 저장소에서 파일 이름은 종종 내용이고,
   * 내려받을 수 없는 파일에는 「무엇을 내려받는지 말해 준다」는 근거가 서지 않는다.
   */
  attachments?: { id: string; name?: string; canRead: boolean }[]
  permissions?: ApprovalPermissions
  delegateOf?: string | null
  error?: { message?: string }
}

/**
 * 결재 문서 한 건 — 내용·첨부·이력·결정.
 *
 * 「지금 결재할 수 있는가」는 화면이 짐작하지 않고 서버가 준 `permissions` 를 그대로 읽는다.
 * 목록은 60초마다만 갱신되므로 이미 남이 처리한 문서에 버튼이 잠깐 살아 있을 수 있는데,
 * 그때는 서버가 409·403 으로 막고 화면이 그 문장을 그대로 토스트로 옮긴다(규칙 1).
 */
export function ApprovalDetailDialog({ documentId, workspaceScope, onToast, onClose, onChanged }: {
  documentId: string
  workspaceScope?: string
  onToast: (message: string) => void
  onClose: () => void
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [downloading, setDownloading] = useState('')

  const headers = useMemo(() => (workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined), [workspaceScope])
  const jsonHeaders = useMemo(() => ({ 'content-type': 'application/json', ...(headers ?? {}) }), [headers])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/approval-documents/${encodeURIComponent(documentId)}`, { headers })
      const body = await response.json() as DetailResponse
      if (!response.ok || !body.document) throw new Error(body.error?.message || '결재 문서를 불러오지 못했습니다.')
      setDetail(body)
      setError('')
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : '결재 문서를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [documentId, headers])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const document = detail?.document ?? null
  const form = detail?.form ?? null
  const permissions = detail?.permissions ?? null

  const decide = async (decision: 'approve' | 'reject') => {
    if (busy || !document) return
    // 브라우저의 required·minLength 가 먼저 막지만, 자동완성·붙여넣기처럼 그 검사를 지나오는 길이 있다.
    // 여기서 다시 재고, 문구는 서버 사전과 같은 한 문장을 쓴다(규칙 3).
    if (decision === 'reject' && reason.trim().length < MIN_REJECTION_REASON) {
      onToast(APPROVAL_REASON_REQUIRED_MESSAGE)
      return
    }
    setBusy(true)
    try {
      const response = await fetch(`/api/approval-documents/${encodeURIComponent(document.id)}/decide`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ decision, comment, reason }),
      })
      const body = await response.json() as { document?: ApprovalDocument; error?: { message?: string } }
      if (!response.ok || !body.document) throw new Error(body.error?.message || '결재를 처리하지 못했습니다.')
      onToast(decision === 'approve'
        ? body.document.status === '승인' ? '최종 승인했습니다.' : '승인했습니다. 다음 단계로 넘어갑니다.'
        : '반려했습니다. 기안자에게 사유가 그대로 전달됩니다.')
      setRejecting(false)
      setReason('')
      setComment('')
      onChanged()
      await load()
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '결재를 처리하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const print = () => {
    try {
      const opened = window.open(`/api/approval-documents/${encodeURIComponent(documentId)}/print`, '_blank', 'width=860,height=1000')
      if (!opened) onToast(PRINT_BLOCKED)
    } catch {
      onToast(PRINT_BLOCKED)
    }
  }

  const valueLabel = (key: string) => form?.fields.find((field) => field.key === key)?.label ?? key
  const isMoney = (key: string) => form?.fields.find((field) => field.key === key)?.type === 'money'
  const attachments = detail?.attachments ?? []
  /**
   * 첨부 하나를 부르는 이름. 열 수 없는 첨부에는 서버가 이름을 주지 않으므로 그때는 고정 문구다 —
   * id(`DOC-…`)를 그대로 그리면 화면이 사람에게 아무 뜻 없는 글자를 보여 준다.
   */
  const attachmentName = (id: string) => {
    const entry = attachments.find((row) => row.id === id)
    if (!entry) return id
    return entry.name ?? APPROVAL_ATTACHMENT_CLOSED_MESSAGE
  }

  /**
   * 설계가 말한 「자료실 다운로드 링크」. 화면을 갈아 끼우지 않는다 —
   * 자료실로 보내면 App이 그 id를 버려(page가 'documents'인 갈래가 없다) 사람은 무엇이었는지
   * 표시되지 않는 첫 화면에 떨어지고, 그 사이 결재 목록이 언마운트되며 보던 상세도 닫힌다.
   */
  const download = async (id: string) => {
    if (downloading) return
    setDownloading(id)
    try {
      // 결재 범위 경로다. 결재는 자료실의 열람 명단을 고치지 않으므로(고치면 그 넓힘이 되돌아오지
      // 않는다) 자료실 경로로는 결재자가 근거를 열 수 없다. 여는 자격은 서버가 매 요청 다시 잰다.
      await downloadAttachmentFrom(
        `/api/approval-documents/${encodeURIComponent(documentId)}/attachments/${encodeURIComponent(id)}`,
        { id, name: attachmentName(id), size: '' },
        workspaceScope,
      )
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '첨부 파일을 내려받지 못했습니다.')
    } finally {
      setDownloading('')
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="modal-card approval-detail-modal" role="dialog" aria-modal="true" aria-labelledby="approval-detail-title">
      <header>
        <div>
          <span className="eyebrow">APPROVAL</span>
          <h2 id="approval-detail-title">{document?.title ?? '결재 문서'}</h2>
          <p>{document ? `${document.formName} · ${document.drafterName} · ${formatDateTime(document.submittedAt ?? document.createdAt)}` : '문서를 불러오는 중입니다.'}</p>
        </div>
        <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
      </header>

      {/* 반려 사유의 required·minLength 가 실제로 일을 하도록 반려는 form 제출로 보낸다. */}
      <form onSubmit={(event) => { event.preventDefault(); if (rejecting) void decide('reject') }}>
        {loading
          ? <p className="approval-doc-empty"><RefreshCw size={16} /> 불러오는 중</p>
          : error
            ? <div className="approval-doc-error"><span><ShieldAlert size={15} /> {error}</span><Button tone="ghost" size="sm" type="button" onClick={() => void load()}>다시 시도</Button></div>
            : document
              ? <>
                <p>
                  <StatusBadge className="status-pill" tone={APPROVAL_STATUS_TONE[document.status] ?? 'neutral'}>{document.status}</StatusBadge>
                  {' '}<span className="approval-doc-quiet">{stepLabel(document)}</span>
                  {detail?.delegateOf ? <> · <span className="approval-doc-quiet">대결로 결재합니다</span></> : null}
                </p>

                <table className="approval-detail-values">
                  <tbody>
                    {Object.entries(document.values).map(([key, value]) => <tr key={key}>
                      <th scope="row">{valueLabel(key)}</th>
                      <td>{isMoney(key) && typeof value === 'number'
                        ? formatKrw(value)
                        : typeof value === 'string' && value.startsWith('DOC-') ? attachmentName(value) : String(value)}</td>
                    </tr>)}
                    {document.posting
                      ? <tr><th scope="row">승인 시 집계</th><td>{document.posting.month} · {formatKrw(document.posting.amount)}</td></tr>
                      : null}
                    {document.status === '반려' && document.rejectionReason
                      ? <tr><th scope="row">반려 사유</th><td>{document.rejectionReason}</td></tr>
                      : null}
                  </tbody>
                </table>

                {attachments.length > 0
                  ? <ul className="approval-detail-attachments">
                    {attachments.map((entry) => <li key={entry.id}>
                      {entry.canRead
                        ? <Button tone="quiet" size="sm" type="button" disabled={downloading === entry.id} onClick={() => void download(entry.id)}>
                          <Download size={13} /> {downloading === entry.id ? '내려받는 중…' : attachmentName(entry.id)}
                        </Button>
                        : <span className="approval-attachment-closed"><Lock size={13} aria-hidden="true" /> {APPROVAL_ATTACHMENT_CLOSED_MESSAGE}</span>}
                    </li>)}
                  </ul>
                  : null}

                <h3>결재 이력</h3>
                <ul className="approval-history">
                  {document.history.map((entry, index) => <li key={`${entry.at}-${index + 1}`} className="approval-history-row">
                    <strong>{entry.actorName || '알 수 없음'}{entry.delegateOf ? ' (대결)' : ''} · {entry.action}</strong>
                    <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                    {entry.comment ? <span>{entry.comment}</span> : null}
                  </li>)}
                </ul>

                {permissions?.canDecide
                  ? <label className="form-field full">
                    <span>의견 <em className="field-optional">선택 · 이력에 그대로 남습니다</em></span>
                    <input value={comment} maxLength={MAX_REJECTION_REASON} onChange={(event) => setComment(event.target.value)} />
                  </label>
                  : null}

                {rejecting
                  ? <div className="approval-reject-form">
                    <p>반려 사유는 기안자에게 그대로 전달됩니다.</p>
                    <textarea
                      required
                      minLength={5}
                      maxLength={MAX_REJECTION_REASON}
                      value={reason}
                      placeholder="무엇을 고쳐 다시 올려야 하는지 적어 주세요."
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </div>
                  : null}

                <p className="approval-print-note">브라우저 인쇄 창에서 «대상: PDF로 저장»을 고르면 PDF 파일이 됩니다.</p>
              </>
              : null}

        <footer>
          <Button tone="ghost" type="button" onClick={print}><Printer size={16} /> 인쇄 · PDF 저장</Button>
          {permissions?.canDecide
            ? rejecting
              ? <Button tone="danger" type="submit" disabled={busy}><X size={16} /> 반려 보내기</Button>
              : <Button tone="danger" type="button" disabled={busy} onClick={() => setRejecting(true)}><X size={16} /> 반려</Button>
            : null}
          {permissions?.canDecide
            ? <Button tone="primary" type="button" disabled={busy} onClick={() => void decide('approve')}><Check size={17} /> {busy ? '처리 중…' : '승인'}</Button>
            : null}
        </footer>
      </form>
    </section>
  </div>
}
