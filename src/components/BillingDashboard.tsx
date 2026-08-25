import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Activity, Bot, Building2, CalendarCheck2, Coins, Database, Gauge,
  Pencil, RefreshCw, Save, ShieldCheck, TriangleAlert,
} from 'lucide-react'

import StatusBadge, { type StatusBadgeTone } from './StatusBadge'
import { formatDateTime, seoulDateInputValue } from '../utils/dateTime'
import './BillingDashboard.css'

const UNCONFIRMED_AMOUNT = 0

export type BillingMode = 'platform'
export type BillingLimitAction = 'warn' | 'block'
export type BillingConfigurationStatus = 'confirmed' | 'unconfirmed' | 'unconfigured'

export type BillingSummary = {
  month: string
  tenantCount?: number
  currency: string | null
  eventCount: number
  inputTokens: number
  outputTokens: number
  pointsUsed: number
  pointLimit: number | null
  utilizationPercent: number | null
  revenue: number
  invoiceTotal: number
  apiCost: number
  margin: number
  baseRevenue: number
  pointOveragePoints: number
  pointOverageRevenue: number
  storageOverageRevenue: number
  aiCost: number
  planCost: number
  storageCost: number
  totalCost: number
  storageBytes: number
  storageObjectCount: number
  configurationStatus: BillingConfigurationStatus
}

export type BillingDetailRow = {
  key: string
  label: string
  eventCount: number
  inputTokens: number
  outputTokens: number
  pointsUsed: number
  aiCost: number
}

export type BillingTenantRow = BillingSummary & {
  tenantId: string
  limitAction: BillingLimitAction
  planId: string | null
  planName: string | null
  snapshot?: { immutable: boolean } | null
}

export type BillingModelRate = {
  model: string
  displayName: string
  currency: string
  inputCostPerMillion: number
  outputCostPerMillion: number
  inputPointsPerMillion: number
  outputPointsPerMillion: number
  confirmed: boolean
  updatedAt?: string
  updatedBy?: string
}

export type BillingPlan = {
  id: string
  name: string
  currency: string
  monthlyPrice: number
  includedPoints: number
  includedStorageBytes: number
  storageOveragePerGb: number
  pointOveragePrice: number
  warningThresholdPercent: number
  confirmed: boolean
  active: boolean
}

export type BillingAssignment = {
  tenantId: string
  planId: string
  pointLimitOverride: number | null
  limitAction: BillingLimitAction
  assignedAt?: string
}

export type BillingMonthlySnapshot = {
  id: string
  tenantId: string
  billingMonth: string
  summary: BillingSummary
  immutable: true
  finalizedAt: string
  finalizedBy: string
}

export type BillingDashboardPayload = {
  scope: BillingMode
  month: string
  tenantIds: string[]
  cards: {
    revenue: number
    invoiceTotal: number
    apiCost: number
    margin: number
    pointOverageRevenue: number
    storageOverageRevenue: number
    totalCost: number
    aiCost: number
    pointsUsed: number
    pointLimit: number | null
    utilizationPercent: number | null
    storageBytes: number
    eventCount: number
    configurationStatus: BillingConfigurationStatus
    currency: string | null
  }
  summary: BillingSummary
  gauge: {
    tenantId: string
    pointsUsed: number
    pointLimit: number | null
    utilizationPercent: number | null
    limitAction: BillingLimitAction
    configurationStatus: BillingConfigurationStatus
  } | null
  series: BillingSummary[]
  details: {
    tenants: BillingTenantRow[]
    models: BillingDetailRow[]
    features: BillingDetailRow[]
    users: BillingDetailRow[]
  }
  monthlySnapshots: BillingMonthlySnapshot[]
  configuration?: {
    modelRates: BillingModelRate[]
    plans: BillingPlan[]
    assignments: BillingAssignment[]
    defaults: { currency: string; limitAction: BillingLimitAction }
  }
}

export type BillingTenantOption = { id: string; name: string }

export interface BillingDashboardApi {
  loadDashboard(input: { month: string; tenantId?: string }): Promise<BillingDashboardPayload>
  saveModelRate(input: BillingModelRate): Promise<BillingModelRate>
  savePlan(input: BillingPlan): Promise<BillingPlan>
  assignPlan(input: BillingAssignment): Promise<BillingAssignment>
  finalizeMonth(input: { tenantId: string; month: string }): Promise<{ snapshot: BillingMonthlySnapshot; created: boolean }>
}

