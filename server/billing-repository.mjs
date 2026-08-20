import { randomUUID } from 'node:crypto'

import { BillingServiceError, createMemoryBillingRepository } from './billing-service.mjs'

const clone = (value) => value === undefined ? undefined : structuredClone(value)
const json = (value) => JSON.stringify(value ?? {})
const number = (value) => Number(value ?? 0)
const boolean = (value) => value === true || value === 1 || value === '1' || value === 't'
const parsed = (value, fallback = {}) => {
  if (value && typeof value === 'object') return clone(value)
  try { return JSON.parse(value ?? JSON.stringify(fallback)) } catch { return clone(fallback) }
}
const isoValue = (value) => value instanceof Date ? value.toISOString() : value == null ? value : String(value)
const dateValue = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

function rateFromRow(row) {
  return {
    model: row.model_key,
    displayName: row.display_name,
    currency: row.currency,
    inputCostPerMillion: number(row.input_cost_per_million),
    outputCostPerMillion: number(row.output_cost_per_million),
    inputPointsPerMillion: number(row.input_points_per_million),
    outputPointsPerMillion: number(row.output_points_per_million),
    confirmed: boolean(row.confirmed),
    updatedBy: row.updated_by,
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
  }
}

function planFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    monthlyPrice: number(row.monthly_price),
    includedPoints: number(row.included_points),
    includedStorageBytes: number(row.included_storage_bytes),
    storageOveragePerGb: number(row.storage_overage_per_gb),
    pointOveragePrice: number(row.point_overage_price),
    warningThresholdPercent: number(row.warning_threshold_percent),
    confirmed: boolean(row.confirmed),
    active: boolean(row.active),
    updatedBy: row.updated_by,
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
  }
}

function assignmentFromRow(row) {
  return {
    tenantId: row.tenant_id,
    planId: row.plan_id,
    pointLimitOverride: row.point_limit_override === null || row.point_limit_override === undefined ? null : number(row.point_limit_override),
    limitAction: row.limit_action,
    assignedBy: row.assigned_by,
    assignedAt: isoValue(row.assigned_at),
  }
}

function reservationFromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    feature: row.feature,
    model: row.model_key,
    estimatedInputTokens: number(row.estimated_input_tokens),
    estimatedOutputTokens: number(row.estimated_output_tokens),
    estimatedPoints: number(row.estimated_points),
    estimatedCost: number(row.estimated_cost),
    currency: row.currency,
    billingMonth: row.billing_month,
    occurredAt: isoValue(row.occurred_at),
    rateConfirmed: boolean(row.rate_confirmed),
    rateSnapshot: parsed(row.rate_snapshot),
    limitDecision: parsed(row.limit_decision),
    status: row.status,
    reconciliationPending: boolean(row.reconciliation_pending),
    usageEventId: row.usage_event_id ?? undefined,
    reservedBy: row.reserved_by,
    reservedAt: isoValue(row.reserved_at),
    expiresAt: isoValue(row.expires_at),
    committedAt: row.committed_at ? isoValue(row.committed_at) : undefined,
    releasedAt: row.released_at ? isoValue(row.released_at) : undefined,
    releasedBy: row.released_by ?? undefined,
  }
}

function eventFromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    feature: row.feature,
    model: row.model_key,
    inputTokens: number(row.input_tokens),
    outputTokens: number(row.output_tokens),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : number(row.duration_ms),
    occurredAt: isoValue(row.occurred_at),
    billingMonth: row.billing_month,
    currency: row.currency,
    inputCost: number(row.input_cost),
    outputCost: number(row.output_cost),
    totalCost: number(row.total_cost),
    inputPoints: number(row.input_points),
    outputPoints: number(row.output_points),
    totalPoints: number(row.total_points),
    rateConfirmed: boolean(row.rate_confirmed),
    rateSnapshot: parsed(row.rate_snapshot),
    limitDecision: parsed(row.limit_decision),
    metadata: parsed(row.metadata),
    recordedBy: row.recorded_by,
    recordedAt: isoValue(row.recorded_at),
    reservationId: row.reservation_id ?? null,
  }
}

function reconciliationFromRow(row) {
  return {
    id: row.id,
    usageEventId: row.usage_event_id,
    reservationId: row.reservation_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    feature: row.feature,
    model: row.model_key,
    inputTokens: number(row.input_tokens),
    outputTokens: number(row.output_tokens),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : number(row.duration_ms),
    occurredAt: isoValue(row.occurred_at),
    metadata: parsed(row.metadata),
    status: row.status,
    attempts: number(row.attempts),
    lastError: row.last_error ?? '',
    nextAttemptAt: row.next_attempt_at ? isoValue(row.next_attempt_at) : null,
    recordedBy: row.recorded_by,
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
    resolvedAt: row.resolved_at ? isoValue(row.resolved_at) : undefined,
  }
}

