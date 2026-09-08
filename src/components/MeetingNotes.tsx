import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ClipboardCheck, FileAudio, FileText, Mic, RefreshCw, ShieldAlert, Trash2, X } from 'lucide-react'
import { formatDateTime } from '../utils/dateTime'
import { formatDocumentSize, uploadDocumentAttachment } from '../utils/documentAttachments'
import {
  AI_LEVEL_LABEL,
  MAX_PARTICIPANTS,
  MAX_TRANSCRIPT_STORED,
  MEETING_ACTIVE_UPGRADE_LABEL,
  MEETING_AI_LOCKED_CODE,
  MEETING_AI_LOCKED_MESSAGE,
  MEETING_DOCUMENT_AUDIENCE_MESSAGE,
  MEETING_DOCUMENT_MISSING_NOTE,
  MEETING_LIST_PAGE_SIZE,
  MEETING_POLICY_FORBIDDEN_MESSAGE,
  MEETING_SOURCE_ACCEPT,
  MEETING_SOURCE_CATEGORY,
  MEETING_SOURCE_TAG,
  MEETING_STATUS_LABEL,
  type AiLevel,
  type AiLevelState,
  type DocumentsState,
  type Meeting,
  type MeetingDetail,
  type TranscriptionStatus,
  aiLevelLabel,
  isTranscriptFileName,
  meetingAiLevelNote,
  meetingAiLevelSkippedToast,
  meetingCreatedToast,
  meetingHeadline,
  meetingOutcomeLine,
  meetingParticipantLimitNote,
  meetingPendingProposalNote,
  meetingProcessBlockedNote,
  meetingProcessLabel,
  meetingProgressNote,
  meetingQueuedToast,
  meetingSourceId,
  meetingSourceKind,
  meetingSourceMissingNote,
  meetingStatusTone,
  sourceKindOf,
  transcriptTruncatedNote,
  transcriptionNotice,
} from '../utils/meetingNotes'
import { MeetingRecorder } from './MeetingRecorder'
import { StatusBadge } from './StatusBadge'
import { Button, IconButton } from './ui/Button'
import './MeetingNotes.css'

/**
 * 회의록 화면.
 *
 * 이 화면이 지키는 것 넷:
 *
 * 1) **없는 것을 있는 것처럼 그리지 않는다.** 음성 전사 벤더는 아직 없다. 목록 위 안내가
 *    `GET /api/meetings`의 `transcription`을 그대로 읽어 무엇이 되고 무엇이 안 되는지 말하고,
 *    녹음 버튼은 누르기 **전에** 그 사실을 다시 말한다. 가짜 진행 표시를 만들지 않는다.
 * 2) **막는 것은 서버다.** AI 처리 수준이 「보관만」인지는 자료 목록으로 미리 알 수 있지만,
 *    그 값은 다른 화면에서 바뀔 수 있으므로 화면은 경고만 하고 눌러 보게 둔다 — 실제 거절은
 *    서버의 409가 하고, 그때 나오는 문장은 화면이 미리 보여 준 문장과 **같은 하나**다(규칙 1·3).
 * 3) **말하는 것은 실제로 일어난 일이다.** 처리 뒤 토스트는 응답에 실려 온 `queued`·`skipped`·
 *    `proposalsSkipped`·`documentNote`에서 나온다. 화면이 지어 쓰지 않는다(규칙 11·13).
 * 4) **회의록 문서는 회사 전원이 읽는다.** 그 사실은 서버가 준 `documentAudience.message`를
 *    그대로 옮긴다 — 동의를 받기 전에, 같은 문장으로. 상세를 열지 않고 목록에서 바로 동의하는
 *    길이 주 경로이므로, 그 길에서도 문장이 빠지지 않게 **동의를 묻기 전에 한 번 물어** 채운다.
 * 5) **세는 수와 보여 주는 수가 갈리지 않는다.** 서버는 한 묶음에서 자르고 `total`에 자르기 전
 *    개수를 담는다. 둘이 다르면 화면이 그 사실을 적고 나머지에 닿는 길(「더 보기」)을 함께 준다
 *    (규칙 11·13, 형제 화면 `ApprovalDocumentSection`과 같은 관례).
 */

type LibraryDocument = {
  id: string
  name: string
  originalName?: string
  size?: number
  mime?: string
  aiPolicy?: string
  uploadedById?: string
}

type PendingSource = { documentId: string; name: string; sizeLabel: string; kind: 'recording' | 'transcript' }

type Member = { id: string; name: string; team?: string }

type ListResponse = {
  meetings?: Meeting[]
  total?: number
  transcription?: TranscriptionStatus
  error?: { message?: string }
}

type ProcessResponse = {
  meeting?: Meeting
  documentId?: string
  queued?: number
  skipped?: number
  mode?: string
  documentAudience?: MeetingDetail['documentAudience']
  documentReused?: boolean
  documentNote?: string
  proposalsSkipped?: string
  /** 원본의 지금 수준과 **이 사람이** 더 올릴 수 있는가. 토스트가 지목할 곳이 있는지 여기서 갈린다. */
  aiLevel?: AiLevelState
  error?: { code?: string; message?: string }
}

