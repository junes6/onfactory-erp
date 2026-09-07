import { buildSearchText, newBlockId as defaultNewBlockId } from './wiki-blocks.mjs'

/**
 * 기본 문서 템플릿 4종 — 데이터다, 화면이 아니다.
 *
 * 왜 여기에만 어휘를 두는가: 에디터 컴포넌트가 '회의록'·'주간보고' 같은 낱말을 알면 그 컴포넌트는
 * 그 업종의 화면이 된다. 세무 신청서 초안도, 기회 발굴 초안도 같은 에디터에 다른 `documentId`를
 * 물려 재사용해야 한다. 어휘는 이 파일의 상수에만 있고 컴포넌트는 블록만 그린다.
 *
 * 시드에는 실명·계정 id·데모 문자열이 없다 — 템플릿은 모든 테넌트에 같은 모양으로 생긴다.
 * 시드는 `GET /api/wiki`에서 **id별로 없을 때만** 만든다(lazy 멱등). 사용자가 지우면 `archivedAt`이
 * 찍힐 뿐 행은 남으므로 되살아나지 않는다.
 */

export const SYSTEM_TEMPLATE_ORIGIN = Object.freeze({ kind: 'system', label: '기본 템플릿' })

const heading = (id, text, level = 2) => ({ id, type: 'heading', text, level })
const paragraph = (id, text = '') => ({ id, type: 'text', text })
const bullet = (id, text) => ({ id, type: 'bulleted', text, indent: 0 })
const numbered = (id, text) => ({ id, type: 'numbered', text, indent: 0 })
const todo = (id, text) => ({ id, type: 'todo', text, checked: false, indent: 0 })
const quote = (id, text) => ({ id, type: 'quote', text })
const table = (id, rows) => ({ id, type: 'table', rows })

/**
 * 고정 id를 쓰는 이유: 테넌트마다 다른 id로 생기면 "이 문서는 회의록 템플릿에서 왔다"를
 * `templateId` 하나로 물을 수 없고, 시드 멱등도 제목 비교로 내려앉는다.
 */
export const WIKI_TEMPLATE_IDS = Object.freeze({
  MEETING: 'WDOC-TPL-MEETING',
  WEEKLY: 'WDOC-TPL-WEEKLY',
  PLAN: 'WDOC-TPL-PLAN',
  MANUAL: 'WDOC-TPL-MANUAL',
})

export const WIKI_TEMPLATES = Object.freeze([
  Object.freeze({
    id: WIKI_TEMPLATE_IDS.MEETING,
    title: '회의록',
    icon: '🗓️',
    description: '일시·참석자·안건·결정 사항·할 일을 한 장에 남깁니다.',
    blocks: Object.freeze([
      heading('BLK-TPL-MEETING-01', '회의 개요', 2),
      table('BLK-TPL-MEETING-02', [['일시', ''], ['장소', ''], ['참석', ''], ['작성', '']]),
      heading('BLK-TPL-MEETING-03', '안건', 2),
      numbered('BLK-TPL-MEETING-04', ''),
      heading('BLK-TPL-MEETING-05', '결정 사항', 2),
      bullet('BLK-TPL-MEETING-06', ''),
      heading('BLK-TPL-MEETING-07', '할 일', 2),
      todo('BLK-TPL-MEETING-08', ''),
      todo('BLK-TPL-MEETING-09', ''),
      todo('BLK-TPL-MEETING-10', ''),
      quote('BLK-TPL-MEETING-11', '다음 회의: 날짜와 안건을 여기에 적어 둡니다.'),
    ]),
  }),
  Object.freeze({
    id: WIKI_TEMPLATE_IDS.WEEKLY,
    title: '주간보고',
    icon: '📈',
    description: '한 주에 한 장. 한 일·할 일·막힌 것·지표를 같은 자리에 둡니다.',
    blocks: Object.freeze([
      heading('BLK-TPL-WEEKLY-01', '이번 주 한 일', 2),
      todo('BLK-TPL-WEEKLY-02', ''),
      todo('BLK-TPL-WEEKLY-03', ''),
      heading('BLK-TPL-WEEKLY-04', '다음 주 할 일', 2),
      todo('BLK-TPL-WEEKLY-05', ''),
      todo('BLK-TPL-WEEKLY-06', ''),
      heading('BLK-TPL-WEEKLY-07', '막힌 것', 2),
      bullet('BLK-TPL-WEEKLY-08', ''),
      heading('BLK-TPL-WEEKLY-09', '지표', 2),
      table('BLK-TPL-WEEKLY-10', [['지표', '목표', '실적'], ['', '', ''], ['', '', '']]),
    ]),
  }),
  Object.freeze({
    id: WIKI_TEMPLATE_IDS.PLAN,
    title: '기획서',
    icon: '🧭',
    description: '배경부터 위험까지 여섯 칸. 빈 칸이 곧 아직 정하지 않은 것입니다.',
    blocks: Object.freeze([
      heading('BLK-TPL-PLAN-0001', '배경', 2),
      paragraph('BLK-TPL-PLAN-0002', ''),
      heading('BLK-TPL-PLAN-0003', '풀려는 문제', 2),
      paragraph('BLK-TPL-PLAN-0004', ''),
      heading('BLK-TPL-PLAN-0005', '제안', 2),
      paragraph('BLK-TPL-PLAN-0006', ''),
      heading('BLK-TPL-PLAN-0007', '범위', 2),
      table('BLK-TPL-PLAN-0008', [['하는 것', '하지 않는 것'], ['', '']]),
      heading('BLK-TPL-PLAN-0009', '일정', 2),
      table('BLK-TPL-PLAN-0010', [['단계', '기간', '맡는 자리'], ['', '', '']]),
      heading('BLK-TPL-PLAN-0011', '위험과 대비', 2),
      bullet('BLK-TPL-PLAN-0012', ''),
    ]),
  }),
  Object.freeze({
    id: WIKI_TEMPLATE_IDS.MANUAL,
    title: '업무 매뉴얼',
    icon: '📘',
    description: '처음 맡는 사람이 이 한 장으로 따라 할 수 있게 적습니다.',
    blocks: Object.freeze([
      heading('BLK-TPL-MANUAL-01', '목적', 2),
      paragraph('BLK-TPL-MANUAL-02', ''),
      heading('BLK-TPL-MANUAL-03', '준비물', 2),
      bullet('BLK-TPL-MANUAL-04', ''),
      heading('BLK-TPL-MANUAL-05', '절차', 2),
      numbered('BLK-TPL-MANUAL-06', ''),
      numbered('BLK-TPL-MANUAL-07', ''),
      heading('BLK-TPL-MANUAL-08', '주의', 2),
      quote('BLK-TPL-MANUAL-09', '틀리기 쉬운 곳을 여기에 적습니다.'),
      heading('BLK-TPL-MANUAL-10', '문제가 생기면', 2),
      bullet('BLK-TPL-MANUAL-11', ''),
    ]),
  }),
])