function storageFromRow(row) {
  return {
    id: `${row.tenant_id}:${row.snapshot_date}`,
    tenantId: row.tenant_id,
    snapshotDate: dateValue(row.snapshot_date),
    bytes: number(row.bytes),
    objectCount: number(row.object_count),
    measuredAt: isoValue(row.measured_at),
    recordedBy: row.recorded_by,
    recordedAt: isoValue(row.recorded_at),
  }
}

function monthlyFromRow(row) {
  return {
    id: `${row.tenant_id}:${row.billing_month}`,
    tenantId: row.tenant_id,
    billingMonth: row.billing_month,
    summary: parsed(row.summary),
    details: parsed(row.details),
    assignmentSnapshot: row.assignment_snapshot ? parsed(row.assignment_snapshot) : null,
    planSnapshot: row.plan_snapshot ? parsed(row.plan_snapshot) : null,
    immutable: true,
    finalizedBy: row.finalized_by,
    finalizedAt: isoValue(row.finalized_at),
  }
}

function postgresAccess(queryable) {
  const rows = async (sql, parameters = []) => (await queryable.query(sql, parameters)).rows
  const one = async (sql, parameters = []) => (await rows(sql, parameters))[0] ?? null
  return {
    async getModelRate(model) { const row = await one('SELECT * FROM billing_model_rates WHERE model_key = $1', [model]); return row ? rateFromRow(row) : null },
    async listModelRates() { return (await rows('SELECT * FROM billing_model_rates ORDER BY model_key')).map(rateFromRow) },
    async upsertModelRate(rate) {
      await queryable.query(`
        INSERT INTO billing_model_rates (model_key, display_name, currency, input_cost_per_million, output_cost_per_million,
          input_points_per_million, output_points_per_million, confirmed, updated_by, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz,NOW()),$11)
        ON CONFLICT (model_key) DO UPDATE SET display_name=EXCLUDED.display_name, currency=EXCLUDED.currency,
          input_cost_per_million=EXCLUDED.input_cost_per_million, output_cost_per_million=EXCLUDED.output_cost_per_million,
          input_points_per_million=EXCLUDED.input_points_per_million, output_points_per_million=EXCLUDED.output_points_per_million,
          confirmed=EXCLUDED.confirmed, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at
      `, [rate.model, rate.displayName, rate.currency, rate.inputCostPerMillion, rate.outputCostPerMillion,
        rate.inputPointsPerMillion, rate.outputPointsPerMillion, rate.confirmed, rate.updatedBy, rate.createdAt ?? null, rate.updatedAt])
      return clone(rate)
    },
    async getPlan(id) { const row = await one('SELECT * FROM billing_plans WHERE id = $1', [id]); return row ? planFromRow(row) : null },
    async listPlans() { return (await rows('SELECT * FROM billing_plans ORDER BY id')).map(planFromRow) },
    async upsertPlan(plan) {
      await queryable.query(`
        INSERT INTO billing_plans (id,name,currency,monthly_price,included_points,included_storage_bytes,storage_overage_per_gb,
          point_overage_price,warning_threshold_percent,confirmed,active,updated_by,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,currency=EXCLUDED.currency,monthly_price=EXCLUDED.monthly_price,
          included_points=EXCLUDED.included_points,included_storage_bytes=EXCLUDED.included_storage_bytes,
          storage_overage_per_gb=EXCLUDED.storage_overage_per_gb,point_overage_price=EXCLUDED.point_overage_price,
          warning_threshold_percent=EXCLUDED.warning_threshold_percent,
          confirmed=EXCLUDED.confirmed,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at
      `, [plan.id, plan.name, plan.currency, plan.monthlyPrice, plan.includedPoints, plan.includedStorageBytes,
        plan.storageOveragePerGb, plan.pointOveragePrice, plan.warningThresholdPercent, plan.confirmed, plan.active, plan.updatedBy, plan.createdAt, plan.updatedAt])
      return clone(plan)
    },
    async getAssignment(tenantId) { const row = await one('SELECT * FROM billing_tenant_assignments WHERE tenant_id = $1', [tenantId]); return row ? assignmentFromRow(row) : null },
    async listAssignments() { return (await rows('SELECT * FROM billing_tenant_assignments ORDER BY tenant_id')).map(assignmentFromRow) },
    async upsertAssignment(item) {
      await queryable.query(`
        INSERT INTO billing_tenant_assignments (tenant_id,plan_id,point_limit_override,limit_action,assigned_by,assigned_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT (tenant_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,point_limit_override=EXCLUDED.point_limit_override,
          limit_action=EXCLUDED.limit_action,assigned_by=EXCLUDED.assigned_by,assigned_at=EXCLUDED.assigned_at,updated_at=EXCLUDED.updated_at
      `, [item.tenantId, item.planId, item.pointLimitOverride, item.limitAction, item.assignedBy, item.assignedAt])
      return clone(item)
    },
    async getUsageReservation(id) { const row = await one('SELECT * FROM billing_usage_reservations WHERE id = $1', [id]); return row ? reservationFromRow(row) : null },
    async insertUsageReservation(item) {
      await queryable.query(`
        INSERT INTO billing_usage_reservations (id,tenant_id,user_id,feature,model_key,estimated_input_tokens,estimated_output_tokens,
          estimated_points,estimated_cost,currency,billing_month,occurred_at,rate_confirmed,rate_snapshot,limit_decision,status,
          usage_event_id,reserved_by,reserved_at,expires_at,committed_at,released_at,released_by,reconciliation_pending)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      `, [item.id,item.tenantId,item.userId,item.feature,item.model,item.estimatedInputTokens,item.estimatedOutputTokens,
        item.estimatedPoints,item.estimatedCost,item.currency,item.billingMonth,item.occurredAt,item.rateConfirmed,json(item.rateSnapshot),
        json(item.limitDecision),item.status,item.usageEventId ?? null,item.reservedBy,item.reservedAt,item.expiresAt,item.committedAt ?? null,
        item.releasedAt ?? null,item.releasedBy ?? null,item.reconciliationPending ?? false])
      return clone(item)
    },
    async updateUsageReservation(item) {
      await queryable.query(`UPDATE billing_usage_reservations SET status=$2,usage_event_id=$3,committed_at=$4,released_at=$5,released_by=$6,
        reconciliation_pending=$7 WHERE id=$1`,
        [item.id,item.status,item.usageEventId ?? null,item.committedAt ?? null,item.releasedAt ?? null,item.releasedBy ?? null,item.reconciliationPending ?? false])
      return clone(item)
    },
    async listActiveUsageReservations({ tenantId, startAt, endAt, now } = {}) {
      const result = await rows(`SELECT * FROM billing_usage_reservations WHERE status='pending' AND (reconciliation_pending=TRUE OR expires_at > $1)
        AND ($2::text IS NULL OR tenant_id=$2) AND ($3::timestamptz IS NULL OR occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR occurred_at < $4) ORDER BY reserved_at`, [now ?? new Date().toISOString(), tenantId ?? null, startAt ?? null, endAt ?? null])
      return result.map(reservationFromRow)
    },
    async getUsageEvent(id) { const row = await one('SELECT * FROM billing_usage_events WHERE id = $1', [id]); return row ? eventFromRow(row) : null },
    async insertUsageEvent(item) {
      await queryable.query(`
        INSERT INTO billing_usage_events (id,tenant_id,user_id,feature,model_key,input_tokens,output_tokens,duration_ms,occurred_at,
          billing_month,currency,input_cost,output_cost,total_cost,input_points,output_points,total_points,rate_confirmed,
          rate_snapshot,limit_decision,metadata,recorded_by,recorded_at,reservation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21::jsonb,$22,$23,$24)
      `, [item.id,item.tenantId,item.userId,item.feature,item.model,item.inputTokens,item.outputTokens,item.durationMs,item.occurredAt,
        item.billingMonth,item.currency,item.inputCost,item.outputCost,item.totalCost,item.inputPoints,item.outputPoints,item.totalPoints,
        item.rateConfirmed,json(item.rateSnapshot),json(item.limitDecision),json(item.metadata),item.recordedBy,item.recordedAt,item.reservationId])
      return clone(item)
    },
    async listUsageEvents({ tenantId, tenantIds, startAt, endAt } = {}) {
      const conditions = []
      const parameters = []
      const add = (sql, value) => { parameters.push(value); conditions.push(sql.replace('?', `$${parameters.length}`)) }
      if (tenantId) add('tenant_id = ?', tenantId)
      if (tenantIds) { parameters.push(tenantIds); conditions.push(`tenant_id = ANY($${parameters.length}::text[])`) }
      if (startAt) add('occurred_at >= ?', startAt)
      if (endAt) add('occurred_at < ?', endAt)
      return (await rows(`SELECT * FROM billing_usage_events${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY occurred_at`, parameters)).map(eventFromRow)
    },
    async getReconciliation(id) { const row = await one('SELECT * FROM billing_reconciliation_queue WHERE id=$1', [id]); return row ? reconciliationFromRow(row) : null },
    async insertReconciliation(item) {
      await queryable.query(`INSERT INTO billing_reconciliation_queue (id,usage_event_id,reservation_id,tenant_id,user_id,feature,model_key,
        input_tokens,output_tokens,duration_ms,occurred_at,metadata,status,attempts,last_error,next_attempt_at,recorded_by,created_at,updated_at,resolved_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [item.id,item.usageEventId,item.reservationId,item.tenantId,item.userId,item.feature,item.model,item.inputTokens,item.outputTokens,
        item.durationMs,item.occurredAt,json(item.metadata),item.status,item.attempts,item.lastError,item.nextAttemptAt,item.recordedBy,
        item.createdAt,item.updatedAt,item.resolvedAt ?? null])
      return clone(item)
    },
    async updateReconciliation(item) {
      await queryable.query(`UPDATE billing_reconciliation_queue SET status=$2,attempts=$3,last_error=$4,next_attempt_at=$5,
        updated_at=$6,resolved_at=$7 WHERE id=$1`, [item.id,item.status,item.attempts,item.lastError,item.nextAttemptAt,
        item.updatedAt,item.resolvedAt ?? null])
      return clone(item)
    },
    async listPendingReconciliations({ tenantId, limit = 100, now } = {}) {
      const result = await rows(`SELECT * FROM billing_reconciliation_queue WHERE status='pending'
        AND ($1::text IS NULL OR tenant_id=$1) AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
        ORDER BY created_at LIMIT $3`, [tenantId ?? null,now ?? new Date().toISOString(),limit])
      return result.map(reconciliationFromRow)
    },
    async getStorageSnapshot(tenantId, date) { const row = await one('SELECT * FROM billing_storage_daily_snapshots WHERE tenant_id=$1 AND snapshot_date=$2', [tenantId,date]); return row ? storageFromRow(row) : null },
    async insertStorageSnapshot(item) {
      await queryable.query(`INSERT INTO billing_storage_daily_snapshots (tenant_id,snapshot_date,bytes,object_count,measured_at,recorded_by,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [item.tenantId,item.snapshotDate,item.bytes,item.objectCount,item.measuredAt,item.recordedBy,item.recordedAt])
      return clone(item)
    },
    async listStorageSnapshots({ tenantId, startDate, endDate } = {}) {
      const result = await rows(`SELECT * FROM billing_storage_daily_snapshots WHERE ($1::text IS NULL OR tenant_id=$1)
        AND ($2::date IS NULL OR snapshot_date >= $2) AND ($3::date IS NULL OR snapshot_date < $3) ORDER BY snapshot_date`,
      [tenantId ?? null,startDate ?? null,endDate ?? null])
      return result.map(storageFromRow)
    },
    async getMonthlySnapshot(tenantId, month) { const row = await one('SELECT * FROM billing_monthly_snapshots WHERE tenant_id=$1 AND billing_month=$2', [tenantId,month]); return row ? monthlyFromRow(row) : null },
    async insertMonthlySnapshot(item) {
      await queryable.query(`INSERT INTO billing_monthly_snapshots (tenant_id,billing_month,currency,total_cost,revenue,api_cost,margin,
        point_overage_revenue,storage_overage_revenue,points_used,storage_bytes,summary,details,assignment_snapshot,plan_snapshot,finalized_by,finalized_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17)`,
      [item.tenantId,item.billingMonth,item.summary.currency,item.summary.invoiceTotal,item.summary.revenue,item.summary.apiCost,item.summary.margin,
        item.summary.pointOverageRevenue,item.summary.storageOverageRevenue,item.summary.pointsUsed,item.summary.storageBytes,
        json(item.summary),json(item.details),item.assignmentSnapshot ? json(item.assignmentSnapshot) : null,item.planSnapshot ? json(item.planSnapshot) : null,
        item.finalizedBy,item.finalizedAt])
      return clone(item)
    },
    async listMonthlySnapshots({ tenantId, tenantIds } = {}) {
      const conditions = []
      const parameters = []
      if (tenantId) { parameters.push(tenantId); conditions.push(`tenant_id=$${parameters.length}`) }
      if (tenantIds) { parameters.push(tenantIds); conditions.push(`tenant_id=ANY($${parameters.length}::text[])`) }
      return (await rows(`SELECT * FROM billing_monthly_snapshots${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY billing_month DESC`, parameters)).map(monthlyFromRow)
    },
    async listKnownTenantIds() {
      const result = await rows(`SELECT tenant_id FROM billing_tenant_assignments UNION SELECT tenant_id FROM billing_usage_events
        UNION SELECT tenant_id FROM billing_usage_reservations UNION SELECT tenant_id FROM billing_reconciliation_queue
        UNION SELECT tenant_id FROM billing_storage_daily_snapshots UNION SELECT tenant_id FROM billing_monthly_snapshots ORDER BY tenant_id`)
      return result.map((row) => row.tenant_id)
    },
  }
}

export function createPostgresBillingRepository(pool, { maxRetries = 3 } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new BillingServiceError('BILLING_POSTGRES_REQUIRED', 'Postgres pool이 필요합니다.', 500)
  }
  const repository = postgresAccess(pool)
  return {
    ...repository,
    async transaction(work) {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
          const result = await work(postgresAccess(client))
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (!['40001', '40P01'].includes(error?.code) || attempt === maxRetries) throw error
        } finally { client.release() }
      }
      throw new BillingServiceError('BILLING_TRANSACTION_RETRY_EXHAUSTED', '비용 저장 트랜잭션 충돌을 복구하지 못했습니다.', 503)
    },
  }
}