export function MeetingNotesPage({ workspaceScope, currentUserId, isAdmin, onOpenDocument, onNavigate, onToast }: {
  workspaceScope?: string
  currentUserId: string
  isAdmin: boolean
  /** 회의록 문서를 문서 화면에서 연다. page만 바꾸면 목록 첫 화면이 열려 근거에 닿지 못한다. */
  onOpenDocument: (documentId: string) => void
  onNavigate: (page: string) => void
  onToast: (message: string) => void
}) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  /**
   * 지금까지 펼쳐 둔 묶음 수. 새로고침도 이 수만큼 다시 읽는다 — 첫 묶음만 다시 읽으면
   * 사람이 「더 보기」로 펼쳐 둔 줄이 조용히 사라진다.
   */
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [transcription, setTranscription] = useState<TranscriptionStatus | null>(null)
  const [documents, setDocuments] = useState<LibraryDocument[]>([])
  /**
   * 자료 목록을 **읽어 봤는가**. 「아직 모른다」·「못 읽었다」·「읽었다」는 서로 다른 사실이라
   * 칸이 필요하다 — 이 칸이 없으면 요청이 실패한 상태에서도 상세가 「열람할 권한이 없거나
   * 사라졌습니다」라고 원인을 단정한다(규칙 3·11).
   */
  const [documentsState, setDocumentsState] = useState<DocumentsState>('loading')
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [detailId, setDetailId] = useState('')
  const [detail, setDetail] = useState<MeetingDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingSource, setPendingSource] = useState<PendingSource | null>(null)
  const [consent, setConsent] = useState<{ meeting: Meeting; message: string; audience: string } | null>(null)

  const headers = useMemo(() => (workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined), [workspaceScope])
  const jsonHeaders = useMemo(() => ({ 'content-type': 'application/json', ...(headers ?? {}) }), [headers])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      // 펼쳐 둔 묶음을 한꺼번에 다시 읽는다. 그 사이에 순서가 바뀔 수 있으므로 이어 붙일 때
      // id로 중복을 걷어낸다 — 같은 줄이 두 번 그려지면 React key가 부딪힌다.
      const bodies = await Promise.all(Array.from({ length: pages }, async (_unused, index) => {
        const params = new URLSearchParams({ limit: String(MEETING_LIST_PAGE_SIZE) })
        if (index > 0) params.set('offset', String(index * MEETING_LIST_PAGE_SIZE))
        const response = await fetch(`/api/meetings?${params}`, { headers })
        const body = await response.json() as ListResponse
        if (!response.ok) throw new Error(body.error?.message || '회의록 목록을 불러오지 못했습니다.')
        return body
      }))
      const seen = new Set<string>()
      const rows: Meeting[] = []
      for (const body of bodies) {
        for (const row of body.meetings ?? []) {
          if (!row?.id || seen.has(row.id)) continue
          seen.add(row.id)
          rows.push(row)
        }
      }
      setMeetings(rows)
      // 자른 배열의 길이가 아니라 서버가 답한 실제 건수다(규칙 13). 그 둘이 다르면 아래
      // 「더 보기」 줄이 그 사실을 적고 나머지에 닿는 길을 준다.
      setTotal(Number(bodies[0]?.total ?? rows.length))
      setTranscription(bodies[0]?.transcription ?? null)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '회의록 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [headers, pages])

  /**
   * 원본 자료 한 줄(이름·크기·AI 처리 수준). 회의 레코드에는 id만 있고, 그 id가 가리키는 파일의
   * 사실은 자료실이 갖고 있다. 볼 수 없는 자료는 이 목록에 아예 오지 않으므로 화면은
   * 「열람할 수 없다」를 짐작이 아니라 없음으로 안다.
   */
  const loadDocuments = useCallback(async () => {
    try {
      const response = await fetch('/api/documents', { headers })
      // 못 읽었다는 사실을 **남긴다.** 조용히 돌아가면 화면은 「목록에 없다」와 「목록을 못 읽었다」를
      // 구별할 수 없게 되고, 그 둘을 한 문장으로 말하는 순간 참이 아닌 원인을 단정하게 된다.
      if (!response.ok) { setDocumentsState('failed'); return }
      const body = await response.json() as { documents?: LibraryDocument[] }
      setDocuments(body.documents ?? [])
      setDocumentsState('ready')
    } catch { setDocumentsState('failed') /* 자료 목록은 보조 정보다 — 못 읽어도 회의 목록은 살아 있다 */ }
  }, [headers])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadDocuments() }, [loadDocuments])

  useEffect(() => {
    let active = true
    fetch('/api/directory', { headers })
      .then(async (response) => (response.ok ? response.json() as Promise<{ members?: (Member & { kind?: string; system?: boolean })[] }> : { members: [] }))
      .then((body) => {
        if (!active) return
        setMembers((body.members ?? [])
          .filter((member) => member.id && member.name && !member.system && member.kind === 'employee')
          .map((member) => ({ id: member.id, name: member.name, team: member.team })))
      })
      .catch(() => { if (active) setMembers([]) })
    return () => { active = false }
  }, [headers])

  const documentById = useMemo(() => new Map(documents.map((row) => [row.id, row])), [documents])

  const loadDetail = useCallback(async (id: string) => {
    setDetailError('')
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(id)}`, { headers })
      const body = await response.json() as MeetingDetail & { error?: { message?: string } }
      if (!response.ok || !body.meeting) throw new Error(body.error?.message || '회의를 불러오지 못했습니다.')
      setDetail(body)
    } catch (cause) {
      setDetail(null)
      setDetailError(cause instanceof Error ? cause.message : '회의를 불러오지 못했습니다.')
    }
  }, [headers])

  useEffect(() => {
    if (!detailId) { setDetail(null); setDetailError(''); return }
    void loadDetail(detailId)
  }, [detailId, loadDetail])

  const createMeeting = async (title: string, source: PendingSource) => {
    const response = await fetch('/api/meetings', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title,
        ...(source.kind === 'transcript'
          ? { transcriptDocumentId: source.documentId }
          : { recordingDocumentId: source.documentId }),
      }),
    })
    const body = await response.json() as { meeting?: Meeting; error?: { message?: string } }
    if (!response.ok || !body.meeting) throw new Error(body.error?.message || '회의를 만들지 못했습니다.')
    setMeetings((current) => [body.meeting!, ...current])
    setTotal((current) => current + 1)
    setCreateOpen(false)
    setPendingSource(null)
    // 다음에 누를 곳을 말하기 전에 **그것이 지금 되는지** 먼저 본다 — 되지 않는 설정에서
    // 「「AI로 정리」를 누르면」은 같은 화면 위쪽의 안내와 정면으로 어긋난다(규칙 3·11).
    onToast(meetingCreatedToast(transcription, source.kind === 'transcript' ? 'transcript' : 'recording'))
    void loadDocuments()
  }

  const patchMeeting = async (meeting: Meeting, patch: { title?: string; participantIds?: string[] }) => {
    setBusyId(meeting.id)
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(meeting.id)}`, {
        method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch),
      })
      const body = await response.json() as { meeting?: Meeting; error?: { message?: string } }
      if (!response.ok || !body.meeting) throw new Error(body.error?.message || '회의를 고치지 못했습니다.')
      setMeetings((current) => current.map((row) => (row.id === body.meeting!.id ? body.meeting! : row)))
      setDetail((current) => (current && current.meeting.id === body.meeting!.id ? { ...current, meeting: body.meeting! } : current))
      onToast('회의 정보를 고쳤습니다.')
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '회의를 고치지 못했습니다.')
    } finally {
      setBusyId('')
    }
  }

  const deleteMeeting = async (meeting: Meeting) => {
    setBusyId(meeting.id)
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(meeting.id)}`, { method: 'DELETE', headers })
      const body = await response.json() as { ok?: boolean; message?: string; error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '회의를 지우지 못했습니다.')
      setMeetings((current) => current.filter((row) => row.id !== meeting.id))
      setTotal((current) => Math.max(0, current - 1))
      setDetailId('')
      // 남은 것(회의록 문서·원본 파일)을 **서버가 말한 그대로** 옮긴다 — 화면이 지어 쓰면
      // 지워지지 않은 것을 지웠다고 말하게 된다.
      onToast(body.message || '회의를 지웠습니다.')
      void loadDocuments()
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '회의를 지우지 못했습니다.')
    } finally {
      setBusyId('')
    }
  }

  /**
   * 「이 회의록 문서를 누가 읽는가」 — **서버가 준 문장 그대로**.
   *
   * 이 화면이 만드는 회의는 예외 없이 경고의 강한 쪽이다: 원본은 올린 사람만 읽는 자료로 올라가는데
   * 거기서 뽑은 요약·결정 인용은 회사 전원에게(전역 검색까지) 열린다. 설계 §0.3은 「화면이 그 사실을
   * 말한다」를 유일한 완화책으로 삼았으므로, 상세가 열려 있든 아니든 **동의를 묻기 전에** 채운다.
   * 못 물었을 때 빈 문자열로 떨어지면 그 완화책이 통째로 사라지므로, 언제나 참인 약한 쪽 문장으로
   * 떨어진다(원본이 좁으면 서버가 더 강한 문장을 준다).
   */
  const audienceMessageOf = async (meetingId: string) => {
    if (detail?.meeting.id === meetingId && detail.documentAudience?.message) return detail.documentAudience.message
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`, { headers })
      const body = await response.json() as MeetingDetail & { error?: { message?: string } }
      if (response.ok && body.documentAudience?.message) return body.documentAudience.message
    } catch { /* 못 물어도 동의는 물어야 한다 — 아래 한 문장으로 떨어진다 */ }
    return MEETING_DOCUMENT_AUDIENCE_MESSAGE
  }

  const runProcess = async (meeting: Meeting, aiPolicy?: AiLevel) => {
    setBusyId(meeting.id)
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(meeting.id)}/process`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify(aiPolicy ? { aiPolicy } : {}),
      })
      const body = await response.json() as ProcessResponse
      if (!response.ok) {
        // 「보관만」이라 막혔다는 답은 오류가 아니라 **동의를 물을 자리**다. 서버가 보낸 문장을
        // 그대로 대화상자에 싣는다(규칙 3: 사전 경고와 거절이 한 문장에서 나온다).
        if (body.error?.code === MEETING_AI_LOCKED_CODE) {
          // **되지 않을 일에 동의를 받지 않는다.** 전사 연결이 없으면 개인정보 동의를 받아 낸 뒤에도
          // 503으로 끝나고 올렸던 수준마저 통째로 되돌아간다(부록 C-4). 그 사실을 이미 손에 들고
          // 있으므로(`transcription`) 여기서 갈라, 화면 위쪽 안내와 **같은 문장**으로 거절한다(규칙 3·11).
          const blocked = meetingProcessBlockedNote(transcription, sourceKindOf(meeting), meeting.hasTranscript)
          if (blocked) { onToast(blocked); return }
          setConsent({
            meeting,
            message: body.error.message || MEETING_AI_LOCKED_MESSAGE,
            audience: await audienceMessageOf(meeting.id),
          })
          return
        }
        throw new Error(body.error?.message || '회의를 정리하지 못했습니다.')
      }
      if (body.meeting) {
        setMeetings((current) => current.map((row) => (row.id === body.meeting!.id ? body.meeting! : row)))
        setDetail((current) => (current && current.meeting.id === body.meeting!.id ? { ...current, meeting: body.meeting! } : current))
      }
      setConsent(null)
      const parts = ['회의록을 정리했습니다.']
      if (body.mode === 'grounded-fallback') parts.push('AI 연결이 없어 원문에서 그대로 뽑았습니다.')
      // 두 문장 모두 **누를 곳이 있는 사람에게만** 그곳을 지목한다(규칙 11) — 승인 큐의 AI 제안
      // 목록은 관리자만 읽고, AI 수준을 올리는 것은 원본을 올린 사람과 관리자뿐이다.
      if (body.proposalsSkipped === 'ai-level') parts.push(meetingAiLevelSkippedToast(Boolean(body.aiLevel?.mayRaise)))
      else parts.push(meetingQueuedToast(Number(body.queued ?? 0), Number(body.skipped ?? 0), isAdmin))
      if (body.documentNote) parts.push(body.documentNote)
      // 방금 **새로** 만들어진 회의록 문서가 원본보다 넓게 열린다면 그 사실을 그때 한 번 말한다.
      // 두 번째 요약부터는 새로 열린 것이 없으므로(문서를 다시 쓰지 않는다) 말하지 않는다.
      if (!body.documentReused && body.documentAudience?.widerThanSource && body.documentAudience.message) {
        parts.push(body.documentAudience.message)
      }
      onToast(parts.join(' '))
      if (detailId === meeting.id) await loadDetail(meeting.id)
      void loadDocuments()
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '회의를 정리하지 못했습니다.')
      void load(true)
    } finally {
      setBusyId('')
    }
  }

  const revokeAi = async (meeting: Meeting) => {
    setBusyId(meeting.id)
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(meeting.id)}/revoke-ai`, { method: 'POST', headers })
      const body = await response.json() as { meeting?: Meeting; message?: string; error?: { message?: string } }
      if (!response.ok || !body.meeting) throw new Error(body.error?.message || 'AI 결과를 파기하지 못했습니다.')
      setMeetings((current) => current.map((row) => (row.id === body.meeting!.id ? body.meeting! : row)))
      // 무엇이 지워지고 무엇이 남았는지는 서버가 실제로 한 일에서 나온 문장이다.
      onToast(body.message || '원본을 「보관만」으로 되돌렸습니다.')
      if (detailId === meeting.id) await loadDetail(meeting.id)
      void loadDocuments()
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : 'AI 결과를 파기하지 못했습니다.')
    } finally {
      setBusyId('')
    }
  }

  const notice = transcriptionNotice(transcription)
  const detailMeeting = detail?.meeting ?? null

  return (
    <div className="content-page meeting-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">MEETING</span>
          <h1>회의록</h1>
          {/* 이 문장과 아래 `.meeting-provider-note`는 **한 술어**를 본다 — 하나가 「문서로 만듭니다」인데
              다른 하나가 「원문 파일도 읽지 못합니다」이면 한 화면이 한 사실을 갈라 말한다(규칙 3·11). */}
          <p>{meetingHeadline(transcription)}</p>
        </div>
        <div className="page-header-actions">
          <Button tone="primary" type="button" onClick={() => setCreateOpen(true)}><FileText size={17} /> 새 회의</Button>
          <MeetingRecorder
            transcription={transcription}
            workspaceScope={workspaceScope}
            disabled={loading}
            onToast={onToast}
            onRecorded={(source) => { setPendingSource(source); setCreateOpen(true) }}
          />
          <Button tone="quiet" type="button" onClick={() => { void load(); void loadDocuments() }}><RefreshCw size={17} /> 새로고침</Button>
        </div>
      </header>

      {notice && <p className="meeting-provider-note"><ShieldAlert size={16} aria-hidden="true" /> {notice}</p>}

      {error && <p className="meeting-error" role="alert">{error}</p>}

      {loading ? <p className="meeting-empty">회의록을 불러오는 중입니다…</p> : meetings.length === 0 ? (
        <div className="meeting-empty">
          <h3>아직 등록된 회의가 없습니다</h3>
          <p>회의록 원문(.txt·.vtt·.srt·.md)이나 녹음 파일을 올리면 여기에 쌓입니다.</p>
          <Button tone="secondary" type="button" onClick={() => setCreateOpen(true)}>첫 회의 만들기</Button>
        </div>
      ) : (
        <ul className="meeting-list">
          {meetings.map((meeting) => {
            const source = documentById.get(meetingSourceId(meeting))
            const outcome = meetingOutcomeLine(meeting)
            const meta = [
              meeting.createdByName || '작성자 미상',
              formatDateTime(meeting.createdAt),
              meetingSourceKind(meeting) || '원본 없음',
              `참석자 ${meeting.participantIds.length}명`,
            ].join(' · ')
            return (
              <li className={`meeting-row is-${meeting.status}`} key={meeting.id}>
                <StatusBadge tone={meetingStatusTone(meeting.status)}>{MEETING_STATUS_LABEL[meeting.status] ?? meeting.status}</StatusBadge>
                <button type="button" className="meeting-main" onClick={() => setDetailId(meeting.id)}>
                  <strong>{meeting.title}</strong>
                  <small>{meta}{source ? ` · ${source.name}` : ''}</small>
                  {outcome && <small className="meeting-outcome-line">{outcome}</small>}
                  {meeting.status === 'done' && !meeting.documentId && <small className="meeting-missing-line">{MEETING_DOCUMENT_MISSING_NOTE}</small>}
                  {meeting.status === 'failed' && meeting.error && <small className="meeting-failed-line">{meeting.error}</small>}
                </button>
                {/* 「전사 중」·「요약 중」에도 **누를 곳을 남긴다.** 서버는 저장된 status로 막지 않는다 —
                    프로세스가 죽어 굳은 회의를 되살릴 사람은 사용자뿐인데(스케줄러가 없다) 화면이
                    버튼을 지우면 그 회의는 영영 굳은 채로 남는다(규칙 1·11). 실제로 지금 돌고 있으면
                    서버가 409로 「지금 처리하고 있습니다」라고 답한다 — 막는 것은 서버다. */}
                <div className="meeting-row-actions">
                  {(meeting.status === 'transcribing' || meeting.status === 'summarizing') && (
                    <span className="meeting-progress">{meetingProgressNote(meeting.status)}</span>
                  )}
                  {meeting.status === 'done' && meeting.documentId ? (
                    <Button tone="secondary" size="sm" type="button" onClick={() => onOpenDocument(meeting.documentId)}><BookOpen size={15} /> 회의록 열기</Button>
                  ) : (
                    // 끝난 회의인데 문서가 없으면 「다시 정리」다 — 위 문장이 지목하는 그 버튼이
                    // 같은 줄에 실제로 있어야 한다(규칙 11). 서버는 문서가 사라졌으면 새로 만든다.
                    <Button
                      tone="secondary"
                      size="sm"
                      type="button"
                      disabled={busyId === meeting.id}
                      onClick={() => void runProcess(meeting)}
                    >{meetingProcessLabel(meeting.status)}</Button>
                  )}
                </div>
              </li>
            )
          })}
          {/* 「회의 N건」이라 써 놓고 M줄만 그리면 세는 수와 보여 주는 수가 화면에서 갈린다(규칙 11·13).
              남은 건수를 말했으면 그 건수에 닿는 길이 실제로 있어야 한다 — 자료실의 409 문구가
              지목하는 유일한 해제 방법(「회의록 화면에서 그 회의를 삭제」)이 여기에 걸려 있다. */}
          {meetings.length < total && (
            <li className="meeting-more">
              <span>{`${meetings.length.toLocaleString('ko-KR')}건을 보여 주고 있습니다 · 남은 ${(total - meetings.length).toLocaleString('ko-KR')}건`}</span>
              <Button tone="ghost" size="sm" type="button" disabled={loading} onClick={() => setPages((current) => current + 1)}>더 보기</Button>
            </li>
          )}
        </ul>
      )}

      {meetings.length > 0 && <p className="meeting-total">회의 {total}건</p>}

      {createOpen && (
        <MeetingCreateDialog
          workspaceScope={workspaceScope}
          pendingSource={pendingSource}
          onToast={onToast}
          onClose={() => { setCreateOpen(false); setPendingSource(null) }}
          onCreate={createMeeting}
        />
      )}

      {detailId && (
        <MeetingDetailDialog
          detail={detail}
          error={detailError}
          source={detailMeeting ? documentById.get(meetingSourceId(detailMeeting)) ?? null : null}
          documentsState={documentsState}
          members={members}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          busy={Boolean(detailMeeting && busyId === detailMeeting.id)}
          onClose={() => setDetailId('')}
          onProcess={(meeting, level) => void runProcess(meeting, level)}
          onRevoke={(meeting) => void revokeAi(meeting)}
          onPatch={(meeting, patch) => void patchMeeting(meeting, patch)}
          onDelete={(meeting) => void deleteMeeting(meeting)}
          onOpenDocument={onOpenDocument}
          onOpenQueue={() => { onNavigate('approvals'); onToast('승인 큐에서 회의 할 일 제안을 확인하세요.') }}
        />
      )}

      {consent && (
        <MeetingConsentDialog
          meeting={consent.meeting}
          lockedMessage={consent.message}
          audienceMessage={consent.audience}
          busy={busyId === consent.meeting.id}
          onClose={() => setConsent(null)}
          onConfirm={(level) => void runProcess(consent.meeting, level)}
        />
      )}
    </div>
  )
}