export const wikiTemplateById = (id) => WIKI_TEMPLATES.find((template) => template.id === id) ?? null

/**
 * 템플릿 본문을 새 문서에 복사한다. **블록 id를 전부 새로 발급한다** —
 * 같은 블록 id를 공유하면 한쪽 문서의 op이 다른 쪽 문서의 블록을 가리키게 되고,
 * 그 순간 "고치지도 않은 문서가 바뀌었다"가 된다.
 */
export function instantiateTemplateBlocks(template, { newBlockId = defaultNewBlockId } = {}) {
  return (template?.blocks ?? []).map((block) => ({
    ...block,
    id: newBlockId(),
    ...(Array.isArray(block.rows) ? { rows: block.rows.map((row) => [...row]) } : {}),
  }))
}

/**
 * 시스템 템플릿의 문서 레코드. 편집·삭제는 라우트가 409 `WIKI_TEMPLATE_READONLY`로 막는다.
 * `createdById`가 빈 문자열인 것은 사람이 만들지 않았다는 뜻이고, 작성자 예외 판정에 걸리지 않는다.
 */
export function systemTemplateDocument(template, { tenantId, now }) {
  if (typeof now !== 'string') throw new TypeError('systemTemplateDocument: now(ISO 문자열)는 필수 인자입니다.')
  const blocks = template.blocks.map((block, index) => ({
    ...block,
    ...(Array.isArray(block.rows) ? { rows: block.rows.map((row) => [...row]) } : {}),
    seq: index + 1,
    editedById: '',
    editedAt: now,
  }))
  return {
    id: template.id,
    tenantId,
    title: template.title,
    icon: template.icon,
    parentId: null,
    projectId: null,
    spaceId: null,
    blocks,
    version: 1,
    blockSeq: blocks.length,
    tombstones: [],
    recentOpIds: [],
    searchText: buildSearchText(blocks),
    aiLevel: 'indexed',
    summary: template.description,
    summarySource: 'manual',
    writeScope: 'tenant',
    isTemplate: true,
    templateId: null,
    origin: { ...SYSTEM_TEMPLATE_ORIGIN },
    createdById: '',
    createdByName: '',
    createdAt: now,
    lastEditedById: '',
    lastEditedByName: '',
    lastEditedAt: now,
    archivedAt: null,
  }
}

/** 아직 없는 시스템 템플릿만 만든다(lazy 멱등 시드). 지운 템플릿은 행이 남으므로 되살아나지 않는다. */
export function missingSystemTemplates(documents, { tenantId, now }) {
  const present = new Set((documents ?? []).map((document) => document?.id))
  return WIKI_TEMPLATES.filter((template) => !present.has(template.id))
    .map((template) => systemTemplateDocument(template, { tenantId, now }))
}