type BillingApiErrorBody = { error?: { message?: string } }

async function billingJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    let message = '비용·포인트 데이터를 처리하지 못했습니다.'
    try { message = (await response.json() as BillingApiErrorBody).error?.message || message } catch { /* keep safe message */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export function createBillingHttpApi(basePath = '/api/billing', workspaceScope?: string): BillingDashboardApi {
  const request = <T,>(url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (workspaceScope) headers.set('x-workspace-identity', workspaceScope)
    return billingJson<T>(url, { ...init, headers })
  }
  return {
    loadDashboard({ month, tenantId }) {
      const query = new URLSearchParams({ month })
      if (tenantId) query.set('tenantId', tenantId)
      return request<BillingDashboardPayload>(`${basePath}/dashboard?${query}`)
    },
    saveModelRate(input) {
      return request<BillingModelRate>(`${basePath}/model-rates/${encodeURIComponent(input.model)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      })
    },
    savePlan(input) {
      return request<BillingPlan>(`${basePath}/plans/${encodeURIComponent(input.id)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      })
    },
    assignPlan(input) {
      return request<BillingAssignment>(`${basePath}/tenant-assignments/${encodeURIComponent(input.tenantId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      })
    },
    finalizeMonth(input) {
      return request<{ snapshot: BillingMonthlySnapshot; created: boolean }>(`${basePath}/monthly-snapshots`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      })
    },
  }
}

export interface BillingDashboardProps {
  mode: 'platform'
  tenantOptions?: BillingTenantOption[]
  initialMonth?: string
  api?: BillingDashboardApi
  onToast?: (message: string) => void
  onDataChanged?: () => void
}

type RateDraft = {
  model: string
  displayName: string
  currency: string
  inputCostPerMillion: string
  outputCostPerMillion: string
  inputPointsPerThousand: string
  outputPointsPerThousand: string
  confirmed: boolean
}

type PlanDraft = {
  id: string
  name: string
  currency: string
  monthlyPrice: string
  includedPoints: string
  includedStorageBytes: string
  storageOveragePerGb: string
  pointOveragePrice: string
  warningThresholdPercent: string
  confirmed: boolean
  active: boolean
}

const emptyRateDraft = (currency = 'KRW'): RateDraft => ({
  model: '', displayName: '', currency, inputCostPerMillion: '', outputCostPerMillion: '',
  inputPointsPerThousand: '', outputPointsPerThousand: '', confirmed: false,
})

const emptyPlanDraft = (currency = 'KRW'): PlanDraft => ({
  id: '', name: '', currency, monthlyPrice: '', includedPoints: '', includedStorageBytes: '',
  storageOveragePerGb: '', pointOveragePrice: '', warningThresholdPercent: '', confirmed: false, active: true,
})

function currentKoreaMonth() {
  return seoulDateInputValue().slice(0, 7)
}

function formatNumber(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits }).format(value)
}

function formatMoney(value: number, currency: string | null) {
  if (!currency) return '금액 미확정'
  try {
    return new Intl.NumberFormat('ko-KR', { style: 'currency', currency, maximumFractionDigits: 6 }).format(value)
  } catch { return `${formatNumber(value, 6)} ${currency}` }
}

function formatBytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let unit = 0
  while (amount >= 1_000 && unit < units.length - 1) { amount /= 1_000; unit += 1 }
  return `${formatNumber(amount)} ${units[unit]}`
}

function statusPresentation(status: BillingConfigurationStatus): { label: string; tone: StatusBadgeTone } {
  if (status === 'confirmed') return { label: '요율 확정', tone: 'success' }
  if (status === 'unconfirmed') return { label: '일부 미확정', tone: 'warning' }
  return { label: '설정 필요', tone: 'neutral' }
}

function numberOrUnconfirmed(value: string) {
  return value.trim() ? Number(value) : UNCONFIRMED_AMOUNT
}

function pointsPerThousandToMillion(value: string) {
  return numberOrUnconfirmed(value) * 1_000
}

function tenantLabel(id: string, options: BillingTenantOption[], fallback?: string) {
  return options.find((tenant) => tenant.id === id)?.name ?? fallback ?? id
}

function MetricCard({ icon: Icon, label, value, note, tone = 'neutral' }: {
  icon: typeof Activity
  label: string
  value: string
  note: string
  tone?: StatusBadgeTone
}) {
  return <article className={`billing-metric billing-metric--${tone}`}>
    <span className="billing-metric__icon"><Icon size={18} aria-hidden="true" /></span>
    <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
  </article>
}

function UsageGauge({ payload, tenantName }: { payload: BillingDashboardPayload; tenantName?: string }) {
  const gauge = payload.gauge
  if (!gauge) return null
  const configured = gauge.pointLimit !== null
  const progress = Math.max(0, Math.min(100, gauge.utilizationPercent ?? 0))
  const presentation = statusPresentation(gauge.configurationStatus)
  return <section className="billing-gauge" aria-labelledby="billing-gauge-title">
    <div className="billing-gauge__copy">
      <span className="billing-section-kicker">TENANT POINTS</span>
      <h2 id="billing-gauge-title">{tenantName ?? gauge.tenantId} 포인트 사용량</h2>
      <p>{configured ? `${formatNumber(gauge.pointsUsed)} / ${formatNumber(gauge.pointLimit ?? 0)} 포인트` : '요금제와 포인트 한도를 설정하면 사용률이 표시됩니다.'}</p>
    </div>
    <div className="billing-gauge__meter">
      <div><strong>{configured ? `${formatNumber(gauge.utilizationPercent ?? 0)}%` : '미설정'}</strong><StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge></div>
      <progress max={100} value={progress} aria-label="포인트 한도 사용률" />
      <small>한도 초과 동작: {gauge.limitAction === 'block' ? '요청 차단' : '경고 후 허용'}</small>
    </div>
  </section>
}

function SixMonthTrend({ series }: { series: BillingSummary[] }) {
  const maximum = Math.max(...series.map((item) => item.invoiceTotal), Number.EPSILON)
  return <section className="billing-panel" aria-labelledby="billing-trend-title">
    <header><div><span className="billing-section-kicker">6 MONTH TREND</span><h2 id="billing-trend-title">월별 비용·포인트</h2></div></header>
    <div className="billing-trend-list">
      {series.map((item) => <article key={item.month}>
        <time dateTime={item.month}>{item.month}</time>
        <div><progress max={maximum} value={item.invoiceTotal} aria-label={`${item.month} 매출 비중`} /><small>{formatNumber(item.pointsUsed)} P</small></div>
        <strong>{formatMoney(item.invoiceTotal, item.currency)}</strong>
      </article>)}
    </div>
  </section>
}

function BreakdownTable({ title, rows, currency, showApiCost }: { title: string; rows: BillingDetailRow[]; currency: string | null; showApiCost: boolean }) {
  return <section className="billing-panel billing-breakdown">
    <header><div><span className="billing-section-kicker">DETAIL</span><h2>{title}</h2></div></header>
    {rows.length ? <div className="billing-table-wrap"><table>
      <thead><tr><th>항목</th><th>호출</th><th>입력 토큰</th><th>출력 토큰</th><th>포인트</th>{showApiCost && <th>API 원가</th>}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}><td><strong>{row.label}</strong></td><td>{formatNumber(row.eventCount)}</td><td>{formatNumber(row.inputTokens)}</td><td>{formatNumber(row.outputTokens)}</td><td>{formatNumber(row.pointsUsed)}</td>{showApiCost && <td>{formatMoney(row.aiCost, currency)}</td>}</tr>)}</tbody>
    </table></div> : <div className="billing-empty">선택한 기간의 사용 내역이 없습니다.</div>}
  </section>
}

function TenantTable({ rows, options }: { rows: BillingTenantRow[]; options: BillingTenantOption[] }) {
  return <section className="billing-panel billing-tenant-detail">
    <header><div><span className="billing-section-kicker">TENANT DETAIL</span><h2>고객사별 이번 달 현황</h2></div></header>
    {rows.length ? <div className="billing-table-wrap"><table>
      <thead><tr><th>고객사</th><th>요금제</th><th>사용 포인트</th><th>한도</th><th>매출</th><th>API 원가</th><th>마진</th><th>상태</th></tr></thead>
      <tbody>{rows.map((row) => { const status = statusPresentation(row.configurationStatus); return <tr key={row.tenantId}>
        <td><strong>{tenantLabel(row.tenantId, options)}</strong><small>{row.tenantId}</small></td><td>{row.planName ?? '미배정'}</td><td>{formatNumber(row.pointsUsed)}</td><td>{row.pointLimit === null ? '미설정' : formatNumber(row.pointLimit)}</td><td>{formatMoney(row.revenue, row.currency)}</td><td>{formatMoney(row.apiCost, row.currency)}</td><td>{formatMoney(row.margin, row.currency)}</td><td><StatusBadge tone={status.tone}>{status.label}</StatusBadge></td>
      </tr> })}</tbody>
    </table></div> : <div className="billing-empty">비용 관리 대상 고객사가 없습니다.</div>}
  </section>
}

function SnapshotList({ snapshots, options }: { snapshots: BillingMonthlySnapshot[]; options: BillingTenantOption[] }) {
  return <section className="billing-panel billing-snapshots">
    <header><div><span className="billing-section-kicker">IMMUTABLE LEDGER</span><h2>확정 월 청구 스냅샷</h2></div><StatusBadge icon={<ShieldCheck size={14} />} tone="info">변경 불가</StatusBadge></header>
    {snapshots.length ? <div className="billing-snapshot-list">{snapshots.map((snapshot) => <article key={snapshot.id}>
      <CalendarCheck2 size={18} aria-hidden="true" />
      <div><strong>{snapshot.billingMonth} · {tenantLabel(snapshot.tenantId, options)}</strong><small>{formatDateTime(snapshot.finalizedAt)} · {snapshot.finalizedBy}</small></div>
      <span>{formatMoney(snapshot.summary.invoiceTotal, snapshot.summary.currency)}</span>
    </article>)}</div> : <div className="billing-empty">아직 확정된 월 스냅샷이 없습니다.</div>}
  </section>
}

function PlatformConfiguration({ payload, tenantOptions, api, onSaved, onError }: {
  payload: BillingDashboardPayload
  tenantOptions: BillingTenantOption[]
  api: BillingDashboardApi
  onSaved: (message: string) => Promise<void>
  onError: (error: unknown) => void
}) {
  const configuration = payload.configuration
  const defaultCurrency = configuration?.defaults.currency ?? 'KRW'
  const [rate, setRate] = useState<RateDraft>(() => emptyRateDraft(defaultCurrency))
  const [plan, setPlan] = useState<PlanDraft>(() => emptyPlanDraft(defaultCurrency))
  const [assignmentTenant, setAssignmentTenant] = useState('')
  const [assignmentPlan, setAssignmentPlan] = useState('')
  const [pointLimitOverride, setPointLimitOverride] = useState('')
  const [limitAction, setLimitAction] = useState<BillingLimitAction>('warn')
  const [saving, setSaving] = useState('')

  if (!configuration) return null

  const editRate = (item: BillingModelRate) => setRate({
    model: item.model, displayName: item.displayName, currency: item.currency,
    inputCostPerMillion: String(item.inputCostPerMillion), outputCostPerMillion: String(item.outputCostPerMillion),
    inputPointsPerThousand: String(item.inputPointsPerMillion / 1_000), outputPointsPerThousand: String(item.outputPointsPerMillion / 1_000),
    confirmed: item.confirmed,
  })
  const editPlan = (item: BillingPlan) => setPlan({
    id: item.id, name: item.name, currency: item.currency, monthlyPrice: String(item.monthlyPrice),
    includedPoints: String(item.includedPoints), includedStorageBytes: String(item.includedStorageBytes),
    storageOveragePerGb: String(item.storageOveragePerGb), pointOveragePrice: String(item.pointOveragePrice), warningThresholdPercent: String(item.warningThresholdPercent),
    confirmed: item.confirmed, active: item.active,
  })

  const submitRate = async (event: FormEvent) => {
    event.preventDefault(); setSaving('rate')
    try {
      await api.saveModelRate({
        model: rate.model, displayName: rate.displayName || rate.model, currency: rate.currency,
        inputCostPerMillion: numberOrUnconfirmed(rate.inputCostPerMillion), outputCostPerMillion: numberOrUnconfirmed(rate.outputCostPerMillion),
        inputPointsPerMillion: pointsPerThousandToMillion(rate.inputPointsPerThousand), outputPointsPerMillion: pointsPerThousandToMillion(rate.outputPointsPerThousand),
        confirmed: rate.confirmed,
      })
      setRate(emptyRateDraft(defaultCurrency)); await onSaved('모델 요율을 저장했습니다.')
    } catch (error) { onError(error) } finally { setSaving('') }
  }
  const submitPlan = async (event: FormEvent) => {
    event.preventDefault(); setSaving('plan')
    try {
      await api.savePlan({
        id: plan.id, name: plan.name, currency: plan.currency,
        monthlyPrice: numberOrUnconfirmed(plan.monthlyPrice), includedPoints: numberOrUnconfirmed(plan.includedPoints),
        includedStorageBytes: numberOrUnconfirmed(plan.includedStorageBytes), storageOveragePerGb: numberOrUnconfirmed(plan.storageOveragePerGb),
        pointOveragePrice: numberOrUnconfirmed(plan.pointOveragePrice),
        warningThresholdPercent: numberOrUnconfirmed(plan.warningThresholdPercent), confirmed: plan.confirmed, active: plan.active,
      })
      setPlan(emptyPlanDraft(defaultCurrency)); await onSaved('요금제를 저장했습니다.')
    } catch (error) { onError(error) } finally { setSaving('') }
  }
  const submitAssignment = async (event: FormEvent) => {
    event.preventDefault(); setSaving('assignment')
    try {
      await api.assignPlan({ tenantId: assignmentTenant, planId: assignmentPlan, pointLimitOverride: pointLimitOverride.trim() ? Number(pointLimitOverride) : null, limitAction })
      setPointLimitOverride(''); await onSaved('고객사 요금제와 한도 동작을 저장했습니다.')
    } catch (error) { onError(error) } finally { setSaving('') }
  }

  return <section className="billing-config" aria-labelledby="billing-config-title">
    <header><div><span className="billing-section-kicker">PLATFORM SETTINGS</span><h2 id="billing-config-title">요율·요금제·고객사 배정</h2><p>실제 계약 가격을 확인하기 전에는 0과 미확정 상태로 저장합니다.</p></div></header>
    <div className="billing-config-grid">
      <section className="billing-config-card">
        <header><div><Bot size={18} /><strong>모델 요율</strong></div><StatusBadge tone="neutral">{configuration.modelRates.length}개</StatusBadge></header>
        <div className="billing-config-list">{configuration.modelRates.map((item) => <button type="button" key={item.model} onClick={() => editRate(item)}><span><strong>{item.displayName}</strong><small>{item.model}</small></span><StatusBadge tone={item.confirmed ? 'success' : 'warning'}>{item.confirmed ? '확정' : '미확정'}</StatusBadge><Pencil size={15} /></button>)}</div>
        <form onSubmit={submitRate} className="billing-config-form">
          <label><span>모델 키</span><input required value={rate.model} onChange={(event) => setRate({ ...rate, model: event.target.value })} /></label>
          <label><span>표시 이름</span><input value={rate.displayName} onChange={(event) => setRate({ ...rate, displayName: event.target.value })} /></label>
          <label><span>통화</span><input required value={rate.currency} onChange={(event) => setRate({ ...rate, currency: event.target.value })} /></label>
          <label><span>입력 비용 / 100만 토큰</span><input min="0" step="any" type="number" value={rate.inputCostPerMillion} onChange={(event) => setRate({ ...rate, inputCostPerMillion: event.target.value })} placeholder="미확정" /></label>
          <label><span>출력 비용 / 100만 토큰</span><input min="0" step="any" type="number" value={rate.outputCostPerMillion} onChange={(event) => setRate({ ...rate, outputCostPerMillion: event.target.value })} placeholder="미확정" /></label>
          <label><span>입력 포인트 / 1천 토큰</span><input min="0" step="any" type="number" value={rate.inputPointsPerThousand} onChange={(event) => setRate({ ...rate, inputPointsPerThousand: event.target.value })} placeholder="미확정" /></label>
          <label><span>출력 포인트 / 1천 토큰</span><input min="0" step="any" type="number" value={rate.outputPointsPerThousand} onChange={(event) => setRate({ ...rate, outputPointsPerThousand: event.target.value })} placeholder="미확정" /></label>
          <label className="billing-check"><input type="checkbox" checked={rate.confirmed} onChange={(event) => setRate({ ...rate, confirmed: event.target.checked })} /><span>계약 요율 확인 완료</span></label>
          <button type="submit" disabled={saving === 'rate'}><Save size={16} />{saving === 'rate' ? '저장 중' : '모델 요율 저장'}</button>
        </form>
      </section>

      <section className="billing-config-card">
        <header><div><Coins size={18} /><strong>요금제</strong></div><StatusBadge tone="neutral">{configuration.plans.length}개</StatusBadge></header>
        <div className="billing-config-list">{configuration.plans.map((item) => <button type="button" key={item.id} onClick={() => editPlan(item)}><span><strong>{item.name}</strong><small>{formatMoney(item.monthlyPrice, item.currency)} · {formatNumber(item.includedPoints)} P</small></span><StatusBadge tone={item.confirmed ? 'success' : 'warning'}>{item.confirmed ? '확정' : '미확정'}</StatusBadge><Pencil size={15} /></button>)}</div>
        <form onSubmit={submitPlan} className="billing-config-form">
          <label><span>요금제 ID</span><input required value={plan.id} onChange={(event) => setPlan({ ...plan, id: event.target.value })} /></label>
          <label><span>요금제 이름</span><input required value={plan.name} onChange={(event) => setPlan({ ...plan, name: event.target.value })} /></label>
          <label><span>통화</span><input required value={plan.currency} onChange={(event) => setPlan({ ...plan, currency: event.target.value })} /></label>
          <label><span>월 기본료</span><input min="0" step="any" type="number" value={plan.monthlyPrice} onChange={(event) => setPlan({ ...plan, monthlyPrice: event.target.value })} placeholder="미확정" /></label>
          <label><span>포함 포인트</span><input min="0" step="any" type="number" value={plan.includedPoints} onChange={(event) => setPlan({ ...plan, includedPoints: event.target.value })} placeholder="미확정" /></label>
          <label><span>포인트 초과 단가 / 1P</span><input min="0" step="any" type="number" value={plan.pointOveragePrice} onChange={(event) => setPlan({ ...plan, pointOveragePrice: event.target.value })} placeholder="미확정" /></label>
          <label><span>포함 저장공간(bytes)</span><input min="0" step="1" type="number" value={plan.includedStorageBytes} onChange={(event) => setPlan({ ...plan, includedStorageBytes: event.target.value })} placeholder="미확정" /></label>
          <label><span>초과 저장공간 / GB</span><input min="0" step="any" type="number" value={plan.storageOveragePerGb} onChange={(event) => setPlan({ ...plan, storageOveragePerGb: event.target.value })} placeholder="미확정" /></label>
          <label><span>경고 기준(%)</span><input min="0" max="100" step="any" type="number" value={plan.warningThresholdPercent} onChange={(event) => setPlan({ ...plan, warningThresholdPercent: event.target.value })} /></label>
          <label className="billing-check"><input type="checkbox" checked={plan.confirmed} onChange={(event) => setPlan({ ...plan, confirmed: event.target.checked })} /><span>계약 금액 확인 완료</span></label>
          <label className="billing-check"><input type="checkbox" checked={plan.active} onChange={(event) => setPlan({ ...plan, active: event.target.checked })} /><span>신규 배정 허용</span></label>
          <button type="submit" disabled={saving === 'plan'}><Save size={16} />{saving === 'plan' ? '저장 중' : '요금제 저장'}</button>
        </form>
      </section>

      <section className="billing-config-card billing-config-card--assignment">
        <header><div><Building2 size={18} /><strong>고객사 배정·한도</strong></div><StatusBadge tone="neutral">기본 경고</StatusBadge></header>
        <form onSubmit={submitAssignment} className="billing-config-form billing-assignment-form">
          <label><span>고객사</span><select required value={assignmentTenant} onChange={(event) => { const tenantId = event.target.value; const existing = configuration.assignments.find((item) => item.tenantId === tenantId); setAssignmentTenant(tenantId); setAssignmentPlan(existing?.planId ?? ''); setPointLimitOverride(existing?.pointLimitOverride === null || existing?.pointLimitOverride === undefined ? '' : String(existing.pointLimitOverride)); setLimitAction(existing?.limitAction ?? 'warn') }}><option value="">선택</option>{tenantOptions.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></label>
          <label><span>요금제</span><select required value={assignmentPlan} onChange={(event) => setAssignmentPlan(event.target.value)}><option value="">선택</option>{configuration.plans.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}{item.confirmed ? '' : ' · 미확정'}</option>)}</select></label>
          <label><span>포인트 한도 재정의</span><input min="0" step="any" type="number" value={pointLimitOverride} onChange={(event) => setPointLimitOverride(event.target.value)} placeholder="비우면 요금제 기준" /></label>
          <label><span>한도 초과 동작</span><select value={limitAction} onChange={(event) => setLimitAction(event.target.value as BillingLimitAction)}><option value="warn">경고 후 허용</option><option value="block">AI 요청 차단</option></select></label>
          <button type="submit" disabled={saving === 'assignment'}><Save size={16} />{saving === 'assignment' ? '저장 중' : '배정 저장'}</button>
        </form>
        <div className="billing-assignment-list">{configuration.assignments.map((item) => <article key={item.tenantId}><div><strong>{tenantLabel(item.tenantId, tenantOptions)}</strong><small>{configuration.plans.find((planItem) => planItem.id === item.planId)?.name ?? item.planId}</small></div><StatusBadge tone={item.limitAction === 'block' ? 'danger' : 'warning'}>{item.limitAction === 'block' ? '초과 차단' : '초과 경고'}</StatusBadge></article>)}</div>
      </section>
    </div>
  </section>
}

export function BillingDashboard({
  tenantOptions = [],
  initialMonth = currentKoreaMonth(),
  api: providedApi,
  onToast,
  onDataChanged,
}: BillingDashboardProps) {
  const api = useMemo(() => providedApi ?? createBillingHttpApi('/api/billing'), [providedApi])
  const [month, setMonth] = useState(initialMonth)
  const [selectedTenantId, setSelectedTenantId] = useState('')
  const [payload, setPayload] = useState<BillingDashboardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [finalizing, setFinalizing] = useState(false)

  const resolvedTenantOptions = useMemo(() => {
    const known = new Map(tenantOptions.map((item) => [item.id, item]))
    for (const id of payload?.tenantIds ?? []) if (!known.has(id)) known.set(id, { id, name: id })
    return [...known.values()]
  }, [payload?.tenantIds, tenantOptions])

  const refresh = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const next = await api.loadDashboard({ month, tenantId: selectedTenantId || undefined })
      setPayload(next)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '비용·포인트 현황을 불러오지 못했습니다.') }
    finally { setLoading(false) }
  }, [api, month, selectedTenantId])

  useEffect(() => { void refresh() }, [refresh])

  const notifyError = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : '저장하지 못했습니다.'
    setError(message); onToast?.(message)
  }
  const saved = async (message: string) => {
    onToast?.(message); onDataChanged?.(); await refresh()
  }
  const finalize = async () => {
    const target = selectedTenantId
    if (!target) { notifyError(new Error('월 청구를 확정할 고객사를 선택해 주세요.')); return }
    setFinalizing(true)
    try { const result = await api.finalizeMonth({ tenantId: target, month }); await saved(result.created ? '월 청구 스냅샷을 확정했습니다.' : '이미 확정된 월 청구 스냅샷입니다.') }
    catch (reason) { notifyError(reason) } finally { setFinalizing(false) }
  }

  const configurationStatus = payload ? statusPresentation(payload.cards.configurationStatus) : statusPresentation('unconfigured')
  const canFinalize = Boolean(selectedTenantId) && month < currentKoreaMonth()

  return <div className="billing-root">
    <header className="billing-head">
      <div><span className="billing-section-kicker">COST & POINTS</span><h1>비용·포인트 관리</h1><p>AI 사용량과 저장공간을 고객사별로 정산하고 요율·한도를 관리합니다.</p></div>
      <div className="billing-head__controls">
        <label><span>고객사</span><select value={selectedTenantId} onChange={(event) => setSelectedTenantId(event.target.value)}><option value="">전체 고객사</option>{resolvedTenantOptions.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></label>
        <label><span>조회 월</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        <button type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} />새로고침</button>
        <button type="button" className="billing-primary" onClick={() => void finalize()} disabled={!canFinalize || finalizing}><CalendarCheck2 size={16} />{finalizing ? '확정 중' : '선택 월 확정'}</button>
      </div>
    </header>

    {error && <section className="billing-notice billing-notice--error" role="alert"><TriangleAlert size={18} /><span>{error}</span><button type="button" onClick={() => void refresh()}>다시 시도</button></section>}
    {loading && !payload && <section className="billing-loading" aria-live="polite"><RefreshCw size={20} /><span>비용·포인트 현황을 불러오는 중입니다.</span></section>}

    {payload && <>
      <section className="billing-metrics" aria-label="이번 달 비용 핵심 지표">
        <MetricCard icon={Coins} label="이번 달 매출" value={formatMoney(payload.cards.invoiceTotal, payload.cards.currency)} note="기본료·포인트 초과·저장 초과" tone="info" />
        <MetricCard icon={Bot} label="API 원가" value={formatMoney(payload.cards.apiCost, payload.cards.currency)} note={`${formatNumber(payload.cards.eventCount)}회 사용`} /><MetricCard icon={Activity} label="마진" value={formatMoney(payload.cards.margin, payload.cards.currency)} note="매출 - API 원가" tone={payload.cards.margin < 0 ? 'danger' : 'success'} />
        <MetricCard icon={Gauge} label="사용 포인트" value={formatNumber(payload.cards.pointsUsed)} note={payload.cards.pointLimit === null ? '한도 미설정' : `한도 ${formatNumber(payload.cards.pointLimit)}`} tone={payload.cards.utilizationPercent !== null && payload.cards.utilizationPercent >= 100 ? 'danger' : 'warning'} />
        <MetricCard icon={Database} label="저장공간" value={formatBytes(payload.cards.storageBytes)} note={configurationStatus.label} tone={configurationStatus.tone} />
      </section>

      <UsageGauge payload={payload} tenantName={payload.gauge ? tenantLabel(payload.gauge.tenantId, resolvedTenantOptions) : undefined} />

      <section className="billing-overview-grid">
        <SixMonthTrend series={payload.series} />
        <section className="billing-panel billing-cost-summary">
          <header><div><span className="billing-section-kicker">MONTH SUMMARY</span><h2>비용 구성</h2></div><StatusBadge tone={configurationStatus.tone}>{configurationStatus.label}</StatusBadge></header>
          <dl><div><dt>요금제 기본료</dt><dd>{formatMoney(payload.summary.baseRevenue, payload.summary.currency)}</dd></div><div><dt>포인트 초과금</dt><dd>{formatMoney(payload.summary.pointOverageRevenue, payload.summary.currency)}</dd></div><div><dt>저장공간 초과금</dt><dd>{formatMoney(payload.summary.storageOverageRevenue, payload.summary.currency)}</dd></div><div><dt>매출</dt><dd>{formatMoney(payload.summary.invoiceTotal, payload.summary.currency)}</dd></div><div><dt>API 원가</dt><dd>{formatMoney(payload.summary.apiCost, payload.summary.currency)}</dd></div><div><dt>마진</dt><dd>{formatMoney(payload.summary.margin, payload.summary.currency)}</dd></div></dl>
          <p><Activity size={16} />입력 {formatNumber(payload.summary.inputTokens)} · 출력 {formatNumber(payload.summary.outputTokens)} 토큰</p>
        </section>
      </section>

      <TenantTable rows={payload.details.tenants} options={resolvedTenantOptions} />
      <section className="billing-breakdown-grid">
        <BreakdownTable title="모델별 사용량" rows={payload.details.models} currency={payload.summary.currency} showApiCost />
        <BreakdownTable title="기능별 사용량" rows={payload.details.features} currency={payload.summary.currency} showApiCost />
      </section>
      <SnapshotList snapshots={payload.monthlySnapshots} options={resolvedTenantOptions} />
      <PlatformConfiguration payload={payload} tenantOptions={resolvedTenantOptions} api={api} onSaved={saved} onError={notifyError} />
    </>}
  </div>
}

export default BillingDashboard
