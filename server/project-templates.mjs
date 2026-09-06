import { randomBytes } from 'node:crypto'

import { GUEST_ROLE, GUEST_SCOPE_FORBIDDEN, guestWorkItemViolation } from './guest-access.mjs'
import { buildGroupConversation } from './messenger-rooms.mjs'
import { childrenOf, workItemTreeViolation } from './work-item-tree.mjs'
import { HOLIDAY_POLICIES, WORK_RULE_FREQUENCIES, WORK_RULE_MONTHLY_MODES } from './work-rule-schedule.mjs'

/**
 * 프로젝트 템플릿 — "지난번처럼"을 한 번에 세우는 틀.
 *
 * 왜 사람 대신 역할을 저장하는가: 템플릿은 사람보다 오래 산다. 담당자 이름을 굳혀 두면 그 사람이
 * 팀을 옮기거나 퇴사한 뒤에도 계속 불려 나오고, 남의 회사에 템플릿을 보여 줄 수도 없다. 그래서
 * 본문에는 역할 문자열(PM·품질·개발)과 상대 마감일만 두고, 사람은 프로젝트를 만드는 순간에 고른다.
 * 실명·계정 id가 본문에 섞여 들어오면 저장 시점에 TEMPLATE_CONTAINS_PERSON으로 거절한다 —
 * 검사를 테스트에만 두면 화면을 거치지 않는 경로에서 그대로 새기 때문이다.
 *
 * 왜 전용 라우트인가: generic /api/workspace/project-templates 는 403이다. 실체화 한 번이
 * 프로젝트·업무·채널·반복 규칙 네 곳을 동시에 만들기 때문에, "배열 통째로 교체"가 통하면
 * 그 네 곳의 관계가 언제든 어긋날 수 있다. 쓰기는 서버가 규칙을 아는 라우트로만 한다.
 */

export const PROJECT_TEMPLATES_KEY = 'project-templates'
export const TEMPLATE_ORIGINS = Object.freeze(['system', 'custom'])
export const TEMPLATE_INDUSTRIES = Object.freeze(['food_manufacturing', 'it_services'])
/** 템플릿으로 만든 업무의 마감 시각. 상대 '며칠 뒤'만 저장하므로 시각은 한 곳에서 정한다. */
export const WORK_DUE_TIME = '18:00'
export const SYSTEM_TEMPLATE_IDS = Object.freeze({
  it_services: 'PT-SYS-IT-OUTSOURCED-DEV',
  food_manufacturing: 'PT-SYS-FOOD-NEW-PRODUCT',
})
export const SYSTEM_TEMPLATE_ACTOR = Object.freeze({ id: 'system:project-templates-seed', name: '기본 템플릿' })

export const TEMPLATE_LIMITS = Object.freeze({
  perTenant: 100, name: [2, 80], description: 500, roles: 20, roleName: 30,
  tasks: 100, childrenPerTask: 20, totalRows: 500, title: [2, 120], dueOffsetDays: [0, 3650], category: 20,
  checklist: 30, checklistLabel: 120, channels: 20, channelName: 60, channelPurpose: 120,
  documentCategories: 30, documentCategory: 60, rules: 50, ruleTitle: [2, 200], ruleDescription: [2, 2000],
  history: 50, summary: 120,
  key: /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/,
})

const TEMPLATE_FIELDS = [
  'id', 'name', 'description', 'industryType', 'origin', 'version',
  'roles', 'tasks', 'channels', 'documentCategories', 'rules', 'history',
  'sourceProjectId', 'sourceTemplateId', 'createdAt', 'updatedAt',
]
const TASK_FIELDS = ['key', 'title', 'role', 'dueOffsetDays', 'priority', 'category', 'checklist', 'children']
const CHILD_FIELDS = ['key', 'title', 'role', 'dueOffsetDays', 'priority', 'category']
const CHANNEL_FIELDS = ['name', 'purpose']
const RULE_FIELDS = [
  'key', 'title', 'description', 'role', 'frequency', 'interval', 'weekday', 'monthDay', 'monthlyMode',
  'dueTime', 'priority', 'category', 'holidayPolicy', 'checklist', 'startOffsetDays',
]
const HISTORY_FIELDS = ['version', 'at', 'byId', 'byName', 'summary']
const PATCHABLE_FIELDS = ['name', 'description', 'industryType', 'roles', 'tasks', 'channels', 'documentCategories', 'rules']

const DAY_MS = 24 * 60 * 60 * 1_000
const trimText = (value, max) => String(value ?? '').trim().slice(0, max)
const fail = (code, message, path) => ({ error: { code, message, ...(path ? { path } : {}) } })
const invalid = (message, path) => fail('TEMPLATE_INVALID', message, path)
const has = (set, value) => !set || (typeof set.has === 'function' ? set.has(value) : set.includes(value))
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const inRange = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max
const exactFields = (value, fields) => isPlainObject(value) && Object.keys(value).every((key) => fields.includes(key))

/** 상대 날짜 계산. proposal-engine의 같은 함수는 모듈 안쪽이라 여기서 따로 둔다(둘 다 UTC 자정 기준). */
export const addDaysKey = (dateKey, days) => new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

