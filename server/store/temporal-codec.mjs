const KOREA_OFFSET = '+09:00'

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))
}

function validTime(value) {
  return /^\d{2}:\d{2}$/.test(String(value ?? ''))
}

export function canonicalIso(value, { date, time } = {}) {
  let source = value
  if (!source && validDate(date)) source = `${date}T${validTime(time) ? time : '00:00'}:00${KOREA_OFFSET}`
  if (validDate(source)) source = `${source}T00:00:00${KOREA_OFFSET}`
  const parsed = new Date(source)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function koreaParts(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)
  const part = (type) => parts.find((candidate) => candidate.type === type)?.value
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

function strip(source, fields) {
  const payload = structuredClone(source)
  for (const field of fields) delete payload[field]
  return payload
}

function addCalendarDays(date, delta) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10)
}

function canonicalWorkDue(value, referenceDate) {
  const source = String(value ?? '').trim()
  const direct = canonicalIso(source)
  if (direct) return direct
  const baseDate = validDate(referenceDate) ? referenceDate : koreaParts(new Date())?.date
  const relative = source.match(/^(어제|오늘|내일|모레)(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (relative && baseDate) {
    const delta = { 어제: -1, 오늘: 0, 내일: 1, 모레: 2 }[relative[1]]
    const date = addCalendarDays(baseDate, delta)
    return canonicalIso(null, { date, time: `${(relative[2] ?? '00').padStart(2, '0')}:${relative[3] ?? '00'}` })
  }
  const monthDay = source.match(/^(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (monthDay && baseDate) {
    const date = `${monthDay[1] ?? baseDate.slice(0, 4)}-${monthDay[2].padStart(2, '0')}-${monthDay[3].padStart(2, '0')}`
    return canonicalIso(null, { date, time: `${(monthDay[4] ?? '00').padStart(2, '0')}:${monthDay[5] ?? '00'}` })
  }
  return null
}

function messengerPayload(source, referenceDate) {
  const payload = structuredClone(source)
  payload.messages = (payload.messages ?? []).map((message) => {
    const next = { ...message }
    const legacyTime = typeof next.time === 'string' ? next.time : null
    const createdAt = canonicalIso(next.createdAt, { date: referenceDate, time: legacyTime })
    delete next.time
    if (createdAt) next.createdAt = createdAt
    return next
  })
  const lastMessageAt = payload.messages.at(-1)?.createdAt ?? null
  delete payload.lastTime
  return { payload, lastMessageAt }
}

export function prepareTemporalRow(key, source, { sourceUpdatedAt, referenceDate } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { payload: source, temporal: {} }
  if (key === 'work-items') {
    const rawDue = typeof source.due === 'string' ? source.due : null
    const dueAt = canonicalWorkDue(source.due, referenceDate)
    const preserveRaw = dueAt && !/^\d{4}-\d{2}-\d{2}T/.test(String(source.due ?? ''))
    return { payload: strip(source, ['due', 'raw_due']), temporal: { rawDue: preserveRaw || !dueAt ? rawDue : null, dueAt } }
  }
  if (key === 'work-rules') {
    const nextRunAt = canonicalIso(null, { date: source.nextRun, time: source.dueTime })
    const lastGeneratedAt = canonicalIso(source.lastGeneratedAt)
    const createdAt = canonicalIso(source.createdAt)
    return {
      payload: strip(source, ['nextRun', 'dueTime', 'lastGeneratedAt', 'createdAt']),
      temporal: {
        nextRunAt,
        rawNextRun: nextRunAt ? null : source.nextRun ?? null,
        lastGeneratedAt,
        rawLastGeneratedAt: lastGeneratedAt ? null : source.lastGeneratedAt ?? null,
        domainCreatedAt: createdAt,
      },
    }
  }
  if (key === 'messenger-conversations') {
    const fallbackDate = referenceDate ?? koreaParts(sourceUpdatedAt ?? new Date().toISOString())?.date
    const prepared = messengerPayload(source, fallbackDate)
    return { payload: prepared.payload, temporal: { lastMessageAt: prepared.lastMessageAt ?? canonicalIso(sourceUpdatedAt) } }
  }
  if (key === 'calendar-events') {
    return {
      payload: strip(source, ['date', 'start', 'end']),
      temporal: {
        startsAt: canonicalIso(null, { date: source.date, time: source.start }),
        endsAt: canonicalIso(null, { date: source.date, time: source.end }),
      },
    }
  }
  if (key === 'daily-journals') {
    const payload = strip(source, ['updatedAt', 'submittedAt'])
    if (Array.isArray(payload.reviews)) {
      payload.reviews = payload.reviews.map((review) => ({ ...review, reviewedAt: canonicalIso(review.reviewedAt) ?? review.reviewedAt }))
    }
    return { payload, temporal: { entityUpdatedAt: canonicalIso(source.updatedAt), submittedAt: canonicalIso(source.submittedAt) } }
  }
  if (key === 'leave-requests') {
    return {
      payload: strip(source, ['createdAt', 'startDate', 'endDate', 'period']),
      temporal: {
        domainCreatedAt: canonicalIso(source.createdAt),
        startsOn: validDate(source.startDate) ? source.startDate : null,
        endsOn: validDate(source.endDate) ? source.endDate : null,
        rawPeriod: source.period ?? null,
      },
    }
  }
  return { payload: structuredClone(source), temporal: {} }
}

export function restoreTemporalRow(key, storedPayload, row) {
  const payload = structuredClone(storedPayload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  if (key === 'work-items') {
    payload.due = row.raw_due ?? row.due_at?.toISOString?.() ?? row.due_at ?? ''
  } else if (key === 'work-rules') {
    const next = row.next_run_at ? koreaParts(row.next_run_at) : null
    payload.nextRun = next?.date ?? row.raw_next_run ?? ''
    payload.dueTime = next?.time ?? '00:00'
    if (row.last_generated_at) payload.lastGeneratedAt = koreaParts(row.last_generated_at)?.date ?? new Date(row.last_generated_at).toISOString()
    else if (row.raw_last_generated_at) payload.lastGeneratedAt = row.raw_last_generated_at
    if (row.domain_created_at) payload.createdAt = new Date(row.domain_created_at).toISOString()
  } else if (key === 'messenger-conversations') {
    payload.messages = (payload.messages ?? []).map((message) => {
      const next = { ...message }
      const parts = next.createdAt ? koreaParts(next.createdAt) : null
      next.time = parts?.time ?? ''
      return next
    })
    payload.lastTime = row.last_message_at ? koreaParts(row.last_message_at)?.time ?? '' : ''
  } else if (key === 'calendar-events') {
    const start = row.starts_at ? koreaParts(row.starts_at) : null
    const end = row.ends_at ? koreaParts(row.ends_at) : null
    payload.date = start?.date ?? ''
    payload.start = start?.time ?? ''
    payload.end = end?.time ?? ''
  } else if (key === 'daily-journals') {
    payload.updatedAt = row.entity_updated_at ? new Date(row.entity_updated_at).toISOString() : ''
    if (row.submitted_at) payload.submittedAt = new Date(row.submitted_at).toISOString()
  } else if (key === 'leave-requests') {
    if (row.domain_created_at) payload.createdAt = new Date(row.domain_created_at).toISOString()
    if (row.starts_on) payload.startDate = String(row.starts_on).slice(0, 10)
    if (row.ends_on) payload.endDate = String(row.ends_on).slice(0, 10)
    if (row.raw_period) payload.period = row.raw_period
    else if (payload.startDate) payload.period = payload.startDate === payload.endDate ? payload.startDate : `${payload.startDate} ~ ${payload.endDate}`
  }
  return payload
}
