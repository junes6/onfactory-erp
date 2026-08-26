const KSTARTUP_ENDPOINT = 'https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01'
const KSTARTUP_PUBLIC_SUMMARY_ENDPOINT = 'https://www.k-startup.go.kr/web/main/mainSection0.do'
const KSTARTUP_OFFICIAL_URL = 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do'
const BIZINFO_ENDPOINT = 'https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do'
const BIZINFO_OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do'
const DEFAULT_TTL_MS = 60 * 60_000
const DEFAULT_STALE_MS = 24 * 60 * 60_000
const DEFAULT_TIMEOUT_MS = 6_000

export const supportProgramOfficialLinks = Object.freeze([
  { source: 'kstartup', label: 'K-Startup 모집중 공고', url: KSTARTUP_OFFICIAL_URL },
  { source: 'bizinfo', label: '기업마당 지원사업 공고', url: BIZINFO_OFFICIAL_URL },
])

const entityMap = new Map([
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&nbsp;', ' '],
])

function cleanText(value, maxLength = 500) {
  const plain = String(value ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (entity) => entityMap.get(entity.toLowerCase()) ?? ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number(code) || 32)))
    .replace(/\s+/g, ' ')
    .trim()
  return plain.slice(0, maxLength)
}

function isoDate(value) {
  const text = cleanText(value, 80)
  const compact = text.match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const dashed = text.match(/(?:^|\D)(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})(?:\D|$)/)
  if (!dashed) return null
  return `${dashed[1]}-${dashed[2].padStart(2, '0')}-${dashed[3].padStart(2, '0')}`
}

function periodDates(value) {
  const text = cleanText(value, 160)
  const matches = [...text.matchAll(/20\d{2}[.\/-]\d{1,2}[.\/-]\d{1,2}|20\d{6}/g)].map((match) => isoDate(match[0])).filter(Boolean)
  return { startsOn: matches[0] ?? null, endsOn: matches[1] ?? matches[0] ?? null, periodRaw: text || null }
}

function officialUrl(value, source) {
  const fallback = source === 'kstartup' ? KSTARTUP_OFFICIAL_URL : BIZINFO_OFFICIAL_URL
  try {
    const url = new URL(String(value ?? ''), fallback)
    if (url.protocol !== 'https:') return fallback
    const host = url.hostname.toLowerCase()
    const allowed = source === 'kstartup'
      ? host === 'k-startup.go.kr' || host.endsWith('.k-startup.go.kr')
      : host === 'bizinfo.go.kr' || host.endsWith('.bizinfo.go.kr')
    return allowed ? url.toString() : fallback
  } catch {
    return fallback
  }
}

function arrayPayload(body) {
  const candidates = [
    body?.data?.data,
    body?.data,
    body?.jsonArray?.item,
    body?.jsonArray,
    body?.items,
    body?.item,
    body?.response?.body?.items?.item,
  ]
  const array = candidates.find(Array.isArray)
  if (array) return array
  const singleton = candidates.find((candidate) => candidate && typeof candidate === 'object')
  return singleton ? [singleton] : []
}

export function normalizeKStartupPrograms(body) {
  return arrayPayload(body).map((row) => {
    const period = periodDates(`${row?.pbanc_rcpt_bgng_dt ?? ''} ~ ${row?.pbanc_rcpt_end_dt ?? ''}`)
    const title = cleanText(row?.biz_pbanc_nm, 180)
    if (!title) return null
    return {
      id: `kstartup:${cleanText(row?.pbanc_sn, 80) || title}`,
      source: 'kstartup',
      sourceLabel: 'K-Startup',
      title,
      agency: cleanText(row?.sprv_inst, 120),
      operator: cleanText(row?.pbanc_ntrp_nm, 120),
      category: cleanText(row?.supt_biz_clsfc, 100),
      target: cleanText(row?.aply_trgt_ctnt ?? row?.aply_trgt, 180),
      region: cleanText(row?.supt_regin, 100),
      summary: cleanText(row?.pbanc_ctnt, 360),
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      periodRaw: period.periodRaw,
      publishedAt: isoDate(row?.pbanc_bgng_dt ?? row?.creat_dt),
      detailUrl: officialUrl(row?.detl_pg_url ?? row?.biz_gdnc_url, 'kstartup'),
      feedMode: 'api',
    }
  }).filter(Boolean)
}