const transactionOnly = async () => {
  throw new BillingServiceError('BILLING_TRANSACTION_REQUIRED', 'D1 billing 변경은 repository.transaction 안에서만 수행해야 합니다.', 500)
}

function d1Statement(database, sql, parameters = []) {
  const statement = database.prepare(sql)
  return parameters.length ? statement.bind(...parameters) : statement
}

async function d1Rows(database, sql, parameters = []) {
  const result = await d1Statement(database, sql, parameters).all()
  return result?.results ?? []
}

async function d1One(database, sql, parameters = []) {
  const rows = await d1Rows(database, sql, parameters)
  return rows[0] ?? null
}

function d1ReadAccess(database) {
  return {
    async getModelRate(model) { const row = await d1One(database, 'SELECT * FROM billing_model_rates WHERE model_key=?', [model]); return row ? rateFromRow(row) : null },
    async listModelRates() { return (await d1Rows(database, 'SELECT * FROM billing_model_rates ORDER BY model_key')).map(rateFromRow) },
    upsertModelRate: transactionOnly,
    async getPlan(id) { const row = await d1One(database, 'SELECT * FROM billing_plans WHERE id=?', [id]); return row ? planFromRow(row) : null },
    async listPlans() { return (await d1Rows(database, 'SELECT * FROM billing_plans ORDER BY id')).map(planFromRow) },
    upsertPlan: transactionOnly,
    async getAssignment(tenantId) { const row = await d1One(database, 'SELECT * FROM billing_tenant_assignments WHERE tenant_id=?', [tenantId]); return row ? assignmentFromRow(row) : null },
    async listAssignments() { return (await d1Rows(database, 'SELECT * FROM billing_tenant_assignments ORDER BY tenant_id')).map(assignmentFromRow) },
    upsertAssignment: transactionOnly,
    async getUsageReservation(id) { const row = await d1One(database, 'SELECT * FROM billing_usage_reservations WHERE id=?', [id]); return row ? reservationFromRow(row) : null },
    insertUsageReservation: transactionOnly,
    updateUsageReservation: transactionOnly,
    async listActiveUsageReservations({ tenantId, startAt, endAt, now } = {}) {
      const conditions = ["status='pending'", '(reconciliation_pending=1 OR expires_at > ?)']
      const parameters = [now ?? new Date().toISOString()]
      if (tenantId) { conditions.push('tenant_id=?'); parameters.push(tenantId) }
      if (startAt) { conditions.push('occurred_at>=?'); parameters.push(startAt) }
      if (endAt) { conditions.push('occurred_at<?'); parameters.push(endAt) }
      return (await d1Rows(database, `SELECT * FROM billing_usage_reservations WHERE ${conditions.join(' AND ')} ORDER BY reserved_at`, parameters)).map(reservationFromRow)
    },
    async getUsageEvent(id) { const row = await d1One(database, 'SELECT * FROM billing_usage_events WHERE id=?', [id]); return row ? eventFromRow(row) : null },
    insertUsageEvent: transactionOnly,
    async listUsageEvents({ tenantId, tenantIds, startAt, endAt } = {}) {
      const conditions = []
      const parameters = []
      if (tenantId) { conditions.push('tenant_id=?'); parameters.push(tenantId) }
      if (tenantIds) {
        if (!tenantIds.length) return []
        conditions.push(`tenant_id IN (${tenantIds.map(() => '?').join(',')})`); parameters.push(...tenantIds)
      }
      if (startAt) { conditions.push('occurred_at>=?'); parameters.push(startAt) }
      if (endAt) { conditions.push('occurred_at<?'); parameters.push(endAt) }
      return (await d1Rows(database, `SELECT * FROM billing_usage_events${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY occurred_at`, parameters)).map(eventFromRow)
    },
    async getReconciliation(id) { const row = await d1One(database, 'SELECT * FROM billing_reconciliation_queue WHERE id=?', [id]); return row ? reconciliationFromRow(row) : null },
    insertReconciliation: transactionOnly,
    updateReconciliation: transactionOnly,
    async listPendingReconciliations({ tenantId, limit = 100, now } = {}) {
      const conditions = ["status='pending'", '(next_attempt_at IS NULL OR next_attempt_at<=?)']
      const parameters = [now ?? new Date().toISOString()]
      if (tenantId) { conditions.push('tenant_id=?'); parameters.push(tenantId) }
      parameters.push(limit)
      return (await d1Rows(database, `SELECT * FROM billing_reconciliation_queue WHERE ${conditions.join(' AND ')} ORDER BY created_at LIMIT ?`, parameters)).map(reconciliationFromRow)
    },
    async getStorageSnapshot(tenantId, date) { const row = await d1One(database, 'SELECT * FROM billing_storage_daily_snapshots WHERE tenant_id=? AND snapshot_date=?', [tenantId,date]); return row ? storageFromRow(row) : null },
    insertStorageSnapshot: transactionOnly,
    async listStorageSnapshots({ tenantId, startDate, endDate } = {}) {
      const conditions = []
      const parameters = []
      if (tenantId) { conditions.push('tenant_id=?'); parameters.push(tenantId) }
      if (startDate) { conditions.push('snapshot_date>=?'); parameters.push(startDate) }
      if (endDate) { conditions.push('snapshot_date<?'); parameters.push(endDate) }
      return (await d1Rows(database, `SELECT * FROM billing_storage_daily_snapshots${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY snapshot_date`, parameters)).map(storageFromRow)
    },
    async getMonthlySnapshot(tenantId, month) { const row = await d1One(database, 'SELECT * FROM billing_monthly_snapshots WHERE tenant_id=? AND billing_month=?', [tenantId,month]); return row ? monthlyFromRow(row) : null },
    insertMonthlySnapshot: transactionOnly,
    async listMonthlySnapshots({ tenantId, tenantIds } = {}) {
      const conditions = []
      const parameters = []
      if (tenantId) { conditions.push('tenant_id=?'); parameters.push(tenantId) }
      if (tenantIds) {
        if (!tenantIds.length) return []
        conditions.push(`tenant_id IN (${tenantIds.map(() => '?').join(',')})`); parameters.push(...tenantIds)
      }
      return (await d1Rows(database, `SELECT * FROM billing_monthly_snapshots${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY billing_month DESC`, parameters)).map(monthlyFromRow)
    },
    async listKnownTenantIds() {
      const rows = await d1Rows(database, `SELECT tenant_id FROM billing_tenant_assignments UNION SELECT tenant_id FROM billing_usage_events
        UNION SELECT tenant_id FROM billing_usage_reservations UNION SELECT tenant_id FROM billing_reconciliation_queue
        UNION SELECT tenant_id FROM billing_storage_daily_snapshots UNION SELECT tenant_id FROM billing_monthly_snapshots ORDER BY tenant_id`)
      return rows.map((row) => row.tenant_id)
    },
  }
}

