import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, FileText, Paperclip, ShieldCheck, X } from 'lucide-react'
import { Button, IconButton } from './ui/Button'
import { deleteDocumentAttachment, deleteDocumentAttachments } from '../utils/documentAttachments'
import type { WorkEvidence, WorkItem } from '../domainData'

/**
 * 완료 보고 모달 — App.tsx에서 분리했다.
 * 직원 업무 화면(WorkPage)과 외부 게스트 전용 화면(GuestWorkspace)이 같은 모달을 써야
 * "완료 보고"라는 행동이 두 곳에서 다르게 자라지 않는다.
 */

/** 모달·드로어 공용 초점 가두기. 처음 열릴 때 첫 입력으로, Tab은 대화상자 안에서만 돈다. */
export function useDialogFocus(active = true) {
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!active) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(selector))
    const initialFocus = dialog.querySelector<HTMLElement>('[data-autofocus], [autofocus]') ?? focusables[0]
    window.setTimeout(() => initialFocus?.focus(), 0)

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const currentFocusables = Array.from(dialog.querySelectorAll<HTMLElement>(selector))
      if (currentFocusables.length === 0) return
      const first = currentFocusables[0]
      const last = currentFocusables[currentFocusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', trapFocus)
    return () => {
      dialog.removeEventListener('keydown', trapFocus)
      previousFocus?.focus()
    }
  }, [active])

  return dialogRef
}