/**
 * 새 회의 — 파일 하나와 제목 하나.
 *
 * 올린 파일은 자료실에 「회의녹음」 분류로 보관되고, AI 처리 수준은 **서버가** 「보관만」으로 정한다.
 * 그 사실을 올리기 전에 말한다 — 나중에 「AI로 정리」에서 동의를 묻는 이유가 여기서 정해진다.
 */
function MeetingCreateDialog({ workspaceScope, pendingSource, onToast, onClose, onCreate }: {
  workspaceScope?: string
  pendingSource: PendingSource | null
  onToast: (message: string) => void
  onClose: () => void
  onCreate: (title: string, source: PendingSource) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [source, setSource] = useState<PendingSource | null>(pendingSource)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { if (pendingSource) setSource(pendingSource) }, [pendingSource])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const pickFile = async (file: File) => {
    setBusy(true)
    try {
      const stored = await uploadDocumentAttachment(file, {
        workspaceScope,
        category: MEETING_SOURCE_CATEGORY,
        summary: '회의 원본 자료',
        tags: [MEETING_SOURCE_TAG],
      })
      setSource({
        documentId: stored.id,
        name: stored.name,
        sizeLabel: stored.size,
        kind: isTranscriptFileName(file.name) ? 'transcript' : 'recording',
      })
      // 제목을 아직 적지 않았으면 파일 이름을 첫 제안으로 둔다. 사람이 그대로 두거나 고친다.
      setTitle((current) => current || file.name.replace(/\.[^.]+$/, ''))
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '파일을 저장하지 못했습니다.')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const submit = async () => {
    if (busy) return
    if (!title.trim()) { onToast('회의 제목을 입력해 주세요.'); return }
    if (!source) { onToast('녹음 파일이나 회의록 원문 파일을 하나는 지정해 주세요.'); return }
    setBusy(true)
    try {
      await onCreate(title.trim(), source)
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '회의를 만들지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal-card meeting-create-modal" role="dialog" aria-modal="true" aria-labelledby="meeting-create-title">
        <header>
          <div><span className="eyebrow">NEW MEETING</span><h2 id="meeting-create-title">새 회의</h2><p>회의록 원문이나 녹음 파일을 올리고 제목을 정합니다.</p></div>
          <IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={21} /></IconButton>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <label className="form-field">
            <span>회의 제목</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="예: 10월 품질 정기회의" />
          </label>
          <div className="form-field">
            <span>원본 파일</span>
            {source ? (
              <p className="meeting-source-picked">
                {source.kind === 'transcript' ? <FileText size={16} aria-hidden="true" /> : <FileAudio size={16} aria-hidden="true" />}
                {source.name} · {source.sizeLabel} · {source.kind === 'transcript' ? '회의록 원문' : '녹음'}
              </p>
            ) : (
              <input
                ref={fileRef}
                type="file"
                accept={MEETING_SOURCE_ACCEPT}
                disabled={busy}
                onChange={(event) => { const file = event.target.files?.[0]; if (file) void pickFile(file) }}
              />
            )}
            <p className="meeting-field-note">
              올린 파일은 자료실 「{MEETING_SOURCE_CATEGORY}」 분류에 보관되고, AI 처리 수준은 서버가 「{AI_LEVEL_LABEL.locked}」 단계로 정합니다.
              「AI로 정리」를 누를 때 수준을 올릴지 다시 물어봅니다. 여기서 취소해도 올린 파일은 자료실에 남습니다.
            </p>
          </div>
          <footer>
            <Button tone="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button>
            <Button tone="primary" type="submit" disabled={busy}>회의 만들기</Button>
          </footer>
        </form>
      </section>
    </div>
  )
}

/** 회의 한 건 — 원본·전사문·요약·결정·할 일·문서·제안, 그리고 되돌리기. */
function MeetingDetailDialog({
  detail, error, source, documentsState, members, currentUserId, isAdmin, busy,
  onClose, onProcess, onRevoke, onPatch, onDelete, onOpenDocument, onOpenQueue,
}: {
  detail: MeetingDetail | null
  error: string
  source: LibraryDocument | null
  /** 자료 목록을 읽어 봤는가. 「없다」와 「모른다」를 갈라 말하는 근거다. */
  documentsState: DocumentsState
  members: Member[]
  currentUserId: string
  isAdmin: boolean
  busy: boolean
  onClose: () => void
  /** 두 번째 인자는 **올릴 수준**이다. 없으면 지금 수준 그대로 다시 정리한다. */
  onProcess: (meeting: Meeting, level?: AiLevel) => void
  onRevoke: (meeting: Meeting) => void
  onPatch: (meeting: Meeting, patch: { title?: string; participantIds?: string[] }) => void
  onDelete: (meeting: Meeting) => void
  onOpenDocument: (documentId: string) => void
  onOpenQueue: () => void
}) {
  const meeting = detail?.meeting ?? null
  const [title, setTitle] = useState(meeting?.title ?? '')
  const [participantIds, setParticipantIds] = useState<string[]>(meeting?.participantIds ?? [])
  const [confirmDelete, setConfirmDelete] = useState(false)

  /**
   * 편집 폼을 **회의가 바뀔 때만** 채운다.
   *
   * 제목·참석자를 의존성에 두면 안 된다: `participantIds`는 응답마다 새 배열이고, 「AI로 정리」·
   * 「다시 정리」·「AI 결과 파기」가 성공하면 그 응답의 `meeting`이 그대로 꽂힌다. 한 대화상자가
   * 편집 폼과 실행 버튼을 함께 갖고 있으므로, 그때마다 이 effect가 다시 돌아 **저장하지 않은
   * 편집을 조용히 되돌린다.**
   */
  useEffect(() => {
    setTitle(meeting?.title ?? '')
    setParticipantIds(meeting?.participantIds ?? [])
    setConfirmDelete(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 회의가 바뀔 때만 채운다(위 주석)
  }, [meeting?.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // 제목·참석자를 바꿀 수 있는 사람은 기안자와 관리자다(서버 `canManageMeeting`과 같은 술어).
  // 참석자는 열람자이지 관리자가 아니다 — 화면이 넓게 열어 두면 서버의 403이 이유 없는 고장으로 읽힌다.
  const canManage = Boolean(meeting) && (meeting!.createdById === currentUserId || isAdmin)
  const summary = meeting?.summary ?? null
  // AI 처리 수준은 **서버가 판정한다**. 화면은 그 답을 그릴 뿐이고, 못 읽었으면 아무것도 지목하지 않는다.
  const aiLevel = detail?.aiLevel ?? null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal-card meeting-detail-modal" role="dialog" aria-modal="true" aria-labelledby="meeting-detail-title">
        <header>
          <div>
            <span className="eyebrow">MEETING</span>
            <h2 id="meeting-detail-title">{meeting?.title ?? '회의'}</h2>
            {meeting && <p>{meeting.createdByName || '작성자 미상'} · {formatDateTime(meeting.createdAt)}</p>}
          </div>
          <IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={21} /></IconButton>
        </header>
        <div className="meeting-detail">
          {error && <p className="meeting-error" role="alert">{error}</p>}
          {!meeting ? <p className="meeting-empty">회의를 불러오는 중입니다…</p> : (
            <>
              <section className="meeting-source-card">
                <h3>원본 자료</h3>
                {source ? (
                  <p>
                    {source.name} · {formatDocumentSize(Number(source.size ?? 0))}
                    <span className="meeting-ai-level">AI 처리 수준 {aiLevelLabel(String(source.aiPolicy ?? ''))}</span>
                  </p>
                ) : (
                  // 목록을 못 읽었으면 그 자료가 있는지 없는지 **모른다.** 그때 원인을 단정하면
                  // 둘 다 참이 아닐 수 있다 — 요청만 실패했고 자료는 멀쩡히 있을 수 있다(규칙 3·11).
                  <p className="meeting-quiet">{meetingSourceMissingNote(documentsState)}</p>
                )}
                {detail?.documentAudience?.message && <p className="meeting-quiet">{detail.documentAudience.message}</p>}
              </section>

              <section className="meeting-transcript">
                <h3>전사 원문</h3>
                {detail?.transcriptHidden ? (
                  <p className="meeting-quiet">{detail.transcriptHiddenNote}</p>
                ) : detail?.transcriptPreview ? (
                  <details>
                    {/* 두 수 모두 **서버가 코드포인트로 센 것**이다. 여기서 `String.length`로 다시 세면
                        이모지 한 자가 둘로 세어져 미리보기가 전체보다 길다고 말한다(규칙 13). */}
                    <summary>앞부분 {detail.transcriptPreviewChars.toLocaleString('ko-KR')}자 보기 (전체 {meeting.transcriptChars.toLocaleString('ko-KR')}자)</summary>
                    <pre>{detail.transcriptPreview}</pre>
                  </details>
                ) : (
                  <p className="meeting-quiet">아직 전사된 원문이 없습니다.</p>
                )}
                {/* 두 문장은 **다른 사실**이다(규칙 11). 아래(20,000자)가 10배 먼저 닿는다:
                    어댑터는 읽었지만 회의 레코드에는 앞부분만 담기고, 요약은 그 담긴 것만 본다.
                    위(200,000자)는 어댑터가 아예 읽지도 못한 글자다. 상한 수는 서버에서 온다. */}
                {meeting.transcriptUnreadChars > 0 && (
                  <p className="meeting-quiet">상한을 넘겨 {meeting.transcriptUnreadChars.toLocaleString('ko-KR')}자는 읽지 못했습니다 — 요약도 그 뒷부분을 보지 못했습니다.</p>
                )}
                {meeting.transcriptTruncated && (
                  <p className="meeting-quiet">{transcriptTruncatedNote(MAX_TRANSCRIPT_STORED)}</p>
                )}
              </section>

              <section className="meeting-outcome">
                <h3>요약</h3>
                {summary ? (
                  <>
                    {summary.notice && <p className="meeting-quiet">{summary.notice}</p>}
                    <p>{summary.summary || '요약할 내용을 찾지 못했습니다.'}</p>
                    {summary.insufficient && <p className="meeting-quiet">원문에서 근거를 찾은 결정·할 일이 없어 「근거 부족」으로 표시했습니다.</p>}
                    <h3>결정 사항 {summary.decisions.length}건</h3>
                    {summary.decisions.length ? (
                      <ul>{summary.decisions.map((decision, index) => (
                        <li key={`${meeting.id}-decision-${index}`}>{decision.text}<em>“{decision.quote}”</em></li>
                      ))}</ul>
                    ) : <p className="meeting-quiet">원문에서 근거를 찾은 결정이 없습니다.</p>}
                    <h3>다음 할 일 {summary.tasks.length}건</h3>
                    {summary.tasks.length ? (
                      <ul>{summary.tasks.map((task, index) => (
                        <li key={`${meeting.id}-task-${index}`}>
                          {task.title}
                          <em>{[task.owner || '담당 미정', task.due || '마감 미정'].join(' · ')}</em>
                        </li>
                      ))}</ul>
                    ) : <p className="meeting-quiet">원문에서 근거를 찾은 할 일이 없습니다.</p>}
                  </>
                ) : <p className="meeting-quiet">아직 요약하지 않았습니다.</p>}
              </section>

              <section className="meeting-outcome">
                <h3>만들어진 것</h3>
                {meeting.documentId ? (
                  <p><Button tone="quiet" size="sm" type="button" onClick={() => onOpenDocument(meeting.documentId)}><BookOpen size={15} /> 회의록 문서 열기</Button></p>
                ) : meeting.status === 'done' ? (
                  // 끝났는데 문서가 없다 — 문서는 사람 손 없이도 사라진다(보관 30일 뒤 스윕).
                  // 아래 footer의 「다시 정리」가 이 문장이 지목하는 그 버튼이다.
                  <p className="meeting-quiet">{MEETING_DOCUMENT_MISSING_NOTE}</p>
                ) : <p className="meeting-quiet">아직 회의록 문서가 없습니다.</p>}
                {/* 수는 **서버가 센 대기 수**다. 누적 이력(`proposalIds`)의 길이를 세면 결재가 끝난
                    뒤에도 「올라가 있습니다」가 남고 다시 정리할 때마다 늘어난다(규칙 13).
                    「승인 큐 열기」는 관리자에게만 그린다 — `GET /api/proposals`가 관리자 전용이라
                    직원에게 그 버튼은 빈 화면으로 가는 길이다(규칙 11). */}
                {meeting.pendingProposals ? (
                  <p className={isAdmin ? 'meeting-proposal-link' : 'meeting-quiet'}>
                    {meetingPendingProposalNote(meeting.pendingProposals, isAdmin)}
                    {isAdmin && <Button tone="quiet" size="sm" type="button" onClick={onOpenQueue}><ClipboardCheck size={15} /> 승인 큐 열기</Button>}
                  </p>
                ) : <p className="meeting-quiet">{meetingPendingProposalNote(0, isAdmin)}</p>}
                {/* 「정리」에 멈춰 있으면 여기서 「활용」으로 올라간다. 이 자리가 없으면 한 번
                    「정리」를 고른 사람은 409를 다시 받지 못해 화면에서 영영 올라갈 수 없다. */}
                {aiLevel?.current === 'indexed' && (
                  <p className={aiLevel.mayRaise ? 'meeting-proposal-link' : 'meeting-quiet'}>
                    {meetingAiLevelNote(aiLevel.mayRaise)}
                    {aiLevel.mayRaise && (
                      <Button tone="secondary" size="sm" type="button" disabled={busy} onClick={() => onProcess(meeting, 'active')}>
                        <Mic size={15} /> {MEETING_ACTIVE_UPGRADE_LABEL}
                      </Button>
                    )}
                  </p>
                )}
              </section>

              {canManage && (
                <section className="meeting-manage">
                  <h3>회의 정보</h3>
                  <label className="form-field">
                    <span>제목</span>
                    <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
                  </label>
                  {/* 상한을 **말하고 지킨다.** 서버 `normalizeParticipants`는 상한을 넘긴 뒤부터 조용히
                      잘라 내고 200으로 답하는데, 그 명단은 곧 열람 명단이다 — 화면이 수를 모르면
                      21번째로 고른 사람이 말없이 사라진다(규칙 11). 수는 서버 상수 한 곳에서 온다.
                      이미 고른 칸은 계속 끌 수 있다 — 상한에 닿았다고 빼는 길까지 막지 않는다. */}
                  <fieldset className="meeting-participants">
                    <legend>참석자 <em>참석자는 이 회의를 열람할 수 있습니다. {meetingParticipantLimitNote(participantIds.length, MAX_PARTICIPANTS)}</em></legend>
                    {members.length === 0 ? <p className="meeting-quiet">구성원 목록을 불러오지 못했습니다.</p> : members.map((member) => {
                      const picked = participantIds.includes(member.id)
                      return (
                        <label key={member.id}>
                          <input
                            type="checkbox"
                            checked={picked}
                            disabled={!picked && participantIds.length >= MAX_PARTICIPANTS}
                            onChange={(event) => setParticipantIds((current) => (
                              event.target.checked ? [...current, member.id] : current.filter((id) => id !== member.id)
                            ))}
                          />
                          {member.name}{member.team ? ` · ${member.team}` : ''}
                        </label>
                      )
                    })}
                  </fieldset>
                  <div className="meeting-manage-actions">
                    <Button
                      tone="secondary"
                      size="sm"
                      type="button"
                      disabled={busy}
                      onClick={() => onPatch(meeting, { title: title.trim(), participantIds })}
                    >회의 정보 저장</Button>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
        {meeting && (
          <footer className="meeting-detail-footer">
            {/* 끝난 회의도 다시 정리할 수 있다 — 서버는 회의록 문서가 사라졌으면 새로 만들고,
                남아 있으면 그대로 두었다고 응답에 적는다. 「다시 정리하면 새로 만듭니다」라고
                말해 놓고 누를 곳이 없으면 그 문장은 길이 아니라 막다른 길이다(규칙 11). */}
            {/* 「전사 중」·「요약 중」에서도 지우지 않는다 — 서버는 저장된 status로 막지 않으므로
                프로세스가 죽어 굳은 회의를 되살릴 길은 이 버튼뿐이다. 정말 돌고 있으면 서버가
                409로 답한다(규칙 1: 막는 것은 서버다). 라벨은 목록 줄과 한 곳에서 나온다. */}
            <Button tone="secondary" type="button" disabled={busy} onClick={() => onProcess(meeting)}>
              <Mic size={17} /> {meetingProcessLabel(meeting.status)}
            </Button>
            {/* 「파기」는 형제 버튼(「활용으로 올려 다시 정리」)과 **같은 술어**를 본다 — 서버의
                라우트 9와 `aiLevel.mayRaise`가 둘 다 `canChangeAiLevel`이라, 거짓인 사람에게 이
                버튼은 언제나 403이다. 거짓이면 버튼 대신 서버가 할 말을 그 자리에서 한다(규칙 8·11). */}
            {aiLevel?.mayRaise
              ? <Button tone="ghost" type="button" disabled={busy} onClick={() => onRevoke(meeting)}>AI 결과 파기</Button>
              : <span className="meeting-footer-note">{MEETING_POLICY_FORBIDDEN_MESSAGE}</span>}
            {canManage && (confirmDelete
              ? <Button tone="danger" type="button" disabled={busy} onClick={() => onDelete(meeting)}><Trash2 size={17} /> 정말 지웁니다</Button>
              : <Button tone="danger" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={17} /> 회의 삭제</Button>)}
          </footer>
        )}
      </section>
    </div>
  )
}

/**
 * AI 처리 수준을 올려도 되는지 묻는 자리 — 3단 권한이 사용자 앞에 드러나는 유일한 화면이다.
 *
 * 「보관만」에서 무엇이 열리는지, 그리고 **제안은 승인 큐에서 사람이 다시 승인해야 실행된다**는
 * 사실을 함께 말한다. 문서 PATCH(`/api/documents/:id`)를 부르지 않는다 — 그 라우트는 관리자
 * 전용이고, 자기 회의를 처리하는 직원은 관리자가 아니다. 수준은 회의 라우트가 올린다.
 */
function MeetingConsentDialog({ meeting, lockedMessage, audienceMessage, busy, onClose, onConfirm }: {
  meeting: Meeting
  lockedMessage: string
  audienceMessage: string
  busy: boolean
  onClose: () => void
  onConfirm: (level: AiLevel) => void
}) {
  const [level, setLevel] = useState<AiLevel>('active')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal-card meeting-ai-consent" role="dialog" aria-modal="true" aria-labelledby="meeting-consent-title">
        <header>
          <div><span className="eyebrow">AI LEVEL</span><h2 id="meeting-consent-title">이 회의 원본을 AI가 읽어도 될까요?</h2><p>{meeting.title}</p></div>
          <IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={21} /></IconButton>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); onConfirm(level) }}>
          <p>{lockedMessage}</p>
          {/* 조사는 낱말에 붙이지 않는다 — 「정리」·「활용」은 상수에서 오므로 「로/으로」가 한쪽에서 틀린다. */}
          <p>
            「{AI_LEVEL_LABEL.indexed}」까지 올리면 전사와 요약을 만듭니다. 「{AI_LEVEL_LABEL.active}」까지 올리면
            회의에서 나온 할 일을 승인 큐에 제안으로 올립니다. 제안은 승인 큐에서 사람이 다시 승인해야 실행됩니다.
            원본은 그대로 남고, 나중에 「AI 결과 파기」를 누르면 요약과 제안이 사라집니다.
          </p>
          {audienceMessage && <p className="meeting-quiet">{audienceMessage}</p>}
          <fieldset className="meeting-consent-levels">
            <legend>올릴 수준</legend>
            <label>
              <input type="radio" name="meeting-ai-level" checked={level === 'indexed'} onChange={() => setLevel('indexed')} />
              {AI_LEVEL_LABEL.indexed} — 전사와 요약까지. 업무 제안은 올리지 않습니다.
            </label>
            <label>
              <input type="radio" name="meeting-ai-level" checked={level === 'active'} onChange={() => setLevel('active')} />
              {AI_LEVEL_LABEL.active} — 요약과 함께 할 일을 승인 큐에 제안으로 올립니다.
            </label>
          </fieldset>
          <footer>
            <Button tone="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button>
            <Button tone="primary" type="submit" disabled={busy}>이 수준으로 진행</Button>
          </footer>
        </form>
      </section>
    </div>
  )
}