const D1_STATE_SELECTS = Object.freeze([
  ['meta', "SELECT revision FROM billing_repository_meta WHERE id='billing'"],
  ['modelRates', 'SELECT * FROM billing_model_rates ORDER BY model_key'],
  ['plans', 'SELECT * FROM billing_plans ORDER BY id'],
  ['assignments', 'SELECT * FROM billing_tenant_assignments ORDER BY tenant_id'],
  ['usageReservations', 'SELECT * FROM billing_usage_reservations ORDER BY id'],
  ['usageEvents', 'SELECT * FROM billing_usage_events ORDER BY id'],
  ['reconciliations', 'SELECT * FROM billing_reconciliation_queue ORDER BY id'],
  ['storageSnapshots', 'SELECT * FROM billing_storage_daily_snapshots ORDER BY tenant_id,snapshot_date'],
  ['monthlySnapshots', 'SELECT * FROM billing_monthly_snapshots ORDER BY tenant_id,billing_month'],
])

async function loadD1State(database) {
  const results = await database.batch(D1_STATE_SELECTS.map(([_key, sql]) => d1Statement(database, sql)))
  const rowsFor = (index) => results[index]?.results ?? []
  return {
    revision: number(rowsFor(0)[0]?.revision),
    state: {
      modelRates: rowsFor(1).map(rateFromRow),
      plans: rowsFor(2).map(planFromRow),
      assignments: rowsFor(3).map(assignmentFromRow),
      usageReservations: rowsFor(4).map(reservationFromRow),
      usageEvents: rowsFor(5).map(eventFromRow),
      reconciliations: rowsFor(6).map(reconciliationFromRow),
      storageSnapshots: rowsFor(7).map(storageFromRow),
      monthlySnapshots: rowsFor(8).map(monthlyFromRow),
    },
  }
}

