import { useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { formatDocumentSize, uploadDocumentAttachment } from '../utils/documentAttachments'
import {
  MAX_RECORDING_BYTES,
  MICROPHONE_WAITING_MESSAGE,
  RECORDER_UNSUPPORTED_MESSAGE,
  RECORDING_AUTO_STOPPED_MESSAGE,
  RECORDING_NEAR_LIMIT_MESSAGE,
  RECORDING_WARN_RATIO,
  type MicrophoneStream,
  type RecordingSession,
  formatElapsed,
  microphoneErrorMessage,
  pickRecorderMime,
  recordingFileName,
  requestMicrophone,
  startRecordingSession,
  stopStream,
} from '../utils/mediaRecorder'
import {
  MEETING_SOURCE_CATEGORY,
  MEETING_SOURCE_TAG,
  type TranscriptionStatus,
  recordingConfirmNote,
} from '../utils/meetingNotes'
import { Button } from './ui/Button'

/**
 * 회의 녹음 — 마이크에서 파일까지.
 *
 * **되지 않는 일을 되는 것처럼 그리지 않는다.** 오늘 실제로 되는 것은 「소리를 파일로 만들어
 * 자료실에 보관하는 것」까지다. 음성 전사 벤더가 붙기 전에는 그 파일에서 글이 나오지 않으므로,
 * 녹음을 시작하기 전에 그 사실을 먼저 말하고 사람이 알고 누르게 한다.
 *
 * 브라우저가 녹음 자체를 지원하지 않으면 버튼을 **그리지 않는다** — 눌러야 안 된다는 것을
 * 알게 되는 버튼은 버튼이 아니다.
 *
 * 단계는 넷이다: `idle` → (모르거나 벤더가 없으면) `confirm` → `requesting`(마이크 승인 대기) →
 * `recording` → `saving`. `requesting`을 따로 두는 이유는 **승인 대화상자가 떠 있는 동안은
 * 아무것도 녹음되지 않기 때문**이다 — 그 사이에 빨간 점·경과 시간·용량 막대를 그리면 그것은
 * 가짜 진행 표시이고, 그때 「그만」을 눌러도 멈출 세션이 아직 없다.
 */
export function MeetingRecorder({ transcription, workspaceScope, disabled, onToast, onRecorded }: {
  transcription: TranscriptionStatus | null
  workspaceScope?: string
  disabled?: boolean
  onToast: (message: string) => void
  /** 올라간 녹음 파일. 회의를 실제로 만드는 것은 부모의 「새 회의」 대화상자다(제목은 사람이 정한다). */
  onRecorded: (source: { documentId: string; name: string; sizeLabel: string; kind: 'recording' }) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'requesting' | 'recording' | 'saving'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [bytes, setBytes] = useState(0)
  const sessionRef = useRef<RecordingSession | null>(null)
  const streamRef = useRef<MicrophoneStream | null>(null)
  const startedAtRef = useRef<Date>(new Date())
  /**
   * 지금 유효한 **시도 번호**. 브라우저의 권한 대화상자는 우리가 닫을 수 없으므로, 뒤늦게 도착한
   * 스트림을 곧바로 놓는 것이 유일한 취소다.
   *
   * 깃발 하나(`cancelled`)로는 모자란다: `begin()`이 맨 위에서 깃발을 되돌리므로, 승인을 기다리는
   * 동안 「취소」를 누르고 다시 「알고도 녹음」을 누르면 **첫 번째** 스트림이 뒤늦게 도착했을 때
   * 취소로 읽히지 않고 `streamRef`를 차지했다가 두 번째 스트림에 덮인다 — 앞 스트림은 아무도 놓지
   * 않아 마이크가 켜진 채 남는다(`stopStream`은 ref 하나만 본다). 시도마다 번호를 매기면
   * 「취소」·언마운트·새 시도가 앞선 시도를 **한 번에** 무효로 만든다.
   */
  const attemptRef = useRef(0)

  // 이 브라우저가 만들 수 있는 형식. 한 번만 재고, 없으면 버튼 자리에 이유를 쓴다.
  const [mimeType] = useState(() => pickRecorderMime())

  useEffect(() => () => {
    // 화면을 떠나도 마이크 표시등이 켜진 채 남지 않게 한다. 아직 승인을 기다리는 중이라면
    // 스트림은 이 정리보다 늦게 도착하므로, 시도 번호를 밀어 **진행 중인 모든 시도**가 그때 놓게 한다.
    attemptRef.current += 1
    sessionRef.current?.stop()
    stopStream(streamRef.current)
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current.getTime()) / 1000))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [phase])

  const finish = async (blob: Blob, autoStopped: boolean) => {
    stopStream(streamRef.current)
    streamRef.current = null
    sessionRef.current = null
    if (autoStopped) onToast(RECORDING_AUTO_STOPPED_MESSAGE)
    if (!blob.size) {
      setPhase('idle')
      onToast('녹음된 소리가 없습니다. 마이크 입력을 확인한 뒤 다시 시도해 주세요.')
      return
    }
    setPhase('saving')
    try {
      const name = recordingFileName(startedAtRef.current, mimeType)
      const file = new File([blob], name, { type: blob.type || mimeType || 'audio/webm' })
      // AI 처리 수준은 보내지 않는다 — 회의 원본의 수준은 **서버가** 분류·태그를 보고 '보관만'으로 정한다.
      // 화면이 값을 잊어도 안전한 쪽으로 떨어져야 하고, 정하는 곳이 둘이면 곧 갈린다.
      const stored = await uploadDocumentAttachment(file, {
        workspaceScope,
        category: MEETING_SOURCE_CATEGORY,
        summary: '회의 녹음 원본',
        tags: [MEETING_SOURCE_TAG],
      })
      onRecorded({ documentId: stored.id, name: stored.name, sizeLabel: stored.size, kind: 'recording' })
      onToast('녹음을 자료실에 보관했습니다. 회의 제목을 정하면 회의가 만들어집니다.')
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '녹음 파일을 저장하지 못했습니다.')
    } finally {
      setPhase('idle')
      setElapsed(0)
      setBytes(0)
    }
  }

  const begin = async () => {
    // 이 시도의 번호. 새 시도를 시작하는 것 자체가 앞선 시도를 무효로 만든다.
    const attempt = ++attemptRef.current
    // 승인을 기다리는 동안 그리는 것은 「기다리는 중」뿐이다. 녹음 표시(경과 시간·용량 막대)는
    // 실제로 녹음이 시작된 뒤에 켠다.
    setPhase('requesting')
    setElapsed(0)
    setBytes(0)
    try {
      const stream = await requestMicrophone()
      if (attempt !== attemptRef.current) {
        // 기다리는 사이에 취소했거나(화면을 떠났거나) 새 시도가 시작됐다. 이 스트림은 이 자리에서
        // 놓는다 — `streamRef`에 꽂으면 지금 유효한 시도의 스트림을 덮어 마이크가 켜진 채 남는다.
        // 단계는 건드리지 않는다: 지금 화면을 정하는 것은 뒤에 온 시도이지 이 시도가 아니다.
        stopStream(stream)
        return
      }
      streamRef.current = stream
      // 경과 시간의 기준은 **실제로 녹음이 시작된 순간**이다. 승인 대화상자를 보던 시간을
      // 여기에 섞으면 화면이 없던 소리를 있었다고 말한다.
      startedAtRef.current = new Date()
      sessionRef.current = startRecordingSession({
        stream,
        mimeType,
        onProgress: setBytes,
        onFinish: ({ blob, autoStopped }) => { void finish(blob, autoStopped) },
        onError: (message) => { onToast(message) },
      })
      // 「그만」이 멈출 세션이 이미 있는 상태에서만 녹음 표시를 켠다.
      setPhase('recording')
    } catch (cause) {
      // 무효가 된 시도의 실패는 조용히 버린다 — 지금 돌고 있는 시도의 스트림과 단계를 건드리지 않고,
      // 사람이 이미 취소한 일에 대해 오류를 말하지도 않는다.
      if (attempt !== attemptRef.current) return
      stopStream(streamRef.current)
      streamRef.current = null
      setPhase('idle')
      onToast(microphoneErrorMessage(cause))
    }
  }

  if (!mimeType) {
    return <p className="meeting-recorder-note">{RECORDER_UNSUPPORTED_MESSAGE}</p>
  }

  if (phase === 'requesting') {
    return (
      <div className="meeting-recorder-confirm" role="status" aria-live="polite">
        <p>{MICROPHONE_WAITING_MESSAGE}</p>
        <div className="meeting-recorder-confirm-actions">
          <Button
            tone="ghost"
            size="sm"
            type="button"
            onClick={() => { attemptRef.current += 1; setPhase('idle') }}
          >취소</Button>
        </div>
      </div>
    )
  }

  if (phase === 'recording' || phase === 'saving') {
    const ratio = Math.min(1, bytes / MAX_RECORDING_BYTES)
    const near = ratio >= RECORDING_WARN_RATIO
    return (
      <div className="meeting-recorder-bar" role="status" aria-live="polite">
        <span className="meeting-recorder-dot" aria-hidden="true" />
        <strong>{phase === 'saving' ? '저장 중' : formatElapsed(elapsed)}</strong>
        <span className="meeting-recorder-meter" aria-hidden="true">
          <span className="meeting-recorder-meter-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
        <small>{formatDocumentSize(bytes)} / {formatDocumentSize(MAX_RECORDING_BYTES)}{near ? ` · ${RECORDING_NEAR_LIMIT_MESSAGE}` : ''}</small>
        <Button
          tone="danger"
          size="sm"
          type="button"
          disabled={phase === 'saving'}
          onClick={() => sessionRef.current?.stop()}
        ><Square size={15} /> 그만</Button>
      </div>
    )
  }

  if (phase === 'confirm') {
    return (
      <div className="meeting-recorder-confirm" role="group" aria-label="녹음 시작 확인">
        <p>{recordingConfirmNote(transcription)}</p>
        <div className="meeting-recorder-confirm-actions">
          <Button tone="ghost" size="sm" type="button" onClick={() => setPhase('idle')}>취소</Button>
          <Button tone="secondary" size="sm" type="button" onClick={() => void begin()}><Mic size={15} /> 알고도 녹음</Button>
        </div>
      </div>
    )
  }

  return (
    <Button
      tone="secondary"
      type="button"
      disabled={disabled}
      title={transcription?.acceptsAudio ? undefined : recordingConfirmNote(transcription)}
      // 벤더가 없으면 곧바로 녹음하지 않는다 — 무엇이 되고 무엇이 안 되는지 먼저 말하고,
      // 사람이 그것을 읽은 뒤에 시작한다. **모르는 쪽도 안전한 쪽으로 떨어진다**: 목록 요청이
      // 실패하면 `transcription`은 null로 남는데, 그때 확인을 건너뛰면 사람은 40분을 녹음한 뒤에야
      // 그 파일이 글로 옮겨지지 않는다는 것을 알게 된다.
      onClick={() => { if (!transcription || !transcription.acceptsAudio) setPhase('confirm'); else void begin() }}
    ><Mic size={17} /> 녹음 시작</Button>
  )
}
