import { useEffect, useState } from 'react'
import { formatApprovalMonth, formatKrw } from '../../utils/approvalLine'
import type { ApprovalMonthTotal } from './approvalTypes'
import './approval.css'

/**
 * 「승인된 지출」 — 세무·자산 화면의 증빙 파일함 바로 위.
 *
 * 결재로 **승인된** 금액만 모은다. 결재 전 금액을 함께 세면 「이번 달에 쓴 돈」이 아니라
 * 「이번 달에 쓰겠다고 적은 돈」이 되어, 그 숫자를 보고 내리는 판단이 통째로 틀어진다.
 * 관리자는 회사 전체를, 직원은 자기 기안분만 본다 — 범위는 서버가 정하고(`scope`),
 * 화면은 받은 범위를 그대로 말한다(규칙 11).
 */
export function ApprovalSpendPanel({ workspaceScope, canManage }: { workspaceScope?: string; canManage: boolean }) {
  const [months, setMonths] = useState<ApprovalMonthTotal[]>([])
  const [scope, setScope] = useState<'tenant' | 'mine'>(canManage ? 'tenant' : 'mine')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/approval-documents/postings?months=6', { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
      .then(async (response) => (response.ok
        ? response.json() as Promise<{ months?: ApprovalMonthTotal[]; scope?: 'tenant' | 'mine' }>
        : { months: [], scope: undefined }))
      .then((body) => {
        if (!active) return
        setMonths(Array.isArray(body.months) ? body.months : [])
        if (body.scope) setScope(body.scope)
        setLoaded(true)
      })
      .catch(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [workspaceScope])

  // 금액이 한 건도 없는 달만 모여 있으면 「아직 없다」고 말한다 — 0원짜리 막대 여섯 개는 사실이 아니다.
  const filled = months.filter((month) => month.count > 0)

  return <section className="panel approval-spend-panel" aria-label="승인된 지출">
    <h2>승인된 지출</h2>
    <p className="approval-spend-lead">결재로 승인된 금액만 모읍니다. 결재 전 금액은 세지 않습니다.</p>
    {!loaded
      ? <p className="approval-doc-empty">불러오는 중</p>
      : filled.length === 0
        ? <p className="approval-doc-empty">아직 승인된 지출이 없습니다</p>
        : <ul className="approval-spend-months">
          {filled.map((month) => <li key={month.month}>
            <span>{formatApprovalMonth(month.month)}</span>
            <b>{formatKrw(month.amount)}</b>
            <span>{month.count}건</span>
            <span className="approval-spend-kinds">
              {month.byKind.map((entry) => <span key={entry.kind}>{entry.kind} {formatKrw(entry.amount)}</span>)}
            </span>
          </li>)}
        </ul>}
    {scope === 'mine' ? <p className="approval-spend-scope">내가 올린 결재만 셉니다.</p> : null}
  </section>
}