const stateKeys = Object.freeze({
  modelRates: (item) => item.model,
  plans: (item) => item.id,
  assignments: (item) => item.tenantId,
  usageReservations: (item) => item.id,
  usageEvents: (item) => item.id,
  reconciliations: (item) => item.id,
  storageSnapshots: (item) => `${item.tenantId}:${item.snapshotDate}`,
  monthlySnapshots: (item) => `${item.tenantId}:${item.billingMonth}`,
})

function stateChanges(before, after, collection) {
  const keyFor = stateKeys[collection]
  const previous = new Map(before[collection].map((item) => [keyFor(item), item]))
  const next = new Map(after[collection].map((item) => [keyFor(item), item]))
  for (const key of previous.keys()) {
    if (!next.has(key)) throw new BillingServiceError('BILLING_D1_DELETE_FORBIDDEN', 'billing repository는 원장 행 삭제를 허용하지 않습니다.', 409, { collection, key })
  }
  return [...next].filter(([key, item]) => JSON.stringify(previous.get(key)) !== JSON.stringify(item)).map(([, item]) => item)
}

function guardedD1Statement(database, sql, values, revision, owner) {
  return d1Statement(database, sql, [...values, revision, owner])
}

function d1MutationStatements(database, before, after, revision, owner) {
  const guard = "EXISTS (SELECT 1 FROM billing_repository_meta WHERE id='billing' AND revision=? AND write_owner=?)"
  const statements = []
  for (const item of stateChanges(before, after, 'modelRates')) statements.push(guardedD1Statement(database, `
    INSERT INTO billing_model_rates (model_key,display_name,currency,input_cost_per_million,output_cost_per_million,input_points_per_million,
      output_points_per_million,confirmed,updated_by,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
    ON CONFLICT(model_key) DO UPDATE SET display_name=excluded.display_name,currency=excluded.currency,
      input_cost_per_million=excluded.input_cost_per_million,output_cost_per_million=excluded.output_cost_per_million,
      input_points_per_million=excluded.input_points_per_million,output_points_per_million=excluded.output_points_per_million,
      confirmed=excluded.confirmed,updated_by=excluded.updated_by,updated_at=excluded.updated_at
  `, [item.model,item.displayName,item.currency,item.inputCostPerMillion,item.outputCostPerMillion,item.inputPointsPerMillion,
    item.outputPointsPerMillion,item.confirmed ? 1 : 0,item.updatedBy,item.createdAt ?? item.updatedAt,item.updatedAt], revision, owner))
  for (const item of stateChanges(before, after, 'plans')) statements.push(guardedD1Statement(database, `
    INSERT INTO billing_plans (id,name,currency,monthly_price,included_points,included_storage_bytes,storage_overage_per_gb,point_overage_price,
      warning_threshold_percent,confirmed,active,updated_by,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,currency=excluded.currency,monthly_price=excluded.monthly_price,
      included_points=excluded.included_points,included_storage_bytes=excluded.included_storage_bytes,
      storage_overage_per_gb=excluded.storage_overage_per_gb,point_overage_price=excluded.point_overage_price,
      warning_threshold_percent=excluded.warning_threshold_percent,
      confirmed=excluded.confirmed,active=excluded.active,updated_by=excluded.updated_by,updated_at=excluded.updated_at
  `, [item.id,item.name,item.currency,item.monthlyPrice,item.includedPoints,item.includedStorageBytes,item.storageOveragePerGb,
    item.pointOveragePrice,item.warningThresholdPercent,item.confirmed ? 1 : 0,item.active ? 1 : 0,item.updatedBy,item.createdAt,item.updatedAt], revision, owner))
  for (const item of stateChanges(before, after, 'assignments')) statements.push(guardedD1Statement(database, `
    INSERT INTO billing_tenant_assignments (tenant_id,plan_id,point_limit_override,limit_action,assigned_by,assigned_at,updated_at)
    SELECT ?,?,?,?,?,?,? WHERE ${guard}
    ON CONFLICT(tenant_id) DO UPDATE SET plan_id=excluded.plan_id,point_limit_override=excluded.point_limit_override,
      limit_action=excluded.limit_action,assigned_by=excluded.assigned_by,assigned_at=excluded.assigned_at,updated_at=excluded.updated_at
  `, [item.tenantId,item.planId,item.pointLimitOverride,item.limitAction,item.assignedBy,item.assignedAt,item.assignedAt], revision, owner))
  for (const item of stateChanges(before, after, 'usageEvents')) statements.push(guardedD1Statement(database, `
    INSERT INTO billing_usage_events (id,tenant_id,user_id,feature,model_key,input_tokens,output_tokens,duration_ms,occurred_at,billing_month,currency,
      input_cost,output_cost,total_cost,input_points,output_points,total_points,rate_confirmed,rate_snapshot,limit_decision,metadata,recorded_by,recorded_at,reservation_id)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
  `, [item.id,item.tenantId,item.userId,item.feature,item.model,item.inputTokens,item.outputTokens,item.durationMs,item.occurredAt,item.billingMonth,
    item.currency,item.inputCost,item.outputCost,item.totalCost,item.inputPoints,item.outputPoints,item.totalPoints,item.rateConfirmed ? 1 : 0,
    json(item.rateSnapshot),json(item.limitDecision),json(item.metadata),item.recordedBy,item.recordedAt,item.reservationId], revision, owner))
  for (const item of stateChanges(before, after, 'usageReservations')) statements.push(guardedD1Statement(database, `
    INSERT INTO billing_usage_reservations (id,tenant_id,user_id,feature,model_key,estimated_input_tokens,estimated_output_tokens,estimated_points,
      estimated_cost,currency,billing_month,occurred_at,rate_confirmed,rate_snapshot,limit_decision,status,usage_event_id,reserved_by,reserved_at,
      expires_at,committed_at,released_at,released_by,reconciliation_pending)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,usage_event_id=excluded.usage_event_id,committed_at=excluded.committed_at,
      released_at=excluded.released_at,released_by=excluded.released_by,reconciliation_pending=excluded.reconciliation_pending
  `, [item.id,item.tenantId,item.userId,item.feature,item.model,item.estimatedInputTokens,item.estimatedOutputTokens,item.estimatedPoints,
    item.estimatedCost,item.currency,item.billingMonth,item.occurredAt,item.rateConfirmed ? 1 : 0,json(item.rateSnapshot),json(item.limitDecision),
    item.status,item.usageEventId ?? null,item.reservedBy,item.reservedAt,item.expiresAt,item.committedAt ?? null,item.releasedAt ?? null,
    item.releasedBy ?? null,item.reconciliationPending ? 1 : 0], revision, owner))
  for (const item of stateChanges(before, after, 'reconciliations')) statements.push(guardedD1Statement(database, `
    INSERT INTO billing_reconciliation_queue (id,usage_event_id,reservation_id,tenant_id,user_id,feature,model_key,input_tokens,output_tokens,
      duration_ms,occurred_at,metadata,status,attempts,last_error,next_attempt_at,recorded_by,created_at,updated_at,resolved_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,last_error=excluded.last_error,
      next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at,resolved_at=excluded.resolved_at
  `, [item.id,item.usageEventId,item.reservationId,item.tenantId,item.userId,item.feature,item.model,item.inputTokens,item.outputTokens,
    item.durationMs,item.occurredAt,json(item.metadata),item.status,item.attempts,item.lastError,item.nextAttemptAt,item.recordedBy,
    item.createdAt,item.updatedAt,item.resolvedAt ?? null], revision, owner))
  for (const item of stateChanges(before, after, 'storageSnapshots')) statements.push(guardedD1Statement(database, `
    INSERT INTO billing_storage_daily_snapshots (tenant_id,snapshot_date,bytes,object_count,measured_at,recorded_by,recorded_at)
    SELECT ?,?,?,?,?,?,? WHERE ${guard}
  `, [item.tenantId,item.snapshotDate,item.bytes,item.objectCount,item.measuredAt,item.recordedBy,item.recordedAt], revision, owner))
  for (const item of stateChanges(before, after, 'monthlySnapshots')) statements.push(guardedD1Statement(database, `
    INSERT INTO billing_monthly_snapshots (tenant_id,billing_month,currency,total_cost,revenue,api_cost,margin,point_overage_revenue,
      storage_overage_revenue,points_used,storage_bytes,summary,details,assignment_snapshot,plan_snapshot,finalized_by,finalized_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
  `, [item.tenantId,item.billingMonth,item.summary.currency,item.summary.invoiceTotal,item.summary.revenue,item.summary.apiCost,item.summary.margin,
    item.summary.pointOverageRevenue,item.summary.storageOverageRevenue,item.summary.pointsUsed,item.summary.storageBytes,json(item.summary),
    json(item.details),item.assignmentSnapshot ? json(item.assignmentSnapshot) : null,item.planSnapshot ? json(item.planSnapshot) : null,
    item.finalizedBy,item.finalizedAt], revision, owner))
  return statements
}