const newTemplateId = () => `PT-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

function validateChecklist(raw, path) {
  if (raw === undefined) return { checklist: undefined }
  if (!Array.isArray(raw) || raw.length > TEMPLATE_LIMITS.checklist) {
    return invalid(`점검 항목은 ${TEMPLATE_LIMITS.checklist}개까지 둘 수 있습니다.`, path)
  }
  const labels = []
  for (let index = 0; index < raw.length; index += 1) {
    const label = trimText(raw[index], TEMPLATE_LIMITS.checklistLabel + 1)
    if (!label || label.length > TEMPLATE_LIMITS.checklistLabel) {
      return invalid(`점검 항목은 1~${TEMPLATE_LIMITS.checklistLabel}자로 적어 주세요.`, `${path}[${index}]`)
    }
    labels.push(label)
  }
  return { checklist: labels }
}

/** 상위·자식 공통 규칙. 자식은 priority·category를 생략하면 상위 값을 물려받는다. */
function validateTaskLike(raw, { path, roles, priorities, inherit = null, fields }) {
  if (!exactFields(raw, fields)) return invalid('업무 항목의 형식을 확인해 주세요.', path)
  const key = String(raw.key ?? '')
  if (!TEMPLATE_LIMITS.key.test(key)) {
    return fail('TEMPLATE_KEY_INVALID', '항목 key는 영문·숫자로 시작하는 24자 이내 영문/숫자/-/_ 조합이어야 합니다.', `${path}.key`)
  }
  const title = trimText(raw.title, TEMPLATE_LIMITS.title[1] + 1)
  if (title.length < TEMPLATE_LIMITS.title[0] || title.length > TEMPLATE_LIMITS.title[1]) {
    return invalid(`업무 제목은 ${TEMPLATE_LIMITS.title[0]}~${TEMPLATE_LIMITS.title[1]}자로 적어 주세요.`, `${path}.title`)
  }
  const role = trimText(raw.role, TEMPLATE_LIMITS.roleName)
  if (!roles.includes(role)) {
    return fail('TEMPLATE_TASK_ROLE_UNKNOWN', '템플릿에 없는 역할입니다. 역할 목록에 먼저 추가해 주세요.', `${path}.role`)
  }
  if (!inRange(raw.dueOffsetDays, TEMPLATE_LIMITS.dueOffsetDays)) {
    return invalid(`마감은 시작일로부터 ${TEMPLATE_LIMITS.dueOffsetDays[1]}일 이내의 정수로 적어 주세요.`, `${path}.dueOffsetDays`)
  }
  const priority = raw.priority === undefined && inherit ? inherit.priority : raw.priority
  if (!has(priorities, priority)) return invalid('중요도 값을 확인해 주세요.', `${path}.priority`)
  const category = raw.category === undefined && inherit ? inherit.category : trimText(raw.category, TEMPLATE_LIMITS.category)
  if (!category) return invalid('업무 분류를 입력해 주세요.', `${path}.category`)
  const checklist = validateChecklist(raw.checklist, `${path}.checklist`)
  if (checklist.error) return checklist
  return {
    task: {
      key, title, role, dueOffsetDays: raw.dueOffsetDays, priority, category,
      ...(checklist.checklist ? { checklist: checklist.checklist } : {}),
    },
  }
}

function validateRule(raw, { path, roles, priorities, frequencies, monthlyModes, holidayPolicies }) {
  if (!exactFields(raw, RULE_FIELDS)) return invalid('반복 규칙의 형식을 확인해 주세요.', path)
  const key = String(raw.key ?? '')
  if (!TEMPLATE_LIMITS.key.test(key)) {
    return fail('TEMPLATE_KEY_INVALID', '항목 key는 영문·숫자로 시작하는 24자 이내 영문/숫자/-/_ 조합이어야 합니다.', `${path}.key`)
  }
  const title = trimText(raw.title, TEMPLATE_LIMITS.ruleTitle[1] + 1)
  if (title.length < TEMPLATE_LIMITS.ruleTitle[0] || title.length > TEMPLATE_LIMITS.ruleTitle[1]) {
    return invalid(`규칙 제목은 ${TEMPLATE_LIMITS.ruleTitle[0]}~${TEMPLATE_LIMITS.ruleTitle[1]}자로 적어 주세요.`, `${path}.title`)
  }
  // 설명은 선택이 아니다 — hasWorkRuleShape가 필수 문자열로 보므로, 여기서 비워 두면 실체화가 통째로 막힌다.
  const description = trimText(raw.description, TEMPLATE_LIMITS.ruleDescription[1] + 1)
  if (description.length < TEMPLATE_LIMITS.ruleDescription[0] || description.length > TEMPLATE_LIMITS.ruleDescription[1]) {
    return invalid(`규칙 설명은 ${TEMPLATE_LIMITS.ruleDescription[0]}~${TEMPLATE_LIMITS.ruleDescription[1]}자로 적어 주세요.`, `${path}.description`)
  }
  const role = trimText(raw.role, TEMPLATE_LIMITS.roleName)
  if (!roles.includes(role)) {
    return fail('TEMPLATE_TASK_ROLE_UNKNOWN', '템플릿에 없는 역할입니다. 역할 목록에 먼저 추가해 주세요.', `${path}.role`)
  }
  if (!has(frequencies, raw.frequency)) return invalid('반복 주기 값을 확인해 주세요.', `${path}.frequency`)
  if (!inRange(raw.interval, [1, 12])) return invalid('반복 간격은 1~12 사이의 정수여야 합니다.', `${path}.interval`)
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.dueTime ?? ''))) return invalid('마감 시각은 HH:MM 형식이어야 합니다.', `${path}.dueTime`)
  if (!has(priorities, raw.priority)) return invalid('중요도 값을 확인해 주세요.', `${path}.priority`)
  const category = trimText(raw.category, TEMPLATE_LIMITS.category)
  if (!category) return invalid('업무 분류를 입력해 주세요.', `${path}.category`)
  const next = {
    key, title, description, role, frequency: raw.frequency, interval: raw.interval,
    dueTime: raw.dueTime, priority: raw.priority, category,
  }
  if (['weekly', 'biweekly'].includes(raw.frequency)) {
    if (!inRange(raw.weekday, [0, 6])) return invalid('요일은 0(일)~6(토) 사이의 정수여야 합니다.', `${path}.weekday`)
    next.weekday = raw.weekday
  }
  if (['monthly', 'quarterly', 'yearly'].includes(raw.frequency)) {
    const monthlyMode = raw.monthlyMode ?? 'day-of-month'
    if (!has(monthlyModes, monthlyMode)) return invalid('월 반복 방식 값을 확인해 주세요.', `${path}.monthlyMode`)
    next.monthlyMode = monthlyMode
    if (monthlyMode === 'day-of-month') {
      if (!inRange(raw.monthDay, [1, 31])) return invalid('반복 일자는 1~31 사이의 정수여야 합니다.', `${path}.monthDay`)
      next.monthDay = raw.monthDay
    }
    if (monthlyMode === 'last-weekday') {
      if (!inRange(raw.weekday, [0, 6])) return invalid('요일은 0(일)~6(토) 사이의 정수여야 합니다.', `${path}.weekday`)
      next.weekday = raw.weekday
    }
  }
  if (raw.holidayPolicy !== undefined) {
    if (!has(holidayPolicies, raw.holidayPolicy)) return invalid('공휴일 처리 값을 확인해 주세요.', `${path}.holidayPolicy`)
    next.holidayPolicy = raw.holidayPolicy
  }
  if (raw.startOffsetDays !== undefined) {
    if (!inRange(raw.startOffsetDays, TEMPLATE_LIMITS.dueOffsetDays)) return invalid('규칙 시작일은 0일 이상의 정수여야 합니다.', `${path}.startOffsetDays`)
    next.startOffsetDays = raw.startOffsetDays
  }
  const checklist = validateChecklist(raw.checklist, `${path}.checklist`)
  if (checklist.error) return checklist
  if (checklist.checklist) next.checklist = checklist.checklist
  return { rule: next }
}

/**
 * 템플릿 본문 전체 검증. 통과하면 { template }, 아니면 { error: { code, message, path } }.
 * 반환 template은 정규화된 사본이다 — 문자열은 여기서 한 번만 trim한다.
 *
 * id·sourceProjectId·sourceTemplateId는 본문에서 읽지 않고 옵션으로만 받는다. 본문에서 읽으면
 * 요청자가 id를 골라 기본 템플릿과 같은 id의 행을 하나 더 만들 수 있고, 그러면 find()가 어느 쪽을
 * 집을지 알 수 없어 '기본 템플릿은 고칠 수 없다'는 약속이 무너진다(같은 id 두 행은 Postgres의
 * PRIMARY KEY (org_id, id)에서 한 행으로 합쳐져 하나가 사라지기도 한다).
 * 새로 만들 때는 서버가 짓고(newTemplateId), 고칠 때는 existing이 그대로 가져온다.
 */
export function validateTemplateInput(body, {
  origin = 'custom', now = new Date().toISOString(), existing = null,
  id = null, sourceProjectId = null, sourceTemplateId = null,
  priorities = null, frequencies = WORK_RULE_FREQUENCIES, monthlyModes = WORK_RULE_MONTHLY_MODES, holidayPolicies = HOLIDAY_POLICIES,
} = {}) {
  if (!isPlainObject(body)) return invalid('템플릿 내용을 확인해 주세요.', 'template')
  if (!TEMPLATE_ORIGINS.includes(origin)) return invalid('템플릿 종류 값을 확인해 주세요.', 'origin')

  const name = trimText(body.name, TEMPLATE_LIMITS.name[1] + 1)
  if (name.length < TEMPLATE_LIMITS.name[0] || name.length > TEMPLATE_LIMITS.name[1]) {
    return invalid(`템플릿 이름은 ${TEMPLATE_LIMITS.name[0]}~${TEMPLATE_LIMITS.name[1]}자로 적어 주세요.`, 'name')
  }
  const description = trimText(body.description, TEMPLATE_LIMITS.description)
  const industryType = body.industryType === undefined || body.industryType === null || body.industryType === ''
    ? null
    : body.industryType
  if (industryType !== null && !TEMPLATE_INDUSTRIES.includes(industryType)) return invalid('업종 값을 확인해 주세요.', 'industryType')

  if (!Array.isArray(body.roles) || !body.roles.length || body.roles.length > TEMPLATE_LIMITS.roles) {
    return invalid(`역할은 1~${TEMPLATE_LIMITS.roles}개로 정해 주세요.`, 'roles')
  }
  const roles = []
  for (let index = 0; index < body.roles.length; index += 1) {
    const role = trimText(body.roles[index], TEMPLATE_LIMITS.roleName + 1)
    if (!role || role.length > TEMPLATE_LIMITS.roleName) return invalid(`역할 이름은 1~${TEMPLATE_LIMITS.roleName}자로 적어 주세요.`, `roles[${index}]`)
    if (roles.includes(role)) return invalid('같은 역할 이름이 두 번 있습니다.', 'roles')
    roles.push(role)
  }

  if (!Array.isArray(body.tasks) || !body.tasks.length || body.tasks.length > TEMPLATE_LIMITS.tasks) {
    return invalid(`업무는 1~${TEMPLATE_LIMITS.tasks}개로 정해 주세요.`, 'tasks')
  }
  const keys = new Set()
  const tasks = []
  let rowCount = 0
  for (let index = 0; index < body.tasks.length; index += 1) {
    const path = `tasks[${index}]`
    const parsed = validateTaskLike(body.tasks[index], { path, roles, priorities, fields: TASK_FIELDS })
    if (parsed.error) return parsed
    if (keys.has(parsed.task.key)) return fail('TEMPLATE_KEY_DUPLICATE', '같은 key가 두 번 있습니다. 항목 key는 템플릿 안에서 유일해야 합니다.', `${path}.key`)
    keys.add(parsed.task.key)
    rowCount += 1
    const rawChildren = body.tasks[index].children
    if (rawChildren !== undefined && !Array.isArray(rawChildren)) return invalid('하위 업무 목록의 형식을 확인해 주세요.', `${path}.children`)
    const list = Array.isArray(rawChildren) ? rawChildren : []
    if (list.length > TEMPLATE_LIMITS.childrenPerTask) {
      return fail('TEMPLATE_CHILDREN_LIMIT', `하위 업무는 상위 하나에 ${TEMPLATE_LIMITS.childrenPerTask}개까지 둘 수 있습니다.`, `${path}.children`)
    }
    const children = []
    for (let childIndex = 0; childIndex < list.length; childIndex += 1) {
      const childPath = `${path}.children[${childIndex}]`
      const child = validateTaskLike(list[childIndex], { path: childPath, roles, priorities, inherit: parsed.task, fields: CHILD_FIELDS })
      if (child.error) return child
      if (keys.has(child.task.key)) return fail('TEMPLATE_KEY_DUPLICATE', '같은 key가 두 번 있습니다. 항목 key는 템플릿 안에서 유일해야 합니다.', `${childPath}.key`)
      keys.add(child.task.key)
      // 자식이 상위보다 늦게 끝나면 상위는 영영 완료 보고를 할 수 없다(하위가 전부 끝나야 하므로).
      if (child.task.dueOffsetDays > parsed.task.dueOffsetDays) {
        return fail('TEMPLATE_CHILD_DUE_AFTER_PARENT', '하위 업무 마감은 상위 업무 마감보다 늦을 수 없습니다.', `${childPath}.dueOffsetDays`)
      }
      children.push(child.task)
      rowCount += 1
    }
    tasks.push({ ...parsed.task, children })
  }
  if (rowCount > TEMPLATE_LIMITS.totalRows) {
    return invalid(`템플릿 하나가 만드는 업무는 ${TEMPLATE_LIMITS.totalRows}건까지입니다.`, 'tasks')
  }

  const rawChannels = body.channels === undefined ? [] : body.channels
  if (!Array.isArray(rawChannels) || rawChannels.length > TEMPLATE_LIMITS.channels) {
    return invalid(`채널은 ${TEMPLATE_LIMITS.channels}개까지 둘 수 있습니다.`, 'channels')
  }
  const channels = []
  for (let index = 0; index < rawChannels.length; index += 1) {
    const raw = rawChannels[index]
    if (!exactFields(raw, CHANNEL_FIELDS)) return invalid('채널 형식을 확인해 주세요.', `channels[${index}]`)
    const channelName = trimText(raw.name, TEMPLATE_LIMITS.channelName + 1)
    if (!channelName || channelName.length > TEMPLATE_LIMITS.channelName) {
      return invalid(`채널 이름은 1~${TEMPLATE_LIMITS.channelName}자로 적어 주세요.`, `channels[${index}].name`)
    }
    if (channels.some((item) => item.name === channelName)) return invalid('같은 채널 이름이 두 번 있습니다.', `channels[${index}].name`)
    const purpose = trimText(raw.purpose, TEMPLATE_LIMITS.channelPurpose + 1)
    if (purpose.length > TEMPLATE_LIMITS.channelPurpose) return invalid(`채널 설명은 ${TEMPLATE_LIMITS.channelPurpose}자까지입니다.`, `channels[${index}].purpose`)
    channels.push({ name: channelName, ...(purpose ? { purpose } : {}) })
  }

  const rawCategories = body.documentCategories === undefined ? [] : body.documentCategories
  if (!Array.isArray(rawCategories) || rawCategories.length > TEMPLATE_LIMITS.documentCategories) {
    return invalid(`자료 분류는 ${TEMPLATE_LIMITS.documentCategories}개까지 둘 수 있습니다.`, 'documentCategories')
  }
  const documentCategories = []
  for (let index = 0; index < rawCategories.length; index += 1) {
    const category = trimText(rawCategories[index], TEMPLATE_LIMITS.documentCategory + 1)
    if (!category || category.length > TEMPLATE_LIMITS.documentCategory) {
      return invalid(`자료 분류는 1~${TEMPLATE_LIMITS.documentCategory}자로 적어 주세요.`, `documentCategories[${index}]`)
    }
    // 중복은 조용히 지운다 — 사람이 고칠 것이 없는 오류로 저장을 막지 않는다.
    if (!documentCategories.includes(category)) documentCategories.push(category)
  }

  const rawRules = body.rules === undefined ? [] : body.rules
  if (!Array.isArray(rawRules) || rawRules.length > TEMPLATE_LIMITS.rules) {
    return invalid(`반복 규칙은 ${TEMPLATE_LIMITS.rules}개까지 둘 수 있습니다.`, 'rules')
  }
  const rules = []
  for (let index = 0; index < rawRules.length; index += 1) {
    const parsed = validateRule(rawRules[index], { path: `rules[${index}]`, roles, priorities, frequencies, monthlyModes, holidayPolicies })
    if (parsed.error) return parsed
    if (keys.has(parsed.rule.key)) return fail('TEMPLATE_KEY_DUPLICATE', '같은 key가 두 번 있습니다. 항목 key는 템플릿 안에서 유일해야 합니다.', `rules[${index}].key`)
    keys.add(parsed.rule.key)
    rules.push(parsed.rule)
  }

  const template = {
    id: existing?.id ?? id ?? newTemplateId(),
    name, description, industryType, origin,
    version: Number.isInteger(existing?.version) && existing.version >= 1 ? existing.version : 1,
    roles, tasks, channels, documentCategories, rules,
    history: Array.isArray(existing?.history) ? existing.history : [],
    ...(existing?.sourceProjectId ?? sourceProjectId ? { sourceProjectId: String(existing?.sourceProjectId ?? sourceProjectId) } : {}),
    ...(existing?.sourceTemplateId ?? sourceTemplateId ? { sourceTemplateId: String(existing?.sourceTemplateId ?? sourceTemplateId) } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  return { template }
}

const hasHistoryEntryShape = (value) => exactFields(value, HISTORY_FIELDS)
  && Number.isInteger(value.version) && value.version >= 1
  && ['at', 'byId', 'byName', 'summary'].every((key) => typeof value[key] === 'string' && value[key].length > 0)

/** 저장된 레코드 전체가 규격에 맞는가. 검증 규칙은 validateTemplateInput 하나만 쓴다(두 벌로 갈라지지 않게). */
export function hasProjectTemplateShape(value, options = {}) {
  if (!isPlainObject(value)) return false
  if (Object.keys(value).some((key) => !TEMPLATE_FIELDS.includes(key))) return false
  if (typeof value.id !== 'string' || !value.id) return false
  if (!TEMPLATE_ORIGINS.includes(value.origin)) return false
  if (!Number.isInteger(value.version) || value.version < 1) return false
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return false
  if (!Array.isArray(value.history) || value.history.length > TEMPLATE_LIMITS.history || !value.history.every(hasHistoryEntryShape)) return false
  return !validateTemplateInput(value, { ...options, origin: value.origin, existing: value }).error
}

/**
 * 본문에 테넌트 계정의 id·이름·이메일이 들어 있는가. 있으면 { code, message, path }.
 * history의 byId/byName은 "누가 고쳤는가"라 예외다 — 그건 템플릿 내용이 아니라 이력이다.
 */
export function assertNoAccountReference(template, tenantAccounts) {
  const needles = []
  for (const account of Array.isArray(tenantAccounts) ? tenantAccounts : []) {
    for (const field of ['id', 'name', 'email']) {
      const value = String(account?.[field] ?? '').trim()
      if (value) needles.push(value)
    }
  }
  if (!needles.length) return null
  const body = {
    roles: template.roles, tasks: template.tasks, channels: template.channels,
    documentCategories: template.documentCategories, rules: template.rules,
  }
  const hit = findPersonReference(body, '', needles)
  if (!hit) return null
  return {
    code: 'TEMPLATE_CONTAINS_PERSON',
    message: '템플릿에는 사람 이름 대신 역할 이름을 적어 주세요. 사람은 프로젝트를 만들 때 정합니다.',
    path: hit,
  }
}

function findPersonReference(node, path, needles) {
  if (typeof node === 'string') return needles.some((needle) => node.includes(needle)) ? path : null
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const hit = findPersonReference(node[index], `${path}[${index}]`, needles)
      if (hit) return hit
    }
    return null
  }
  if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      const hit = findPersonReference(value, path ? `${path}.${key}` : key, needles)
      if (hit) return hit
    }
  }
  return null
}

/** 버전을 올리고 이력 한 줄을 앞에 붙인다. 만들기·복사는 bump 없이 version 1로 시작한다. */
export function withHistory(template, { actor, summary, now, bump = true }) {
  const version = bump ? template.version + 1 : template.version
  const entry = { version, at: now, byId: String(actor?.id ?? ''), byName: String(actor?.name ?? ''), summary: trimText(summary, TEMPLATE_LIMITS.summary) || '내용 수정' }
  return { ...template, version, updatedAt: now, history: [entry, ...(template.history ?? [])].slice(0, TEMPLATE_LIMITS.history) }
}

// ---------------------------------------------------------------------------
// 업종 기본 템플릿 (코드 상수 — 역할 이름과 상대 마감일만. 실명·계정 id 0)
// ---------------------------------------------------------------------------

const IT_OUTSOURCED_DEV = {
  id: SYSTEM_TEMPLATE_IDS.it_services,
  name: '외주 개발 프로젝트',
  description: '요구 정리 → 설계 → 개발 → 검수 → 납품 다섯 단계로 외주 개발을 진행합니다.',
  industryType: 'it_services',
  roles: ['PM', '디자이너', '개발'],
  channels: [
    { name: '개발 진행', purpose: '일일 진행 공유' },
    { name: '검수·이슈', purpose: '검수 지적·수정 이력' },
  ],
  documentCategories: ['프로젝트', '산출물', '계약·거래처', '검수·유지보수'],
  tasks: [
    {
      key: 'req', title: '요구 정리', role: 'PM', dueOffsetDays: 7, priority: '높음', category: '프로젝트',
      children: [
        { key: 'req-interview', title: '고객 인터뷰 정리', role: 'PM', dueOffsetDays: 3 },
        { key: 'req-scope', title: '범위·일정 합의서 작성', role: 'PM', dueOffsetDays: 6 },
      ],
    },
    {
      key: 'design', title: '설계', role: '디자이너', dueOffsetDays: 21, priority: '보통', category: '산출물',
      children: [
        { key: 'design-ia', title: '화면 흐름·정보구조 정리', role: '디자이너', dueOffsetDays: 12 },
        { key: 'design-ui', title: '주요 화면 시안', role: '디자이너', dueOffsetDays: 18 },
        { key: 'design-review', title: '시안 검토 회의', role: 'PM', dueOffsetDays: 21 },
      ],
    },
    {
      key: 'dev', title: '개발', role: '개발', dueOffsetDays: 49, priority: '높음', category: '프로젝트',
      children: [
        { key: 'dev-env', title: '개발 환경·저장소 준비', role: '개발', dueOffsetDays: 24 },
        { key: 'dev-core', title: '핵심 기능 구현', role: '개발', dueOffsetDays: 42 },
        { key: 'dev-test', title: '내부 테스트', role: '개발', dueOffsetDays: 49 },
      ],
    },
    {
      key: 'qa', title: '검수', role: 'PM', dueOffsetDays: 56, priority: '높음', category: '검수',
      children: [
        { key: 'qa-list', title: '검수 항목표 작성', role: 'PM', dueOffsetDays: 51 },
        { key: 'qa-fix', title: '검수 지적사항 수정', role: '개발', dueOffsetDays: 55 },
      ],
    },
    {
      key: 'delivery', title: '납품', role: 'PM', dueOffsetDays: 60, priority: '긴급', category: '프로젝트',
      children: [
        { key: 'delivery-docs', title: '산출물·매뉴얼 정리', role: '디자이너', dueOffsetDays: 58 },
        { key: 'delivery-final', title: '최종 납품·검수 확인서', role: 'PM', dueOffsetDays: 60 },
      ],
    },
  ],
  rules: [
    {
      key: 'weekly-report', title: '주간 진행 보고', description: '이번 주 진행·이슈·다음 주 계획을 정리해 공유한다.',
      role: 'PM', frequency: 'weekly', interval: 1, weekday: 5, dueTime: '17:00', priority: '보통', category: '프로젝트',
      holidayPolicy: 'before', checklist: ['진행률 갱신', '이슈 목록 정리'],
    },
  ],
}

const FOOD_NEW_PRODUCT = {
  id: SYSTEM_TEMPLATE_IDS.food_manufacturing,
  name: '신제품 출시',
  description: '시제품 → 표시사항 → HACCP 검토 → 생산 → 출하 다섯 단계로 신제품을 내보냅니다.',
  industryType: 'food_manufacturing',
  roles: ['PM', '품질', '생산'],
  channels: [
    { name: '출시 준비', purpose: '일정·의사결정 공유' },
    { name: '품질·표시', purpose: '표시사항·HACCP 검토 기록' },
  ],
  documentCategories: ['제품·표시사항', '생산·품질', '식품안전·인증'],
  tasks: [
    {
      key: 'prototype', title: '시제품', role: 'PM', dueOffsetDays: 14, priority: '높음', category: '제품',
      children: [
        { key: 'prototype-recipe', title: '배합·공정 초안', role: '생산', dueOffsetDays: 7 },
        { key: 'prototype-tasting', title: '시식 평가', role: 'PM', dueOffsetDays: 12 },
        { key: 'prototype-cost', title: '원가 산출', role: 'PM', dueOffsetDays: 14 },
      ],
    },
    {
      key: 'label', title: '표시사항', role: '품질', dueOffsetDays: 28, priority: '높음', category: '제품',
      children: [
        { key: 'label-ingredients', title: '원재료·영양성분 표시 검토', role: '품질', dueOffsetDays: 21 },
        { key: 'label-design', title: '포장 표시 시안 확정', role: 'PM', dueOffsetDays: 28 },
      ],
    },
    {
      key: 'haccp', title: 'HACCP 검토', role: '품질', dueOffsetDays: 42, priority: '긴급', category: '품질',
      children: [
        { key: 'haccp-hazard', title: '위해요소 분석', role: '품질', dueOffsetDays: 35 },
        { key: 'haccp-ccp', title: 'CCP 설정·기록지 준비', role: '품질', dueOffsetDays: 40 },
        { key: 'haccp-report', title: '품목제조보고 서류 준비', role: '품질', dueOffsetDays: 42 },
      ],
    },
    {
      key: 'production', title: '생산', role: '생산', dueOffsetDays: 56, priority: '높음', category: '생산',
      children: [
        { key: 'production-materials', title: '원부자재 입고 확인', role: '생산', dueOffsetDays: 49 },
        { key: 'production-trial', title: '시험 생산', role: '생산', dueOffsetDays: 53 },
        { key: 'production-first', title: '초도 생산', role: '생산', dueOffsetDays: 56 },
      ],
    },
    {
      key: 'shipping', title: '출하', role: 'PM', dueOffsetDays: 60, priority: '긴급', category: '재고',
      children: [
        { key: 'shipping-inspection', title: '출하 전 검사 성적서', role: '품질', dueOffsetDays: 58 },
        { key: 'shipping-first', title: '초도 출하·거래처 안내', role: 'PM', dueOffsetDays: 60 },
      ],
    },
  ],
  rules: [
    {
      key: 'daily-line-check', title: '생산 라인 일일 점검', description: '시험·초도 생산 기간의 라인 점검 결과를 기록한다.',
      role: '생산', frequency: 'daily', interval: 1, dueTime: '18:00', priority: '보통', category: '생산',
      holidayPolicy: 'skip', checklist: ['금속검출기 시험편 확인', 'CCP 기록지 작성'],
    },
  ],
}

const SYSTEM_TEMPLATE_DEFS = Object.freeze({
  it_services: [IT_OUTSOURCED_DEV],
  food_manufacturing: [FOOD_NEW_PRODUCT],
})

/**
 * 업종별 기본 템플릿. 모르는 업종은 식품제조로 본다(rulePackFor 관례).
 * 상수도 사용자 입력과 같은 검증을 지난다 — 그래야 자식의 priority·category 상속처럼
 * "입력에서만 채워지는 값"이 상수에서만 비어 있는 일이 생기지 않는다.
 */
export function systemTemplatesFor(industryType, { now = new Date().toISOString(), priorities = null } = {}) {
  const defs = SYSTEM_TEMPLATE_DEFS[industryType] ?? SYSTEM_TEMPLATE_DEFS.food_manufacturing
  return defs.map((def) => {
    // 기본 템플릿만 id가 코드에 박혀 있다(재시드·출처 배지가 이 id를 가리킨다). 사용자 본문은 id를 정할 수 없다.
    const parsed = validateTemplateInput(structuredClone(def), { origin: 'system', now, priorities, id: def.id })
    if (parsed.error) throw new Error(`SYSTEM_TEMPLATE_INVALID:${def.id}:${parsed.error.code}:${parsed.error.path ?? ''}`)
    return {
      ...parsed.template,
      history: [{ version: 1, at: now, byId: SYSTEM_TEMPLATE_ACTOR.id, byName: SYSTEM_TEMPLATE_ACTOR.name, summary: '기본 템플릿 제공' }],
    }
  })
}

// ---------------------------------------------------------------------------
// 프로젝트 → 템플릿 ('템플릿으로 저장')
// ---------------------------------------------------------------------------

const keyFromId = (id, fallbackIndex) => {
  const candidate = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
  return TEMPLATE_LIMITS.key.test(candidate) ? candidate : `t${fallbackIndex}`
}

/**
 * 프로젝트의 업무·채널·자료 분류를 템플릿 본문으로 바꾼다. 사람은 여기서 사라지고 역할만 남는다.
 * roleMap(계정 id → 역할 이름)이 오면 그 이름을 쓰고, 없으면 jobRole → team → '담당 N' 순으로 짐작한다.
 */
function deriveTemplateBody({ project, workItems, conversations = [], documents = [], accounts = [], roleMap = {} }) {
  const warnings = []
  const items = (Array.isArray(workItems) ? workItems : []).filter((item) => item?.projectId === project.id)
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(project.startDate ?? ''))
    ? Date.parse(`${project.startDate}T00:00:00+09:00`)
    : Date.parse(String(project.createdAt ?? '')) || Date.now()

  const accountOf = (id) => accounts.find((account) => account?.id === id) ?? null
  const roleByOwner = new Map()
  const people = []
  const roles = []
  const useRole = (role) => {
    if (!roles.includes(role)) roles.push(role)
    return role
  }
  const roleOf = (ownerId) => {
    // 담당자가 지워진 레거시 행. 사람을 짐작하지 않고 이름 없는 한 역할로 모은다.
    if (!ownerId) return useRole('담당')
    if (roleByOwner.has(ownerId)) return roleByOwner.get(ownerId)
    const account = accountOf(ownerId)
    const mapped = trimText(roleMap?.[ownerId], TEMPLATE_LIMITS.roleName)
    const suggested = account?.role === GUEST_ROLE
      ? '외부 협력'
      : trimText(account?.jobRole, TEMPLATE_LIMITS.roleName) || trimText(account?.team, TEMPLATE_LIMITS.roleName) || `담당 ${people.length + 1}`
    let role = mapped || suggested
    // 역할 상한에 닿으면 더 쪼개지 않고 하나로 합친다 — 20개가 넘는 역할표는 아무도 읽지 않는다.
    if (!roles.includes(role) && roles.length >= TEMPLATE_LIMITS.roles - 1) role = '담당'
    roleByOwner.set(ownerId, role)
    useRole(role)
    people.push({ accountId: ownerId, name: String(account?.name ?? ''), jobRole: String(account?.jobRole ?? ''), team: String(account?.team ?? ''), suggestedRole: suggested, taskCount: 0 })
    return role
  }
  const countPerson = (ownerId) => {
    const person = people.find((entry) => entry.accountId === ownerId)
    if (person) person.taskCount += 1
  }

  let unreadableDue = 0
  const offsetOf = (item) => {
    const due = Date.parse(String(item?.due ?? ''))
    if (!Number.isFinite(due)) { unreadableDue += 1; return 1 }
    return Math.min(TEMPLATE_LIMITS.dueOffsetDays[1], Math.max(0, Math.round((due - base) / DAY_MS)))
  }

  const usedKeys = new Set()
  const uniqueKey = (item, index) => {
    let key = keyFromId(item?.id, index + 1)
    if (usedKeys.has(key)) key = `t${index + 1}`
    let guard = index + 1
    while (usedKeys.has(key)) { guard += 1; key = `t${guard}` }
    usedKeys.add(key)
    return key
  }

  const topLevel = items.filter((item) => !item?.parentId)
  const tasks = []
  let clampedChild = 0
  for (let index = 0; index < topLevel.length && tasks.length < TEMPLATE_LIMITS.tasks; index += 1) {
    const item = topLevel[index]
    const role = roleOf(item.ownerId)
    countPerson(item.ownerId)
    const dueOffsetDays = offsetOf(item)
    const task = {
      key: uniqueKey(item, index),
      title: trimText(item.title, TEMPLATE_LIMITS.title[1]) || '업무',
      role,
      dueOffsetDays,
      priority: item.priority,
      category: trimText(item.category, TEMPLATE_LIMITS.category) || '일반',
      ...(Array.isArray(item.checklist) && item.checklist.length
        ? { checklist: item.checklist.slice(0, TEMPLATE_LIMITS.checklist).map((entry) => trimText(entry?.label, TEMPLATE_LIMITS.checklistLabel)).filter(Boolean) }
        : {}),
      children: [],
    }
    const kids = childrenOf(items, item.id).slice(0, TEMPLATE_LIMITS.childrenPerTask)
    for (let childIndex = 0; childIndex < kids.length; childIndex += 1) {
      const child = kids[childIndex]
      const childRole = roleOf(child.ownerId)
      countPerson(child.ownerId)
      let childDue = offsetOf(child)
      if (childDue > dueOffsetDays) { childDue = dueOffsetDays; clampedChild += 1 }
      task.children.push({
        key: uniqueKey(child, topLevel.length + tasks.length * TEMPLATE_LIMITS.childrenPerTask + childIndex + 1),
        title: trimText(child.title, TEMPLATE_LIMITS.title[1]) || '업무',
        role: childRole,
        dueOffsetDays: childDue,
        priority: child.priority,
        category: trimText(child.category, TEMPLATE_LIMITS.category) || '일반',
      })
    }
    tasks.push(task)
  }
  if (unreadableDue) warnings.push(`마감을 읽을 수 없는 업무 ${unreadableDue}건은 시작 +1일로 저장했습니다.`)
  if (clampedChild) warnings.push(`상위보다 늦은 하위 업무 ${clampedChild}건의 마감을 상위와 같게 맞췄습니다.`)

  const channels = (Array.isArray(conversations) ? conversations : [])
    .filter((room) => room?.kind === 'group' && room?.projectId === project.id)
    .slice(0, TEMPLATE_LIMITS.channels)
    .map((room) => ({ name: trimText(room.name, TEMPLATE_LIMITS.channelName) }))

  const documentCategories = []
  for (const category of [...(Array.isArray(project.documentCategories) ? project.documentCategories : []),
    ...(Array.isArray(documents) ? documents : []).filter((doc) => doc?.projectId === project.id).map((doc) => doc?.category)]) {
    const value = trimText(category, TEMPLATE_LIMITS.documentCategory)
    if (value && !documentCategories.includes(value) && documentCategories.length < TEMPLATE_LIMITS.documentCategories) documentCategories.push(value)
  }

  return { body: { roles, tasks, channels, documentCategories, rules: [] }, people, warnings }
}

/**
 * 업무가 하나도 없는 프로젝트의 진짜 사유. 초안(경고)과 저장(400)이 같은 문장을 쓴다 —
 * 초안이 '괜찮다'고 하고 저장이 '역할을 정해 주세요'라고 하면, 사람은 건드린 적 없는 역할표를 들여다보게 된다.
 */
const NO_TASKS_REASON = '이 프로젝트에는 템플릿으로 저장할 업무가 없습니다. 업무를 먼저 만들어 주세요.'

/** 저장하지 않고 '템플릿으로 저장' 대화상자에 보여 줄 초안. 사람은 draft가 아니라 people에만 담긴다. */
export function templateDraftFromProject({ project, workItems, conversations, documents, accounts }) {
  const derived = deriveTemplateBody({ project, workItems, conversations, documents, accounts })
  return {
    draft: {
      name: `${trimText(project.name, 60)} 템플릿`.slice(0, TEMPLATE_LIMITS.name[1]),
      description: trimText(project.description, TEMPLATE_LIMITS.description),
      ...derived.body,
    },
    people: derived.people,
    warnings: derived.body.tasks.length ? derived.warnings : [NO_TASKS_REASON, ...derived.warnings],
  }
}

export function templateFromProject({
  project, workItems, conversations, documents, accounts, roleMap, name, description,
  now = new Date().toISOString(), industryType = null, priorities = null,
}) {
  const derived = deriveTemplateBody({ project, workItems, conversations, documents, accounts, roleMap })
  // 업무가 없으면 역할도 비어 있어 'roles' 오류가 먼저 난다. 사람이 고칠 수 있는 진짜 사유를 먼저 말한다.
  if (!derived.body.tasks.length) return invalid(NO_TASKS_REASON, 'tasks')
  const input = {
    name: trimText(name, TEMPLATE_LIMITS.name[1]) || `${trimText(project.name, 60)} 템플릿`.slice(0, TEMPLATE_LIMITS.name[1]),
    description: description === undefined ? trimText(project.description, TEMPLATE_LIMITS.description) : trimText(description, TEMPLATE_LIMITS.description),
    industryType,
    ...derived.body,
  }
  const parsed = validateTemplateInput(input, { origin: 'custom', now, priorities, sourceProjectId: project.id })
  if (parsed.error) return parsed
  return { template: parsed.template, warnings: derived.warnings }
}

// ---------------------------------------------------------------------------
// 실체화 계획 (순수)
// ---------------------------------------------------------------------------

/**
 * 템플릿 + 프로젝트 + 역할 매핑 → 만들어질 업무·채널·규칙. 저장은 하지 않는다.
 * id는 전부 결정론적이다 — 같은 프로젝트를 두 번 만들 수 없고, 실패한 실체화가 반쪽 id를 남기지 않는다.
 */
export function planInstantiation({
  template, project, roleMap, startDate, actor, accounts, now,
  seoulLocalDateTimeToUtcIso, firstRuleDateOnOrAfter, memberIds = [],
}) {
  const accountOf = (id) => accounts.find((account) => account?.id === id) ?? null
  const suffix = String(project.id).replace(/^PRJ-/, '')
  const tid = String(template.id).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)
  const label = `템플릿 ‘${template.name}’`.slice(0, 120)

  const rowOf = (task, id, parentId) => {
    const owner = accountOf(roleMap[task.role])
    return {
      id,
      title: task.title,
      description: '',
      owner: String(owner?.name ?? ''),
      ownerId: String(owner?.id ?? ''),
      requestedBy: String(actor.name ?? ''),
      requesterId: String(actor.id ?? ''),
      due: seoulLocalDateTimeToUtcIso(addDaysKey(startDate, task.dueOffsetDays), WORK_DUE_TIME),
      priority: task.priority,
      status: '업무요청',
      category: task.category,
      createdAt: now,
      projectId: project.id,
      origin: { kind: 'template', label, detail: task.key, page: 'projects', focusId: project.id },
      ...(task.checklist?.length ? { checklist: task.checklist.map((text, index) => ({ id: `CK-${index + 1}`, label: text, done: false })) } : {}),
      ...(parentId ? { parentId } : {}),
    }
  }

  const workItems = []
  for (const task of template.tasks) {
    const parentId = `WK-T-${tid}-${suffix}-${task.key}`
    workItems.push(rowOf(task, parentId, null))
    for (const child of task.children) workItems.push(rowOf(child, `${parentId}-${child.key}`, parentId))
  }

  const channels = template.channels.map((channel, index) => buildGroupConversation({
    name: channel.name,
    participantIds: memberIds,
    creatorId: actor.id,
    projectId: project.id,
    createdAt: now,
    id: `grp-T-${suffix}-${index + 1}`,
  }))

  const rules = template.rules.map((rule) => {
    const owner = accountOf(roleMap[rule.role])
    const anchor = addDaysKey(startDate, rule.startOffsetDays ?? 0)
    return {
      id: `WR-T-${tid}-${suffix}-${rule.key}`,
      title: `[${project.name}] ${rule.title}`.slice(0, 200),
      description: rule.description,
      owner: String(owner?.name ?? ''),
      ownerId: String(owner?.id ?? ''),
      requester: String(actor.name ?? ''),
      requesterId: String(actor.id ?? ''),
      frequency: rule.frequency,
      interval: rule.interval,
      ...(rule.weekday !== undefined ? { weekday: rule.weekday } : {}),
      ...(rule.monthDay !== undefined ? { monthDay: rule.monthDay } : {}),
      ...(rule.monthlyMode !== undefined ? { monthlyMode: rule.monthlyMode } : {}),
      nextRun: firstRuleDateOnOrAfter(anchor, rule.frequency, { weekday: rule.weekday, monthDay: rule.monthDay, monthlyMode: rule.monthlyMode }),
      dueTime: rule.dueTime,
      priority: rule.priority,
      category: rule.category,
      active: true,
      createdAt: now,
      ...(rule.holidayPolicy ? { holidayPolicy: rule.holidayPolicy } : {}),
      assignMode: 'fixed',
      ...(rule.checklist?.length ? { checklist: rule.checklist.map((text, index) => ({ id: `CK-${index + 1}`, label: text })) } : {}),
    }
  })

  return { workItems, channels, rules }
}

// ---------------------------------------------------------------------------
// 라우트
// ---------------------------------------------------------------------------

const NOT_FOUND = { code: 'TEMPLATE_NOT_FOUND', message: '템플릿을 찾을 수 없습니다.' }
const SYSTEM_READONLY = { code: 'TEMPLATE_SYSTEM_READONLY', message: '기본 템플릿은 복사해서 고쳐 쓰세요.' }
const PROJECT_NOT_FOUND = { code: 'PROJECT_NOT_FOUND', message: '프로젝트를 찾을 수 없습니다.' }

const summaryOf = (template) => {
  const { history: _history, ...rest } = template
  return {
    ...rest,
    taskCount: template.tasks.length,
    childCount: template.tasks.reduce((sum, task) => sum + task.children.length, 0),
  }
}

export function registerProjectTemplateRoutes({
  app, requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, workspaceStore, accounts, commitWorkspaceStore, scheduleAuditCommit,
  tenantIndustryType, operatorAwareAccounts, guestGrantOf, projectSpacesOf, projectMemberIds, publicProject, normalizeProjectMembers, applyProjectInfo, writeProjectData,
  normalizeAdminWorkItems, normalizeAdminWorkRules, firstRuleDateOnOrAfter, koreaDate, seoulLocalDateTimeToUtcIso,
  notifyNewAssignments, scheduleSentinel, events, workspaceRecordVersion,
  priorities, frequencies, monthlyModes, holidayPolicies, projectStages,
  clock = () => new Date(),
}) {
  const nowIso = () => clock().toISOString()
  const rowsOf = (tenantId, key) => {
    const record = workspaceStore.tenants[tenantId]?.[key]
    return Array.isArray(record?.data) ? record.data : []
  }
  const templatesOf = (tenantId) => rowsOf(tenantId, PROJECT_TEMPLATES_KEY)
  const validationOptions = { priorities, frequencies, monthlyModes, holidayPolicies }
  const tenantAccounts = (tenantId) => accounts.filter((account) => account?.tenantId === tenantId)

  const requireTenant = (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return false
    }
    // 게이트가 먼저 막지만 이 라우트 혼자서도 같은 결론을 내야 한다(이중 방어).
    if (request.auth.role === GUEST_ROLE) {
      response.status(403).json({ error: GUEST_SCOPE_FORBIDDEN })
      return false
    }
    return true
  }

  const writeTemplates = async (tenantId, data, actorId, response) => {
    // id는 저장소 안에서 유일해야 한다. 같은 id가 둘이면 find()가 어느 쪽을 집을지 알 수 없고,
    // filter(id !== …) 한 번이 둘 다 지운다. Postgres는 PRIMARY KEY (org_id, id)라 한 행으로 합쳐 하나를 잃는다.
    // id를 서버가 짓는 지금은 닿지 않는 문이지만, 쓰기가 한 곳을 지나므로 여기 한 번만 두면 된다.
    if (new Set(data.map((item) => item?.id)).size !== data.length) {
      response.status(409).json({ error: { code: 'TEMPLATE_ID_CONFLICT', message: '같은 id의 템플릿이 이미 있습니다. 잠시 후 다시 시도해 주세요.' } })
      return false
    }
    const tenantStore = workspaceStore.tenants[tenantId] ??= {}
    const previous = tenantStore[PROJECT_TEMPLATES_KEY]
    tenantStore[PROJECT_TEMPLATES_KEY] = { data, updatedAt: nowIso(), updatedBy: actorId }
    try {
      await commitWorkspaceStore()
    } catch {
      if (previous) tenantStore[PROJECT_TEMPLATES_KEY] = previous
      else delete tenantStore[PROJECT_TEMPLATES_KEY]
      response.status(500).json({ error: { code: 'TEMPLATE_WRITE_FAILED', message: '템플릿을 저장하지 못했습니다.' } })
      return false
    }
    return true
  }

  /**
   * 업종 기본 템플릿을 목록을 열 때 한 번 채운다(부팅 시 시드하지 않는다 — importLegacyItProjects 관례).
   * 업종을 바꾸면 새 업종 팩이 '추가'되고 기존 것은 남는다. 지우면 그 템플릿으로 만든 프로젝트의
   * 출처 배지가 가리키는 곳이 사라진다.
   */
  const ensureSystemTemplates = (tenantId) => {
    const existing = templatesOf(tenantId)
    // priorities를 넘겨야 상수의 중요도 값도 사용자 입력과 같은 목록으로 검사된다 — 잘못된 시드는 여기서 터져야 한다.
    const defs = systemTemplatesFor(tenantIndustryType(tenantId), { now: nowIso(), priorities })
    const missing = defs.filter((def) => !existing.some((item) => item?.id === def.id))
    if (!missing.length) return existing
    const rows = [...missing, ...existing]
    const tenantStore = workspaceStore.tenants[tenantId] ??= {}
    tenantStore[PROJECT_TEMPLATES_KEY] = { data: rows, updatedAt: nowIso(), updatedBy: SYSTEM_TEMPLATE_ACTOR.id }
    scheduleAuditCommit()
    return rows
  }

  const sortTemplates = (rows) => [...rows].sort((left, right) => Number(right.origin === 'system') - Number(left.origin === 'system')
    || String(right.updatedAt).localeCompare(String(left.updatedAt)))

  app.get('/api/project-templates', requireAuth, requireMatchingWorkspaceIdentity, (request, response) => {
    if (!requireTenant(request, response)) return
    const rows = ensureSystemTemplates(request.auth.tenantId)
    response.json({ templates: sortTemplates(rows).map(summaryOf), industryType: tenantIndustryType(request.auth.tenantId) })
  })

  app.get('/api/project-templates/:id', requireAuth, requireMatchingWorkspaceIdentity, (request, response) => {
    if (!requireTenant(request, response)) return
    const template = ensureSystemTemplates(request.auth.tenantId).find((item) => item?.id === request.params.id)
    if (!template) { response.status(404).json({ error: NOT_FOUND }); return }
    response.json({ template })
  })

  app.post('/api/project-templates', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const now = nowIso()
    const parsed = validateTemplateInput(request.body, { ...validationOptions, origin: 'custom', now })
    if (parsed.error) { response.status(400).json({ error: parsed.error }); return }
    const person = assertNoAccountReference(parsed.template, tenantAccounts(request.auth.tenantId))
    if (person) { response.status(400).json({ error: person }); return }
    const rows = templatesOf(request.auth.tenantId)
    if (rows.length >= TEMPLATE_LIMITS.perTenant) {
      response.status(409).json({ error: { code: 'TEMPLATE_LIMIT_REACHED', message: `템플릿은 ${TEMPLATE_LIMITS.perTenant}개까지 만들 수 있습니다. 쓰지 않는 템플릿을 지워 주세요.` } })
      return
    }
    const template = withHistory(parsed.template, { actor: request.auth, summary: '템플릿 만들기', now, bump: false })
    if (!await writeTemplates(request.auth.tenantId, [template, ...rows], request.auth.id, response)) return
    response.status(201).json({ template })
  })

  app.patch('/api/project-templates/:id', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const rows = ensureSystemTemplates(request.auth.tenantId)
    const index = rows.findIndex((item) => item?.id === request.params.id)
    if (index < 0) { response.status(404).json({ error: NOT_FOUND }); return }
    const previous = rows[index]
    if (previous.origin === 'system') { response.status(409).json({ error: SYSTEM_READONLY }); return }
    if (request.body?.version !== previous.version) {
      response.status(409).json({ error: { code: 'TEMPLATE_VERSION_CONFLICT', message: '다른 곳에서 먼저 저장되었습니다. 최신 내용을 불러온 뒤 다시 저장해 주세요.', currentVersion: previous.version } })
      return
    }
    const merged = { ...previous }
    for (const field of PATCHABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(request.body ?? {}, field)) merged[field] = request.body[field]
    }
    const now = nowIso()
    const parsed = validateTemplateInput(merged, { ...validationOptions, origin: previous.origin, existing: previous, now })
    if (parsed.error) { response.status(400).json({ error: parsed.error }); return }
    const person = assertNoAccountReference(parsed.template, tenantAccounts(request.auth.tenantId))
    if (person) { response.status(400).json({ error: person }); return }
    const template = withHistory(parsed.template, { actor: request.auth, summary: request.body?.summary, now })
    if (!await writeTemplates(request.auth.tenantId, rows.map((item, itemIndex) => itemIndex === index ? template : item), request.auth.id, response)) return
    response.json({ template })
  })

  app.delete('/api/project-templates/:id', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const rows = ensureSystemTemplates(request.auth.tenantId)
    const template = rows.find((item) => item?.id === request.params.id)
    if (!template) { response.status(404).json({ error: NOT_FOUND }); return }
    if (template.origin === 'system') { response.status(409).json({ error: SYSTEM_READONLY }); return }
    if (!await writeTemplates(request.auth.tenantId, rows.filter((item) => item.id !== template.id), request.auth.id, response)) return
    response.json({ ok: true })
  })

  app.post('/api/project-templates/:id/duplicate', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const rows = ensureSystemTemplates(request.auth.tenantId)
    const source = rows.find((item) => item?.id === request.params.id)
    if (!source) { response.status(404).json({ error: NOT_FOUND }); return }
    if (rows.length >= TEMPLATE_LIMITS.perTenant) {
      response.status(409).json({ error: { code: 'TEMPLATE_LIMIT_REACHED', message: `템플릿은 ${TEMPLATE_LIMITS.perTenant}개까지 만들 수 있습니다. 쓰지 않는 템플릿을 지워 주세요.` } })
      return
    }
    const now = nowIso()
    const copy = withHistory({
      ...structuredClone(source),
      id: newTemplateId(),
      name: `${source.name} (복사)`.slice(0, TEMPLATE_LIMITS.name[1]),
      origin: 'custom',
      version: 1,
      history: [],
      sourceTemplateId: source.id,
      createdAt: now,
      updatedAt: now,
    }, { actor: request.auth, summary: `‘${source.name}’에서 복사`, now, bump: false })
    if (!await writeTemplates(request.auth.tenantId, [copy, ...rows], request.auth.id, response)) return
    response.status(201).json({ template: copy })
  })

  const findProject = (request, response) => {
    const project = projectSpacesOf(request.auth.tenantId).find((item) => item?.id === request.params.id)
    if (!project) { response.status(404).json({ error: PROJECT_NOT_FOUND }); return null }
    return project
  }

  app.get('/api/projects/:id/template-draft', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, (request, response) => {
    if (!requireTenant(request, response)) return
    const project = findProject(request, response)
    if (!project) return
    const draft = templateDraftFromProject({
      project,
      workItems: rowsOf(request.auth.tenantId, 'work-items'),
      conversations: rowsOf(request.auth.tenantId, 'messenger-conversations'),
      documents: rowsOf(request.auth.tenantId, 'company-documents'),
      accounts: tenantAccounts(request.auth.tenantId),
    })
    response.json(draft)
  })

  app.post('/api/projects/:id/save-as-template', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const project = findProject(request, response)
    if (!project) return
    const now = nowIso()
    const built = templateFromProject({
      project,
      workItems: rowsOf(request.auth.tenantId, 'work-items'),
      conversations: rowsOf(request.auth.tenantId, 'messenger-conversations'),
      documents: rowsOf(request.auth.tenantId, 'company-documents'),
      accounts: tenantAccounts(request.auth.tenantId),
      roleMap: isPlainObject(request.body?.roleMap) ? request.body.roleMap : {},
      name: request.body?.name,
      description: request.body?.description,
      industryType: tenantIndustryType(request.auth.tenantId),
      priorities,
      now,
    })
    if (built.error) { response.status(400).json({ error: built.error }); return }
    const person = assertNoAccountReference(built.template, tenantAccounts(request.auth.tenantId))
    if (person) { response.status(400).json({ error: person }); return }
    const rows = templatesOf(request.auth.tenantId)
    if (rows.length >= TEMPLATE_LIMITS.perTenant) {
      response.status(409).json({ error: { code: 'TEMPLATE_LIMIT_REACHED', message: `템플릿은 ${TEMPLATE_LIMITS.perTenant}개까지 만들 수 있습니다. 쓰지 않는 템플릿을 지워 주세요.` } })
      return
    }
    const template = withHistory(built.template, { actor: request.auth, summary: `프로젝트 ‘${project.name}’에서 저장`, now, bump: false })
    if (!await writeTemplates(request.auth.tenantId, [template, ...rows], request.auth.id, response)) return
    response.status(201).json({ template, warnings: built.warnings })
  })

  app.post('/api/project-templates/:id/instantiate', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const tenantId = request.auth.tenantId
    const template = ensureSystemTemplates(tenantId).find((item) => item?.id === request.params.id)
    if (!template) { response.status(404).json({ error: NOT_FOUND }); return }
    const name = trimText(request.body?.name, TEMPLATE_LIMITS.name[1])
    if (name.length < TEMPLATE_LIMITS.name[0]) {
      response.status(400).json({ error: { code: 'INVALID_PROJECT', message: '프로젝트 이름은 2자 이상 입력해 주세요.' } })
      return
    }
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.body?.startDate ?? '')) ? String(request.body.startDate) : koreaDate()
    const rawRequestId = String(request.body?.clientRequestId ?? '')
    const clientRequestId = rawRequestId && rawRequestId.length <= 64 && /^[A-Za-z0-9_-]+$/.test(rawRequestId) ? rawRequestId : null

    // 멱등: 같은 사람이 같은 템플릿을 같은 요청 id로 다시 부르면 이미 만든 것을 그대로 돌려준다.
    // 조회를 내 소유 프로젝트로 좁히는 이유는, 남이 만든 프로젝트가 내 재시도의 답이 되면 안 되기 때문이다.
    if (clientRequestId) {
      const replayed = projectSpacesOf(tenantId).find((item) => item?.ownerId === request.auth.id
        && item?.origin?.templateId === template.id && item?.origin?.clientRequestId === clientRequestId)
      if (replayed) {
        response.json({
          project: publicProject(replayed, [], request.auth),
          workItems: rowsOf(tenantId, 'work-items').filter((item) => item?.projectId === replayed.id),
          channels: [], rules: [], replayed: true,
        })
        return
      }
    }

    const roleMap = isPlainObject(request.body?.roleMap) ? request.body.roleMap : {}
    const missing = template.roles.filter((role) => !roleMap[role])
    if (missing.length) {
      response.status(400).json({ error: { code: 'TEMPLATE_ROLE_UNMAPPED', message: '역할마다 사람을 정해 주세요.', roles: missing } })
      return
    }
    const roster = operatorAwareAccounts(request.auth)
    const resolved = {}
    for (const role of template.roles) {
      const account = roster.find((item) => item?.id === roleMap[role] && item.tenantId === tenantId)
      if (account?.role === GUEST_ROLE) {
        response.status(400).json({ error: { code: 'TEMPLATE_ROLE_GUEST_FORBIDDEN', message: '외부 게스트에게는 템플릿 역할을 맡길 수 없습니다.', role } })
        return
      }
      if (!account || !account.approved || account.role === 'platform-operator') {
        response.status(400).json({ error: { code: 'TEMPLATE_ROLE_INVALID', message: '같은 회사 직원만 역할에 배정할 수 있습니다.', role } })
        return
      }
      resolved[role] = account.id
    }

    const spaces = projectSpacesOf(tenantId)
    if (spaces.length >= 500) {
      response.status(409).json({ error: { code: 'PROJECT_LIMIT_REACHED', message: '프로젝트가 너무 많습니다. 보관 처리 후 다시 시도해 주세요.' } })
      return
    }

    const now = nowIso()
    const projectId = `PRJ-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`
    const memberInput = [
      ...(Array.isArray(request.body?.members) ? request.body.members : []),
      // 역할을 맡은 사람은 프로젝트를 편집할 수 있어야 한다 — 자기 업무의 첨부·게시글을 올려야 하므로.
      ...Object.values(resolved).map((id) => ({ id, role: 'editor' })),
    ]
    const project = {
      id: projectId,
      name,
      description: trimText(request.body?.description ?? template.description, 500),
      visibility: request.body?.visibility === 'company' ? 'company' : 'members',
      status: 'active',
      ownerId: request.auth.id,
      ownerName: request.auth.name,
      members: normalizeProjectMembers(tenantId, request.auth.id, request.auth.name, memberInput, projectId),
      stage: projectStages?.has('준비') ? '준비' : '',
      client: '', startDate: '', endDate: '', amount: 0, link: '', category: '',
      documentCategories: [...template.documentCategories],
      origin: {
        kind: 'template', templateId: template.id, templateName: template.name, templateVersion: template.version,
        ...(clientRequestId ? { clientRequestId } : {}),
      },
      createdAt: now,
      updatedAt: now,
    }
    applyProjectInfo(project, { ...request.body, startDate })

    const currentWorkItems = rowsOf(tenantId, 'work-items')
    const plan = planInstantiation({
      template, project, roleMap: resolved, startDate, actor: request.auth, accounts: roster, now,
      seoulLocalDateTimeToUtcIso, firstRuleDateOnOrAfter, memberIds: projectMemberIds(project),
    })

    // 상한 검사가 정규화보다 먼저다 — 1000건을 넘길 저장은 만들어 보기 전에 거절해야 한다.
    if (currentWorkItems.length + plan.workItems.length > 1_000) {
      response.status(409).json({ error: { code: 'WORK_ITEMS_LIMIT_REACHED', message: '업무가 너무 많습니다. 완료된 업무를 정리한 뒤 다시 시도해 주세요.' } })
      return
    }
    const knownIds = new Set(currentWorkItems.map((item) => item?.id))
    if (plan.workItems.some((row) => knownIds.has(row.id))) {
      response.status(409).json({ error: { code: 'TEMPLATE_INSTANTIATE_CONFLICT', message: '같은 업무 id가 이미 있습니다. 잠시 후 다시 시도해 주세요.' } })
      return
    }
    const nextWorkItems = normalizeAdminWorkItems([...plan.workItems, ...currentWorkItems], tenantId, roster)
    if (!nextWorkItems) { response.status(400).json({ error: { code: 'TEMPLATE_TASKS_INVALID', message: '템플릿으로 만든 업무 형식을 저장할 수 없습니다.' } }); return }
    const guestViolation = guestWorkItemViolation(nextWorkItems, accounts, guestGrantOf)
    if (guestViolation) { response.status(400).json({ error: guestViolation }); return }
    const treeViolation = workItemTreeViolation(nextWorkItems, currentWorkItems)
    if (treeViolation) { response.status(400).json({ error: treeViolation }); return }

    const currentConversations = rowsOf(tenantId, 'messenger-conversations')
    if (currentConversations.length + plan.channels.length > 2_000) {
      response.status(409).json({ error: { code: 'MESSENGER_CAPACITY', message: '대화방이 너무 많습니다. 쓰지 않는 방을 정리한 뒤 다시 시도해 주세요.' } })
      return
    }
    const currentRules = rowsOf(tenantId, 'work-rules')
    if (currentRules.length + plan.rules.length > 200) {
      response.status(409).json({ error: { code: 'WORK_RULE_LIMIT', message: '반복 규칙이 너무 많습니다. 쓰지 않는 규칙을 끈 뒤 다시 시도해 주세요.' } })
      return
    }
    const nextRules = normalizeAdminWorkRules([...plan.rules, ...currentRules], tenantId, roster)
    if (!nextRules) { response.status(500).json({ error: { code: 'TEMPLATE_INSTANTIATE_INVALID', message: '템플릿의 반복 규칙을 저장할 수 없습니다.' } }); return }

    // 네 키를 한 번에 커밋하고, 실패하면 네 키를 전부 되돌린다 — 프로젝트만 남고 업무가 없는 상태를 만들지 않는다.
    const tenantStore = workspaceStore.tenants[tenantId] ??= {}
    const snapshot = {
      'project-spaces': tenantStore['project-spaces'],
      'work-items': tenantStore['work-items'],
      'messenger-conversations': tenantStore['messenger-conversations'],
      'work-rules': tenantStore['work-rules'],
    }
    writeProjectData(tenantId, 'project-spaces', [project, ...spaces].slice(0, 500), request.auth.id)
    tenantStore['work-items'] = { data: nextWorkItems, updatedAt: now, updatedBy: request.auth.id }
    if (plan.channels.length) tenantStore['messenger-conversations'] = { data: [...currentConversations, ...plan.channels], updatedAt: now, updatedBy: request.auth.id }
    if (plan.rules.length) tenantStore['work-rules'] = { data: nextRules, updatedAt: now, updatedBy: request.auth.id }
    try {
      await commitWorkspaceStore()
    } catch {
      for (const [key, record] of Object.entries(snapshot)) {
        if (record) tenantStore[key] = record
        else delete tenantStore[key]
      }
      response.status(500).json({ error: { code: 'TEMPLATE_INSTANTIATE_FAILED', message: '템플릿으로 프로젝트를 만들지 못했습니다. 아무것도 저장되지 않았습니다.' } })
      return
    }

    scheduleSentinel(tenantId)
    const workItemsVersion = workspaceRecordVersion(tenantStore['work-items'])
    events.publish(tenantId, 'work', { key: 'work-items', version: workItemsVersion })
    if (plan.channels.length) events.publish(tenantId, 'message', { key: 'messenger-conversations', version: workspaceRecordVersion(tenantStore['messenger-conversations']) })
    // 배정 알림은 사람당 한 건으로 묶인다(bundleAssignmentDrafts). 채널 초대 알림은 보내지 않는다 — 같은 행위의 두 번째 알림이다.
    notifyNewAssignments(request.auth, currentWorkItems, nextWorkItems)

    response.status(201).json({
      project: publicProject(project, [], request.auth),
      workItems: nextWorkItems.slice(0, plan.workItems.length),
      channels: plan.channels,
      rules: nextRules.slice(0, plan.rules.length),
      version: workItemsVersion,
    })
  })
}
