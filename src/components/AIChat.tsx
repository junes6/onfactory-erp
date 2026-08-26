import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUp, CheckCircle2, ClipboardPlus, FileText, LoaderCircle, Paperclip, Sparkles, X } from 'lucide-react'
import { assistantExperienceForIndustry } from '../modules/registry'
import { aiTaskDraftFromAnswer } from '../utils/aiTaskDraft'
import { formatDateTime } from '../utils/dateTime'

export type ChatAttachmentMeta = {
  documentId: string
  name: string
  mimeType: string
  size: number
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  model?: string
  mode?: 'claude' | 'demo'
  sourcePrompt?: string
  createdAt: string
  attachments?: ChatAttachmentMeta[]
}

type SelectedAttachment = ChatAttachmentMeta & {
  localId: string
  signature: string
  status: 'uploading' | 'ready' | 'error'
  error?: string
}

type AIChatProps = {
  compact?: boolean
  companyName: string
  onCreateTask: (instruction: string, completionCriteria?: string) => void
  canCreateTask?: boolean
  canViewCommercial?: boolean
  operatingDataAvailable?: boolean
  context?: unknown
  workspaceScope?: string
  /** 업종 모듈 — 추천 질문과 첫 안내 문구가 분기된다 */
  industryType?: string
}

const MAX_CHAT_FILES = 5
const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024
const MAX_CHAT_TOTAL_BYTES = 10 * 1024 * 1024
const acceptedExtensions = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'csv', 'xlsx', 'xls', 'docx'])