export function normalizeBizinfoPrograms(body) {
  return arrayPayload(body).map((row) => {
    const period = periodDates(row?.reqstBeginEndDe ?? row?.reqstDt)
    const title = cleanText(row?.pblancNm ?? row?.title, 180)
    if (!title) return null
    return {
      id: `bizinfo:${cleanText(row?.pblancId ?? row?.seq, 80) || title}`,
      source: 'bizinfo',
      sourceLabel: '기업마당',
      title,
      agency: cleanText(row?.jrsdInsttNm ?? row?.author, 120),
      operator: cleanText(row?.excInsttNm, 120),
      category: cleanText(row?.pldirSportRealmLclasCodeNm ?? row?.lcategory, 100),
      target: cleanText(row?.trgetNm, 180),
      region: cleanText(row?.hashtags ?? row?.hashTags, 100),
      summary: cleanText(row?.bsnsSumryCn ?? row?.description, 360),
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      periodRaw: period.periodRaw,
      publishedAt: isoDate(row?.creatPnttm ?? row?.pubDate),
      detailUrl: officialUrl(row?.pblancUrl ?? row?.link, 'bizinfo'),
      feedMode: 'api',
    }
  }).filter(Boolean)
}

function seoulDate(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value)
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day + days))
  return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null
}

export function normalizeKStartupHtmlPrograms(html, baseDate = new Date()) {
  const value = String(html ?? '')
  if (!value || value.length > 512_000
    || !/public_box0[12]/i.test(value)
    || /서비스\s*접속\s*(?:대기|불가)|access\s*denied|captcha|비정상적인\s*접근/i.test(value)) return []
  const today = seoulDate(baseDate)
  const programs = []
  const pattern = /<a\s+[^>]*href=["']([^"']*pbancSn=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>\s*(?:<span[^>]*class=["'][^"']*deadline[^"']*["'][^>]*>([\s\S]*?)<\/span>)?/gi
  let match
  while ((match = pattern.exec(value)) !== null && programs.length < 12) {
    const title = cleanText(match[3], 180)
    if (!title) continue
    const deadline = cleanText(match[4], 80)
    const dayCount = deadline.match(/D\s*-\s*(\d{1,3})/i)
    const endsOn = /오늘\s*마감/.test(deadline) ? today : dayCount ? addDays(today, Number(dayCount[1])) : null
    programs.push({
      id: `kstartup:${match[2]}`,
      source: 'kstartup',
      sourceLabel: 'K-Startup',
      title,
      agency: '',
      operator: '',
      category: '',
      target: '',
      region: '',
      summary: 'K-Startup 공식 메인 공고',
      startsOn: null,
      endsOn,
      periodRaw: deadline || '접수기간 확인',
      publishedAt: null,
      detailUrl: officialUrl(match[1], 'kstartup'),
      feedMode: 'public-html',
    })
  }
  return programs
}

export function createMemorySupportProgramCache() {
  const records = new Map()
  return {
    async get(source) { return records.has(source) ? structuredClone(records.get(source)) : null },
    async put(source, record) { records.set(source, structuredClone(record)) },
    async markError(source, errorCode) {
      const current = records.get(source)
      if (current) records.set(source, { ...current, lastErrorCode: errorCode })
    },
  }
}

const sharedMemoryCache = createMemorySupportProgramCache()

class SourceError extends Error {
  constructor(code) { super(code); this.code = code }
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response?.ok) throw new SourceError(`UPSTREAM_${Number(response?.status) || 0}`)
    return await response.json()
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw new SourceError(error?.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
  }
}

async function fetchText(fetchImpl, url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers: { accept: 'text/html,application/xhtml+xml' }, signal: controller.signal })
    if (!response?.ok) throw new SourceError(`UPSTREAM_${Number(response?.status) || 0}`)
    return await response.text()
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw new SourceError(error?.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
  }
}

function mergePrograms(items) {
  const unique = new Map()
  for (const item of items) {
    const key = `${item.title.toLocaleLowerCase('ko-KR')}|${item.endsOn ?? item.periodRaw ?? ''}`
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()].sort((left, right) => {
    if (!left.endsOn && right.endsOn) return 1
    if (left.endsOn && !right.endsOn) return -1
    return String(left.endsOn ?? '').localeCompare(String(right.endsOn ?? '')) || left.title.localeCompare(right.title, 'ko')
  })
}