export function fileSizeLabel(size: number) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function CompletionModal({ item, workspaceScope, onToast, onClose, onSubmit }: { item: WorkItem; workspaceScope?: string; onToast: (message: string) => void; onClose: () => void; onSubmit: (summary: string, evidence: WorkEvidence[]) => Promise<boolean> }) {
  const dialogRef = useDialogFocus()
  const inputRef = useRef<HTMLInputElement>(null)
  const [summary, setSummary] = useState(item.completion?.summary ?? '')
  const [evidence, setEvidence] = useState<WorkEvidence[]>(() => item.completion?.evidence.map((file) => ({ ...file })) ?? [])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const uploadedIdsRef = useRef(new Set<string>())
  const removedIdsRef = useRef(new Set<string>())
  const discardAndClose = async () => {
    if (busy || uploading) return
    setBusy(true)
    const cleanup = await deleteDocumentAttachments(uploadedIdsRef.current, workspaceScope)
    for (const id of cleanup.deleted) uploadedIdsRef.current.delete(id)
    if (cleanup.deleted.length) {
      const deleted = new Set(cleanup.deleted)
      setEvidence((current) => current.filter((file) => !deleted.has(file.id)))
    }
    if (cleanup.failed.length) {
      const message = `저장하지 않은 증빙 ${cleanup.failed.length}개를 정리하지 못했습니다. 다시 시도해 주세요.`
      setUploadError(message)
      onToast(message)
      setBusy(false)
      return
    }
    onClose()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (summary.trim().length < 3) return
    setBusy(true)
    if (await onSubmit(summary.trim(), evidence)) {
      uploadedIdsRef.current.clear()
      const cleanup = await deleteDocumentAttachments(removedIdsRef.current, workspaceScope)
      if (cleanup.failed.length) onToast(`업무는 제출했지만 제거한 증빙 ${cleanup.failed.length}개의 원본 정리에 실패했습니다.`)
      onClose()
    } else setBusy(false)
  }
  const removeEvidence = async (file: WorkEvidence) => {
    if (busy || uploading) return
    if (file.id.startsWith('DOC-') && uploadedIdsRef.current.has(file.id)) {
      setUploading(true)
      try {
        await deleteDocumentAttachment(file.id, workspaceScope)
        uploadedIdsRef.current.delete(file.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : '증빙 파일을 삭제하지 못했습니다.'
        setUploadError(message)
        onToast(message)
        setUploading(false)
        return
      }
      setUploading(false)
    } else if (file.id.startsWith('DOC-')) removedIdsRef.current.add(file.id)
    setEvidence((current) => current.filter((item) => item.id !== file.id))
  }
  return <div className="modal-backdrop workflow-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void discardAndClose() }}>
    <section ref={dialogRef} className="modal-card workflow-modal workflow-completion-sheet" role="dialog" aria-modal="true" aria-labelledby="completion-modal-title">
      <header><div><span className="eyebrow">COMPLETE WORK</span><h2 id="completion-modal-title">완료 보고하기</h2><p>{item.title}</p></div><IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy || uploading} onClick={() => void discardAndClose()}><X size={21} /></IconButton></header>
      <form onSubmit={submit}>
        <label className="form-field full"><span>무엇을 했나요? <em>필수</em></span><textarea autoFocus data-autofocus rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="완료한 내용과 결과를 짧게 적어 주세요." required /></label>
        <section className="workflow-upload workflow-upload-compact" aria-labelledby="work-evidence-title"><div><h3 id="work-evidence-title">사진·파일 첨부 <small>선택</small></h3><p>필요한 경우에만 사진이나 증빙 파일을 추가하세요.</p></div><input ref={inputRef} className="sr-only" type="file" multiple onChange={async (event) => {
          const files = Array.from(event.target.files ?? []).slice(0, Math.max(0, 10 - evidence.length)); event.target.value = ''
          if (!workspaceScope || files.length === 0) return
          setUploading(true); setUploadError('')
          const uploaded: WorkEvidence[] = []
          for (const file of files) {
            if (file.size > 10 * 1024 * 1024) { setUploadError(`${file.name}: 한 파일은 10MB까지 첨부할 수 있습니다.`); continue }
            try {
              // 증빙은 담당자·요청자만 본다. 게스트가 올려도 서버가 같은 규칙(restricted)으로 다시 잠근다.
              const params = new URLSearchParams({ name: file.name, category: '회의·업무일지', visibility: 'restricted', allowedUserIds: [item.ownerId, item.requesterId].filter(Boolean).join(','), tags: `업무증빙,${item.id}`, summary: `${item.title} 완료 증빙자료` })
              const response = await fetch(`/api/documents?${params}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-workspace-identity': workspaceScope }, body: file })
              const body = await response.json() as { document?: { id: string }; error?: { message?: string } }
              if (!response.ok || !body.document) throw new Error(body.error?.message || '업로드 실패')
              uploaded.push({ id: body.document.id, name: file.name, size: fileSizeLabel(file.size), type: file.type || 'application/octet-stream' })
              uploadedIdsRef.current.add(body.document.id)
            } catch (error) { setUploadError(`${file.name}: ${error instanceof Error ? error.message : '업로드 실패'}`) }
          }
          setEvidence((current) => [...current, ...uploaded].slice(0, 10)); setUploading(false)
        }} /><Button tone="secondary" type="button" disabled={uploading || evidence.length >= 10} onClick={() => inputRef.current?.click()}><Paperclip size={17} /> {uploading ? '업로드 중…' : '파일 추가'}</Button></section>
        {uploadError && <p className="workflow-upload-error" role="alert">{uploadError}</p>}
        {evidence.length > 0 && <div className="workflow-evidence-list">{evidence.map((file) => <div key={file.id}><FileText size={18} /><span><strong>{file.name}</strong><small>{file.size} · 원본 저장됨</small></span><button type="button" aria-label={`${file.name} 삭제`} disabled={busy || uploading} onClick={() => void removeEvidence(file)}><X size={16} /></button></div>)}</div>}
        <p className="workflow-submit-guide"><ShieldCheck size={17} /> 제출하면 {item.requestedBy}님에게 확인 요청이 갑니다.</p>
        <footer><Button tone="ghost" type="button" disabled={busy || uploading} onClick={() => void discardAndClose()}>취소</Button><Button tone="primary" type="submit" disabled={busy || uploading || summary.trim().length < 3}><Check size={18} /> 제출</Button></footer>
      </form>
    </section>
  </div>
}