function fileSizeLabel(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)}KB`
  return `${(size / (1024 * 1024)).toFixed(1)}MB`
}

function validateChatFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!file.size) return '빈 파일은 첨부할 수 없습니다.'
  if (file.size > MAX_CHAT_FILE_BYTES) return '한 파일은 10MB까지 첨부할 수 있습니다.'
  if (!acceptedExtensions.has(extension)) return 'PDF, 이미지, 문서, 스프레드시트, 텍스트 파일만 첨부할 수 있습니다.'
  return ''
}

export default function AIChat({ compact = false, companyName, onCreateTask, canCreateTask = true, canViewCommercial = true, operatingDataAvailable = false, context, workspaceScope, industryType = 'food_manufacturing' }: AIChatProps) {
  const assistantExperience = assistantExperienceForIndustry(industryType, { companyName, operatingDataAvailable, canViewCommercial })
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: assistantExperience.welcome,
      mode: 'demo',
      createdAt: new Date().toISOString(),
    },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<SelectedAttachment[]>([])
  const [attachmentNotice, setAttachmentNotice] = useState('')
  const [apiMode, setApiMode] = useState<'checking' | 'claude' | 'demo'>('checking')
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setApiMode(data.claude ? 'claude' : 'demo'))
      .catch(() => setApiMode('demo'))
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  const updateAttachment = (localId: string, patch: Partial<SelectedAttachment>) => {
    setAttachments((current) => current.map((item) => item.localId === localId ? { ...item, ...patch } : item))
  }

  const uploadAttachment = async (file: File, localId: string) => {
    if (!workspaceScope) {
      updateAttachment(localId, { status: 'error', error: '회사 워크스페이스를 확인할 수 없어 업로드하지 않았습니다.' })
      return
    }
    try {
      const params = new URLSearchParams({
        name: file.name,
        category: 'AI 채팅',
        visibility: 'restricted',
        tags: 'ai-chat',
        summary: 'AI 대화에서 사용자가 직접 선택한 참조 파일',
      })
      const response = await fetch(`/api/documents?${params}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-type': file.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
          'x-workspace-identity': workspaceScope,
        },
        body: file,
      })
      const body = await response.json().catch(() => ({})) as { document?: { id?: string }; error?: { message?: string } }
      if (!response.ok || !body.document?.id) throw new Error(body.error?.message || '파일을 저장하지 못했습니다.')
      updateAttachment(localId, { documentId: body.document.id, status: 'ready', error: undefined })
    } catch (error) {
      updateAttachment(localId, { status: 'error', error: error instanceof Error ? error.message : '파일을 저장하지 못했습니다.' })
    }
  }

  const selectFiles = (files: FileList | null) => {
    if (!files?.length) return
    setAttachmentNotice('')
    const selected = Array.from(files)
    const slots = Math.max(0, MAX_CHAT_FILES - attachments.length)
    const accepted = selected.slice(0, slots)
    if (selected.length > slots) setAttachmentNotice(`한 대화에는 파일을 ${MAX_CHAT_FILES}개까지 선택할 수 있습니다.`)
    const existingSignatures = new Set(attachments.map((item) => item.signature))
    let selectedBytes = attachments.filter((item) => item.status !== 'error').reduce((sum, item) => sum + item.size, 0)
    const pending: Array<{ file: File; attachment: SelectedAttachment }> = []
    accepted.forEach((file, index) => {
      const signature = `${file.name}:${file.size}:${file.lastModified}`
      const duplicate = existingSignatures.has(signature) || pending.some((item) => item.attachment.signature === signature)
      const fileError = validateChatFile(file)
      const validationError = duplicate
        ? '이미 선택한 파일입니다.'
        : fileError || (selectedBytes + file.size > MAX_CHAT_TOTAL_BYTES ? '한 대화의 첨부파일 합계는 10MB까지입니다.' : '')
      if (!validationError) selectedBytes += file.size
      const localId = `CHAT-FILE-${Date.now()}-${index}`
      pending.push({
        file,
        attachment: {
          localId,
          signature,
          documentId: '',
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          status: validationError ? 'error' : 'uploading',
          error: validationError || undefined,
        },
      })
    })
    setAttachments((current) => [...current, ...pending.map(({ attachment }) => attachment)])
    pending.filter(({ attachment }) => attachment.status === 'uploading').forEach(({ file, attachment }) => void uploadAttachment(file, attachment.localId))
  }

  const removeAttachment = async (attachment: SelectedAttachment) => {
    setAttachments((current) => current.filter((item) => item.localId !== attachment.localId))
    setAttachmentNotice('')
    if (!attachment.documentId || !workspaceScope) return
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(attachment.documentId)}`, {
        method: 'DELETE',
        headers: { 'x-workspace-identity': workspaceScope },
      })
      if (!response.ok) throw new Error()
    } catch {
      setAttachmentNotice('대화 첨부에서는 제외했지만 저장된 원본은 삭제하지 못했습니다. 기업 자료실에서 확인해 주세요.')
    }
  }

  const send = async (value = input) => {
    const readyAttachments = attachments.filter((item) => item.status === 'ready' && item.documentId)
    const prompt = value.trim() || (readyAttachments.length ? '첨부 파일을 확인하고 핵심 내용과 필요한 후속 업무를 정리해 주세요.' : '')
    if (!prompt || sending || attachments.some((item) => item.status === 'uploading')) return
    const attachmentMeta = readyAttachments.map(({ documentId, name, mimeType, size }) => ({ documentId, name, mimeType, size }))
    const userMessage: ChatMessage = { id: String(Date.now()), role: 'user', content: prompt, createdAt: new Date().toISOString(), attachments: attachmentMeta }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setAttachments((current) => current.filter((item) => item.status !== 'ready'))
    setAttachmentNotice('')
    setSending(true)
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
        body: JSON.stringify({
          messages: nextMessages.filter((message) => message.id !== 'welcome').map(({ role, content, attachments: messageAttachments }) => ({
            role,
            content,
            ...(messageAttachments?.length ? { attachments: messageAttachments } : {}),
          })),
          attachments: attachmentMeta,
          context: { company: companyName, companyName, surface: 'food-manufacturing-erp', operatingData: context, attachments: attachmentMeta },
        }),
      })
      const data = await response.json().catch(() => ({})) as {
        text?: string
        model?: string
        mode?: 'claude' | 'demo'
        attachmentMode?: 'content' | 'metadata'
        attachmentsProcessed?: number
        error?: { message?: string }
      }
      if (!response.ok) throw new Error(data.error?.message || 'AI 요청을 처리하지 못했습니다.')
      const serverText = typeof data.text === 'string' && data.text.trim()
        ? data.text
        : 'Claude 응답이 비어 있어 결과를 적용하지 않았습니다. 잠시 후 다시 요청해 주세요.'
      const contentConfirmed = data.attachmentMode === 'content' || data.attachmentsProcessed === attachmentMeta.length
      const responseText = attachmentMeta.length && data.mode !== 'claude'
        ? `첨부 파일 ${attachmentMeta.length}개는 기업 자료실에 안전하게 저장했습니다. 현재 데모 모드에서는 파일 본문을 읽거나 검증하지 않았습니다. Claude 연결 후 다시 요청해 주세요.`
        : attachmentMeta.length && !contentConfirmed
          ? `${serverText}\n\n첨부 파일은 문서 ID와 메타정보로 전달됐지만, 서버가 본문 판독 완료를 확인하지 않았습니다.`
          : serverText
      setMessages((current) => [...current, {
        id: String(Date.now() + 1),
        role: 'assistant',
        content: responseText,
        model: data.model,
        mode: data.mode || 'demo',
        sourcePrompt: data.mode === 'claude' ? prompt : undefined,
        createdAt: new Date().toISOString(),
      }])
      setApiMode(data.mode === 'claude' ? 'claude' : 'demo')
    } catch (error) {
      setMessages((current) => [...current, {
        id: String(Date.now() + 1),
        role: 'assistant',
        content: `${error instanceof Error ? error.message : 'AI 서버에 연결하지 못했습니다.'} 분석 결과를 만들지 않았고 화면 데이터도 변경하지 않았습니다. 첨부 원본은 기업 자료실에 보존되어 있습니다.`,
        mode: apiMode === 'claude' ? 'claude' : 'demo',
        createdAt: new Date().toISOString(),
      }])
    } finally {
      setSending(false)
    }
  }

  return (
    <section className={'ai-chat ' + (compact ? 'compact' : '')} aria-label="Claude AI 채팅">
      <div className="ai-chat-head dashboard-section-header">
        <div className="ai-chat-identity dashboard-section-title">
          <span className="claude-mark"><Sparkles size={20} /></span>
          <div><strong>AI 업무 대화</strong><span>온팩토리 운영 어시스턴트</span></div>
        </div>
        <span className={'connection-pill ' + apiMode}>
          <i />{apiMode === 'claude' ? 'Claude 연결됨' : apiMode === 'checking' ? '연결 확인 중' : '데모 모드'}
        </span>
      </div>

      <div className="ai-chat-messages" ref={scrollRef}>
        {messages.map((message, index) => (
          <div className={'chat-message ' + message.role} key={message.id}>
            {message.role === 'assistant' && <span className="chat-avatar"><Sparkles size={15} /></span>}
            <div className="chat-message-content">
              <div className="chat-bubble">
                <p>{message.content}</p>
                {message.attachments?.length ? <ul className="chat-message-files" aria-label="이 메시지의 첨부 파일">
                  {message.attachments.map((file) => <li key={file.documentId}><FileText size={14} /><span>{file.name}</span><small>{fileSizeLabel(file.size)}</small></li>)}
                </ul> : null}
                {canCreateTask && message.role === 'assistant' && index > 0 && message.sourcePrompt && (
                  <button type="button" className="message-action" onClick={() => {
                    const draft = aiTaskDraftFromAnswer(message.content, message.sourcePrompt)
                    onCreateTask(draft.title, draft.completionCriteria)
                  }}>
                    <ClipboardPlus size={14} /> 이 내용으로 업무 만들기
                  </button>
                )}
              </div>
              <div className="chat-message-meta">{message.model && <small>{message.model}</small>}<time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time></div>
            </div>
          </div>
        ))}
        {sending && <div className="chat-message assistant"><span className="chat-avatar"><Sparkles size={15} /></span><div className="chat-bubble typing"><LoaderCircle size={16} className="spin" /> 운영 데이터를 확인하고 있어요</div></div>}
      </div>

      {!compact && messages.length < 3 && (
        <div className="chat-suggestions">
          {assistantExperience.suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => send(suggestion)}>{suggestion}</button>)}
        </div>
      )}

      <div className="chat-composer">
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.xlsx,.xls,.docx"
          onChange={(event) => { selectFiles(event.target.files); event.currentTarget.value = '' }}
          aria-label="AI 채팅 파일 선택"
        />
        {attachments.length > 0 && <ul className="chat-attachment-list" aria-label="선택한 첨부 파일" aria-live="polite">
          {attachments.map((attachment) => <li className={attachment.status} key={attachment.localId}>
            <span className="chat-attachment-icon">{attachment.status === 'uploading' ? <LoaderCircle className="spin" size={16} /> : attachment.status === 'error' ? <AlertCircle size={16} /> : <FileText size={16} />}</span>
            <span className="chat-attachment-copy"><strong>{attachment.name}</strong><small>{attachment.error || `${fileSizeLabel(attachment.size)} · ${apiMode === 'demo' ? '저장됨, 데모 분석 안 됨' : attachment.status === 'ready' ? '문서 참조 준비됨' : '기업 자료실에 저장 중'}`}</small></span>
            <button type="button" disabled={attachment.status === 'uploading'} aria-label={attachment.status === 'uploading' ? `${attachment.name} 업로드 중` : `${attachment.name} 첨부 삭제`} onClick={() => void removeAttachment(attachment)}><X size={16} /></button>
          </li>)}
        </ul>}
        {attachmentNotice && <p className="chat-attachment-notice"><AlertCircle size={15} /> {attachmentNotice}</p>}
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
          }}
          rows={compact ? 2 : 3}
          placeholder="정보를 묻거나 업무를 지시하세요..."
          aria-label="AI에게 메시지 보내기"
        />
        <div className="composer-bottom">
          <div className="composer-tools">
            <button type="button" className="chat-file-button" disabled={sending || attachments.length >= MAX_CHAT_FILES} onClick={() => fileInputRef.current?.click()} aria-label="파일 첨부"><Paperclip size={17} /> <span>파일</span></button>
            <span><CheckCircle2 size={14} /> 실행 전 담당자가 확인합니다</span>
          </div>
          <button type="button" className="send-button" disabled={(!input.trim() && !attachments.some((item) => item.status === 'ready')) || sending || attachments.some((item) => item.status === 'uploading')} onClick={() => void send()} aria-label="메시지 전송"><ArrowUp size={19} /></button>
        </div>
      </div>
    </section>
  )
}