export function createSupportProgramService(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const cache = options.cache ?? sharedMemoryCache
  const clock = options.clock ?? (() => new Date())
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const keys = {
    kstartup: String(options.kstartupServiceKey ?? '').trim(),
    bizinfo: String(options.bizinfoCertKey ?? '').trim(),
  }
  const bizinfoApproved = options.bizinfoCommercialUseApproved === true
  const inFlight = new Map()

  const configState = (source) => {
    if (source === 'kstartup' && !keys.kstartup) return 'public-fallback'
    if (!keys[source]) return 'unconfigured'
    if (source === 'bizinfo' && !bizinfoApproved) return 'permission-required'
    return 'configured'
  }

  const requestSource = async (source) => {
    if (typeof fetchImpl !== 'function') throw new SourceError('FETCH_UNAVAILABLE')
    if (source === 'kstartup') {
      if (!keys.kstartup) {
        const items = normalizeKStartupHtmlPrograms(await fetchText(fetchImpl, KSTARTUP_PUBLIC_SUMMARY_ENDPOINT, timeoutMs), clock())
        if (items.length === 0) throw new SourceError('UPSTREAM_STRUCTURE_CHANGED')
        return items
      }
      const url = new URL(KSTARTUP_ENDPOINT)
      url.searchParams.set('serviceKey', keys.kstartup)
      url.searchParams.set('page', '1')
      url.searchParams.set('perPage', '100')
      url.searchParams.set('returnType', 'json')
      url.searchParams.set('cond[rcrt_prgs_yn::EQ]', 'Y')
      const body = await fetchJson(fetchImpl, url, timeoutMs)
      const items = normalizeKStartupPrograms(body)
      if (body?.resultCode && String(body.resultCode) !== '00') throw new SourceError('UPSTREAM_AUTH')
      return items
    }
    const url = new URL(BIZINFO_ENDPOINT)
    url.searchParams.set('crtfcKey', keys.bizinfo)
    url.searchParams.set('dataType', 'json')
    url.searchParams.set('searchCnt', '4')
    url.searchParams.set('pageUnit', '100')
    url.searchParams.set('pageIndex', '1')
    const body = await fetchJson(fetchImpl, url, timeoutMs)
    if (cleanText(body?.reqErr, 160)) throw new SourceError('UPSTREAM_AUTH')
    return normalizeBizinfoPrograms(body)
  }

  const loadSource = async (source) => {
    const now = clock().getTime()
    const cached = await cache.get(source)
    const configuration = configState(source)
    if (configuration === 'permission-required' || configuration === 'unconfigured') {
      return { items: [], state: configuration, syncedAt: null }
    }
    const cachedMode = cached?.items?.some((item) => item?.feedMode === 'public-html') ? 'public' : 'live'
    const requestedMode = configuration === 'public-fallback' ? 'public' : 'live'
    const cacheMatches = cachedMode === requestedMode
    if (cacheMatches && cached?.expiresAt > now && Array.isArray(cached.items)) {
      return { items: cached.items, state: cachedMode, syncedAt: cached.fetchedAt }
    }
    if (inFlight.has(source)) return inFlight.get(source)
    const request = (async () => {
      try {
        const items = await requestSource(source)
        const fetchedAt = clock().toISOString()
        await cache.put(source, { items, fetchedAt, expiresAt: Date.parse(fetchedAt) + ttlMs, lastErrorCode: null })
        return { items, state: requestedMode, syncedAt: fetchedAt }
      } catch (error) {
        const code = error instanceof SourceError ? error.code : 'UPSTREAM_UNAVAILABLE'
        await cache.markError?.(source, code)
        if (cacheMatches && cached?.fetchedAt && now - Date.parse(cached.fetchedAt) <= staleMs && Array.isArray(cached.items)) {
          return { items: cached.items, state: 'stale', syncedAt: cached.fetchedAt }
        }
        return { items: [], state: 'error', syncedAt: null }
      } finally {
        inFlight.delete(source)
      }
    })()
    inFlight.set(source, request)
    return request
  }

  return {
    async list({ source = 'all', limit = 4 } = {}) {
      const selected = source === 'all' ? ['kstartup', 'bizinfo'] : [source]
      const results = await Promise.all(selected.map(async (name) => [name, await loadSource(name)]))
      const sources = {
        kstartup: { state: 'not-requested', syncedAt: null },
        bizinfo: { state: 'not-requested', syncedAt: null },
      }
      const items = []
      for (const [name, result] of results) {
        sources[name] = { state: result.state, syncedAt: result.syncedAt }
        items.push(...result.items)
      }
      const safeLimit = Math.min(12, Math.max(1, Number(limit) || 4))
      const merged = mergePrograms(items).slice(0, safeLimit)
      const syncedAt = results.map(([, result]) => result.syncedAt).filter(Boolean).sort().at(-1) ?? null
      return {
        items: merged,
        syncedAt,
        stale: results.some(([, result]) => result.state === 'stale'),
        sources,
        officialLinks: supportProgramOfficialLinks,
      }
    },
  }
}
