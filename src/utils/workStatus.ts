import type { WorkItem } from '../domainData'
import type { StatusBadgeTone } from '../components/StatusBadge'

/**
 * 결재 상태의 화면 문구 — 단일 출처.
 *
 * 데스크톱·휴대폰·게스트가 같은 말을 쓴다. 같은 업무가 화면마다 '요청됨'과 '시작 전'으로
 * 달리 불리면 전화로 서로 다른 말을 하게 된다.
 * 보드 칼럼 label(요청됨·진행 중·결재 대기·완료)은 상태가 아니라 단계 이름이라 별개다.
 */
const WORK_STATUS_LABEL: Record<WorkItem['status'], string> = {
  '업무요청': '시작 전',
  '수행중': '진행 중',
  '결재대기': '확인 기다리는 중',
  '결재완료': '완료',
}

export const workStatusLabel = (status: WorkItem['status']) => WORK_STATUS_LABEL[status]

/** 상태 점 색. 완료는 성공, 확인 대기는 정보, 진행 중은 주의, 시작 전은 중립. */
export const workStatusTone = (status: WorkItem['status']): StatusBadgeTone => (
  status === '결재완료' ? 'success' : status === '결재대기' ? 'info' : status === '수행중' ? 'warning' : 'neutral'
)