export function createD1BillingRepository(database, { maxRetries = 5, ownerFactory = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.batch !== 'function') {
    throw new BillingServiceError('BILLING_D1_REQUIRED', 'Cloudflare D1 binding이 필요합니다.', 500)
  }
  const reads = d1ReadAccess(database)
  return {
    ...reads,
    async transaction(work) {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const session = typeof database.withSession === 'function' ? database.withSession('first-primary') : database
        const loaded = await loadD1State(session)
        const memory = createMemoryBillingRepository(loaded.state)
        const result = await memory.transaction(work)
        const after = memory.inspect()
        const owner = ownerFactory()
        const nextRevision = loaded.revision + 1
        const mutations = d1MutationStatements(session, loaded.state, after, nextRevision, owner)
        if (!mutations.length) return result
        const cas = d1Statement(session, `UPDATE billing_repository_meta SET revision=revision+1,write_owner=?,updated_at=? WHERE id='billing' AND revision=?`,
          [owner,new Date().toISOString(),loaded.revision])
        const batch = await session.batch([cas, ...mutations])
        if (number(batch[0]?.meta?.changes) === 1) return result
      }
      throw new BillingServiceError('BILLING_D1_CAS_CONFLICT', '동시 비용 저장 요청을 안전하게 재시도하지 못했습니다.', 503)
    },
  }
}
