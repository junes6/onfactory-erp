import { useEffect, useRef, useState } from 'react'
import { ArrowUp, CheckCircle2, ClipboardPlus, LoaderCircle, Sparkles } from 'lucide-react'

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  model?: string
  mode?: 'claude' | 'demo'
  sourcePrompt?: string
}

type AIChatProps = {
  compact?: boolean
  companyName: string
  onCreateTask: (instruction: string) => void
  canCreateTask?: boolean
  canViewCommercial?: boolean
  hasDemoData?: boolean
  context?: unknown
}

const suggestions = [
  '오늘 제가 먼저 처리할 일을 정리해줘',
  '쿠팡 판매량과 부족 재고를 분석해줘',
  '붉은대게라면 표시사항을 검토해줘',
  '야간 포장업무 담당자를 추천해줘',
]
const employeeSuggestions = [
  '오늘 제가 먼저 처리할 일을 정리해줘',
  '내 업무 마감과 공유 일정을 정리해줘',
  '붉은대게라면 표시사항을 검토해줘',
  '안전재고가 부족한 제품을 알려줘',
]
const onboardingSuggestions = [
  '첫 제품 등록에 필요한 정보를 정리해줘',
  '판매채널 연동 순서를 안내해줘',
  '창고와 재고 위치 등록 체크리스트를 만들어줘',
  '신규 직원에게 배정할 초기 업무를 제안해줘',
]

export default function AIChat({ compact = false, companyName, onCreateTask, canCreateTask = true, canViewCommercial = true, hasDemoData = true, context }: AIChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: hasDemoData
        ? companyName + (canViewCommercial ? '의 제품, 주문, 재고와 업무 현황을 연결했습니다.' : '의 제품, 재고, 일정과 내 업무를 연결했습니다.') + ' 무엇을 확인할까요?'
        : `${companyName}의 초기 설정을 도와드릴게요. 제품·창고·판매채널 중 무엇부터 연결할까요?`,
      mode: 'demo',
    },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [apiMode, setApiMode] = useState<'checking' | 'claude' | 'demo'>('checking')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setApiMode(data.claude ? 'claude' : 'demo'))
      .catch(() => setApiMode('demo'))
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  const send = async (value = input) => {
    const prompt = value.trim()
    if (!prompt || sending) return
    const userMessage: ChatMessage = { id: String(Date.now()), role: 'user', content: prompt }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setSending(true)
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages.filter((message) => message.id !== 'welcome').map(({ role, content }) => ({ role, content })),
          context: { companyName, surface: 'food-manufacturing-erp', operatingData: context },
        }),
      })
      if (!response.ok) throw new Error('Claude API unavailable')
      const data = await response.json()
      const responseText = typeof data.text === 'string' && data.text.trim()
        ? data.text
        : 'Claude 응답이 비어 있어 결과를 적용하지 않았습니다. 잠시 후 다시 요청해 주세요.'
      setMessages((current) => [...current, {
        id: String(Date.now() + 1),
        role: 'assistant',
        content: responseText,
        model: data.model,
        mode: data.mode || 'demo',
        sourcePrompt: data.mode === 'claude' ? prompt : undefined,
      }])
      setApiMode(data.mode === 'claude' ? 'claude' : 'demo')
    } catch {
      setMessages((current) => [...current, {
        id: String(Date.now() + 1),
        role: 'assistant',
        content: 'AI 서버에 연결하지 못해 분석 결과를 만들지 않았습니다. 화면의 데이터는 변경되지 않았습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.',
        mode: 'demo',
      }])
      setApiMode('demo')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className={'ai-chat ' + (compact ? 'compact' : '')} aria-label="Claude AI 채팅">
      <div className="ai-chat-head">
        <div className="ai-chat-identity">
          <span className="claude-mark"><Sparkles size={20} /></span>
          <div><strong>온팩토리 AI</strong><span>Claude 기반 운영 어시스턴트</span></div>
        </div>
        <span className={'connection-pill ' + apiMode}>
          <i />{apiMode === 'claude' ? 'Claude 연결됨' : apiMode === 'checking' ? '연결 확인 중' : '데모 모드'}
        </span>
      </div>

      <div className="ai-chat-messages" ref={scrollRef}>
        {messages.map((message, index) => (
          <div className={'chat-message ' + message.role} key={message.id}>
            {message.role === 'assistant' && <span className="chat-avatar"><Sparkles size={15} /></span>}
            <div className="chat-bubble">
              <p>{message.content}</p>
              {canCreateTask && message.role === 'assistant' && index > 0 && message.sourcePrompt && (
                <button type="button" className="message-action" onClick={() => onCreateTask(message.sourcePrompt!)}>
                  <ClipboardPlus size={14} /> 이 내용으로 업무 만들기
                </button>
              )}
              {message.model && <small>{message.model}</small>}
            </div>
          </div>
        ))}
        {sending && <div className="chat-message assistant"><span className="chat-avatar"><Sparkles size={15} /></span><div className="chat-bubble typing"><LoaderCircle size={16} className="spin" /> 운영 데이터를 확인하고 있어요</div></div>}
      </div>

      {!compact && messages.length < 3 && (
        <div className="chat-suggestions">
          {(hasDemoData ? (canViewCommercial ? suggestions : employeeSuggestions) : onboardingSuggestions).map((suggestion) => <button type="button" key={suggestion} onClick={() => send(suggestion)}>{suggestion}</button>)}
        </div>
      )}

      <div className="chat-composer">
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
          <span><CheckCircle2 size={14} /> 실행 전 담당자가 확인합니다</span>
          <button type="button" className="send-button" disabled={!input.trim() || sending} onClick={() => void send()} aria-label="메시지 전송"><ArrowUp size={19} /></button>
        </div>
      </div>
    </section>
  )
}
