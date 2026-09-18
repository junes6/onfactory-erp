import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { checkLabelFields, collectLabelIssues, LABEL_REQUIRED_COUNT, openLabelMemo, storedLabelStatus, summarizeLabel } from '../src/utils/foodLabelCheck.ts'
import { SALES_PERIODS, isInSalesPeriod, summarizeShipments } from '../src/utils/salesPeriod.ts'
import { daysUntil, deriveComplianceStatus, deriveIpStatus, ipStageOf } from '../src/utils/expiryStatus.ts'
import { DEVELOPER_OPERATIONS_OWNER, UNASSIGNED_OWNER, ticketOwnerOptions } from '../src/utils/ticketOwners.ts'

/**
 * P1-4: 업종 화면이 실데이터가 만든 적 없는 숫자·상태를 보여 주지 않는다(PRODUCT.md §2).
 * 화면 코드는 원문을 읽어 고정 배수·고정 배열·고정 이름이 돌아오지 않았는지 보고,
 * 그 자리를 대신한 계산은 순수 함수로 떼어 실제 값으로 확인한다.
 */
const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const [business, compliance, ipRights, factory, platform] = await Promise.all([
  read('src/components/BusinessPages.tsx'),
  read('src/components/ComplianceCenter.tsx'),
  read('src/components/IpRights.tsx'),
  read('src/components/FactoryManagement.tsx'),
  read('src/components/PlatformConsole.tsx'),
])

const filledProduct = (overrides = {}) => ({
  name: '멸치액젓 500ml',
  storage: '직사광선을 피해 서늘한 곳',
  ...overrides,
  fact: {
    foodType: '액젓',
    ingredients: '멸치 70%, 정제염 30%',
    origin: '멸치: 국산',
    shelfLife: '제조일로부터 24개월',
    barcode: '8801234567890',
    labelIssue: '',
    ...(overrides.fact ?? {}),
  },
})

// ── business-admin-02: 식품 표시사항 점검 ─────────────────────────

test('02 표시사항 칸은 고정 배열이 아니라 칸 점검 결과에서 그린다', () => {
  assert.doesNotMatch(business, /\['원재료명·함량', '알레르기 유발물질', '원산지', '영양정보·보관방법'\]/, '고정 네 칸이 돌아오면 안 된다')
  assert.doesNotMatch(business, /index === 1/, '알레르기 칸에만 경고를 붙이던 분기')
  assert.doesNotMatch(business, /내부 기준과 일치/, '검사하지 않은 칸을 통과로 적던 문구')
  assert.match(business, /const labelChecks = checkLabelFields\(product\)/)
  assert.match(business, /\{labelChecks\.map\(\(item\) => \(/)
})

test('02 규칙 공식을 AI 점수라고 부르지 않고, 필수항목이 찼다고 승인이라 쓰지 않는다', () => {
  assert.doesNotMatch(business, /AI 점수/)
  assert.doesNotMatch(business, /Math\.max\(45, 100 - issues\.length \* 11\)/)
  assert.doesNotMatch(business, /labelScore: score/)
  assert.match(business, /\{labelSummary\.filled\}\/\{labelSummary\.total\}/, '링은 필수항목 N/7을 보여 준다')
  assert.match(business, /<span>필수항목<\/span>/)
  // 검증이 사람의 메모 칸을 덮어쓰지 않는다.
  assert.doesNotMatch(business, /labelIssue: issues\[0\]/)
  // 배지·목록은 저장값('승인')이 아니라 지금 칸 점검에서 만든다.
  assert.doesNotMatch(business, /표시 \$\{product\.labelStatus\}/)
  assert.doesNotMatch(business, /표시 \{product\.labelStatus\}/)
  assert.match(business, /summarizeLabel\(product\)\.label/)
})

test('02 칸 점검: 비어 있는 칸은 칸별로 잡히고, 다 채우면 필수항목 채움이다', () => {
  const empty = checkLabelFields({ name: '', storage: '', fact: { foodType: '', ingredients: '', origin: '', shelfLife: '', barcode: '', labelIssue: '' } })
  assert.equal(empty.length, LABEL_REQUIRED_COUNT)
  assert.equal(LABEL_REQUIRED_COUNT, 7)
  assert.ok(empty.every((item) => !item.ok), '빈 제품은 일곱 칸 모두 문제')
  assert.equal(empty.find((item) => item.id === 'ingredients').note, '비어 있음', '원재료가 비면 원재료 칸이 문제다(전에는 통과로 보였다)')

  const partial = filledProduct({ fact: { ingredients: '   ', barcode: '1234' } })
  const failed = checkLabelFields(partial).filter((item) => !item.ok).map((item) => item.id)
  assert.deepEqual(failed, ['ingredients', 'barcode'])
  assert.deepEqual(summarizeLabel(partial), {
    filled: 5, total: 7, missing: 2, memo: '', complete: false,
    label: '빠진 항목 2개', headline: '표시 필수항목 7개 중 2개가 비어 있거나 형식이 맞지 않습니다.',
  })
  assert.equal(storedLabelStatus(partial), '수정필요')

  const complete = summarizeLabel(filledProduct())
  assert.equal(complete.complete, true)
  assert.equal(complete.label, '필수항목 채움')
  assert.doesNotMatch(complete.label, /승인/)
  assert.equal(storedLabelStatus(filledProduct()), '승인', '홈 점검 목록이 읽는 기존 저장값 계약')
})

test('02 담당자 메모: 사람이 쓴 문제만 열린 메모로 세고, 예전 검증이 남긴 자기 문장은 무시한다', () => {
  assert.equal(openLabelMemo(filledProduct({ fact: { labelIssue: '알레르기 문구 글자 크기 확인' } })), '알레르기 문구 글자 크기 확인')
  for (const cleared of ['수정 항목 없음', '이상 없음', '해당 없음', '현재 확인된 수정 항목이 없습니다.', '표시정보를 입력한 뒤 검증을 실행해 주세요.', '식품유형을 입력해 주세요.', '']) {
    assert.equal(openLabelMemo(filledProduct({ fact: { labelIssue: cleared } })), '', `'${cleared}'는 열린 메모가 아니다`)
  }
  const withMemo = filledProduct({ fact: { labelIssue: '원산지 표기 순서 확인' } })
  assert.deepEqual(collectLabelIssues(withMemo), ['원산지 표기 순서 확인'])
  assert.equal(summarizeLabel(withMemo).label, '담당자 메모 확인')
  assert.equal(storedLabelStatus(withMemo), '수정필요')
})

// ── business-admin-03: 판매채널 기간 숫자 ────────────────────────

test('03 기간 숫자에 고정 배수를 곱하지 않고 출고 주문에서 센다', () => {
  assert.doesNotMatch(business, /factor/, '기간 배수(0.16 · 1 · 4.18)가 돌아오면 안 된다')
  assert.doesNotMatch(business, /0\.16|4\.18/)
  assert.doesNotMatch(business, /channel\.revenue|channel\.orders|channel\.delta/, '채우는 곳이 없는 채널 합계를 화면에 쓰지 않는다')
  assert.match(business, /const periodSummary = useMemo\(\(\) => summarizeShipments\(shipments, period\), \[period, shipments\]\)/)
  assert.match(business, /label: '매출', value: '아직 데이터 없음'/, '결제 금액이 들어오는 길이 없으니 매출은 만들지 않는다')
  assert.match(business, /hasShipments \? `\$\{formatNumber\(periodSummary\.orders\)\}건` : '아직 데이터 없음'/)
})

test('03 기간 집계: 서울 날짜로 자르고, 기간을 넓혀도 곱하지 않고 더 센다', () => {
  const now = new Date('2026-09-18T03:00:00.000Z') // 서울 2026-09-18 12:00
  const shipments = [
    { channelId: 'naver', quantity: 2, orderedAt: '2026-09-18T00:30:00.000Z' }, // 서울 오늘 09:30
    { channelId: 'naver', quantity: 1, orderedAt: '2026-09-17T16:10:00.000Z' }, // 서울 오늘 01:10 (UTC로는 어제)
    { channelId: 'coupang', quantity: 5, orderedAt: '2026-09-17T12:00:00.000Z' }, // 서울 어제 21:00
    { channelId: 'coupang', quantity: 4, orderedAt: '2026-09-12T02:00:00.000Z' }, // 6일 전
    { channelId: 'coupang', quantity: 3, orderedAt: '2026-09-11T02:00:00.000Z' }, // 7일 전 — 7일 창 밖
    { channelId: 'own', quantity: 9, orderedAt: '2026-08-20T02:00:00.000Z' }, // 29일 전
    { channelId: 'own', quantity: 9, orderedAt: '2026-08-19T02:00:00.000Z' }, // 30일 전 — 30일 창 밖
    { channelId: 'own', quantity: 1, orderedAt: '2026-09-19T02:00:00.000Z' }, // 미래
    { channelId: 'own', quantity: 1, orderedAt: 'not-a-date' },
  ]
  const today = summarizeShipments(shipments, 'today', now)
  assert.deepEqual([today.orders, today.units], [2, 3])
  assert.deepEqual(today.byChannel, { naver: { orders: 2, units: 3 } })

  const week = summarizeShipments(shipments, 'week', now)
  assert.deepEqual([week.orders, week.units], [4, 12])
  assert.deepEqual(week.byChannel.coupang, { orders: 2, units: 9 })

  const month = summarizeShipments(shipments, 'month', now)
  assert.deepEqual([month.orders, month.units], [6, 24])

  assert.deepEqual(SALES_PERIODS.map((period) => period.days), [1, 7, 30])
  assert.equal(isInSalesPeriod('not-a-date', 'month', now), false)
  assert.deepEqual(summarizeShipments([], 'month', now), { orders: 0, units: 0, byChannel: {} })
})

// ── business-admin-06: 인증·지식재산 상태 ────────────────────────

test('06 식품안전·인증은 저장된 상태가 아니라 볼 때마다 만료일로 계산한다', () => {
  assert.doesNotMatch(compliance, /function deriveStatus\(/)
  assert.match(compliance, /const records = useMemo\(\(\) => storedRecords\.map\(\(record\) => withLiveStatus\(record, today\)\), \[storedRecords, today\]\)/)
  assert.match(compliance, /deriveComplianceStatus\(record\.expiresAt, record\.attachments\.length, today\)/)
  assert.match(compliance, /const needsAction = records\.filter\(\(record\) => record\.status !== '유효'\)/, '요약·지금 할 일은 계산한 상태를 센다')
})

test('06 식품안전·인증 상태 규칙', () => {
  const today = '2026-09-18'
  assert.equal(deriveComplianceStatus('2027-06-01', 0, today), '보완필요')
  assert.equal(deriveComplianceStatus('2026-09-17', 1, today), '만료', '어제 만료된 것은 다시 저장하지 않아도 만료다')
  assert.equal(deriveComplianceStatus('2026-09-18', 1, today), '갱신예정')
  assert.equal(deriveComplianceStatus('2026-12-17', 1, today), '갱신예정')
  assert.equal(deriveComplianceStatus('2026-12-18', 1, today), '유효')
  assert.equal(deriveComplianceStatus('', 2, today), '보완필요', '검토일을 읽을 수 없으면 정상이라 하지 않는다')
  assert.equal(deriveComplianceStatus('2026-13-40', 2, today), '보완필요')
  assert.equal(daysUntil('2026-09-20', today), 2)
  assert.equal(daysUntil(undefined, today), null)
})

test('06 지식재산은 진행 단계만 사람이 고르고, 등록 뒤 상태는 만료일로 계산한다', () => {
  assert.doesNotMatch(ipRights, /IP_STATUSES/)
  assert.match(ipRights, /\{IP_STAGES\.map\(\(stage\) => <option key=\{stage\}>\{stage\}<\/option>\)\}/)
  assert.match(ipRights, /status: ipStageOf\(field\('status'\)\)/)
  assert.match(ipRights, /const statusOf = \(right: IpRight\) => deriveIpStatus\(right\.status, right\.expiresAt, today\)/)
  assert.match(ipRights, /tone=\{ipTone\(status\)\}>\{status\}<\/StatusBadge>/)
  assert.doesNotMatch(ipRights, /tone=\{ipTone\(right\.status\)\}/, '저장값으로 배지를 칠하지 않는다')

  const today = '2026-09-18'
  assert.equal(deriveIpStatus('등록', '2026-09-06', today), '만료', "'등록' 배지와 '만료 12일 지남'이 한 줄에 같이 나오던 경우")
  assert.equal(deriveIpStatus('등록', '2026-11-17', today), '갱신 필요')
  assert.equal(deriveIpStatus('등록', '2026-11-18', today), '등록')
  assert.equal(deriveIpStatus('등록', '', today), '등록')
  assert.equal(deriveIpStatus('출원', '2020-01-01', today), '출원', '출원·심사 중은 사람이 고른 단계 그대로')
  assert.equal(deriveIpStatus('갱신 필요', '2030-01-01', today), '등록', '예전에 고른 갱신 필요도 날짜가 있으면 날짜가 이긴다')
  assert.equal(deriveIpStatus('만료', '', today), '만료', '날짜가 없으면 예전에 사람이 적어 둔 만료를 존중한다')
  assert.deepEqual(['준비', '출원', '심사 중', '등록', '갱신 필요', '만료', undefined].map(ipStageOf), ['준비', '출원', '심사 중', '등록', '등록', '등록', '준비'])
})

// ── business-admin-09: CS 담당자 선택지 ──────────────────────────

test('09 CS 담당자 선택지에 데모 인물 이름을 박아 두지 않고 기본값은 미배정이다', () => {
  assert.doesNotMatch(platform, /이민지|박하늘|김도윤/)
  assert.match(platform, /<select name="owner" defaultValue=\{UNASSIGNED_OWNER\}>\{ticketOwnerOptions\(supportTickets, operatorName\)/)
  assert.match(platform, /ticketOwnerOptions\(supportTickets, operatorName, ticket\.owner\)/)
  assert.match(platform, /fetch\('\/api\/auth\/session'/, '지금 로그인한 운영자 이름은 세션에서 읽는다')

  assert.deepEqual(ticketOwnerOptions([], '운영자 한결'), [UNASSIGNED_OWNER, '운영자 한결', DEVELOPER_OPERATIONS_OWNER])
  assert.deepEqual(
    ticketOwnerOptions([{ owner: '서지원' }, { owner: '미배정' }, { owner: '  ' }, { owner: '서지원' }], '', '강하루'),
    [UNASSIGNED_OWNER, DEVELOPER_OPERATIONS_OWNER, '강하루', '서지원'],
  )
  assert.equal(ticketOwnerOptions([])[0], '미배정')
})

// ── business-admin-13: 제품 요약 숫자 ────────────────────────────

test('13 제품 요약 칸은 이름과 같은 것을 센다', () => {
  assert.doesNotMatch(business, /product\.status !== '정상'\)\.length/, "'재고 확인'이 운영상태를 세던 계산")
  assert.match(business, /const belowSafetyCount = products\.filter\(isBelowSafetyStock\)\.length/)
  assert.match(business, /function isBelowSafetyStock\(product: Pick<SeaProduct, 'available' \| 'safetyStock'>\) \{\n  return product\.available <= product\.safetyStock\n\}/)
  assert.doesNotMatch(business, /sum \+ product\.channels/, '만들 때 0으로 박힌 뒤 바뀌지 않는 채널 수')
  assert.doesNotMatch(business, /개 채널</)
  assert.doesNotMatch(business, /LOT 위치 확인/, '직원 화면이 제품 수를 재고 연결이라고 부르던 칸')
  assert.doesNotMatch(business, /품질검사로 보류/, '근거 없이 품질검사로 풀어 쓰던 문장')
  assert.doesNotMatch(business, /판매 추세를 반영한/, '판매 추세를 계산하지 않는다')
  assert.doesNotMatch(business, /D-\{detail\.daysToExpire\}/, 'LOT가 없어도 D-0을 보여 주던 칸')
})

// ── business-admin-14: 공장·구역 상태 ────────────────────────────

test('14 공장 구역 상태·주소·이름을 지어내지 않는다', () => {
  assert.doesNotMatch(factory, /state: '대기'/)
  assert.doesNotMatch(factory, /condition: '센서 미연결'|manager: '담당자 미지정'|utilization: 0,/)
  assert.doesNotMatch(factory, /주소 미등록|면적 미등록/)
  assert.doesNotMatch(factory, /'제1공장'| 제1공장`|\$\{index \+ 1\}공장/, '목록 순서로 붙이던 공장 번호')
  assert.doesNotMatch(factory, /operatingCount|warningCount/, "늘 0이던 '정상·확인' 칩")
  assert.match(factory, /return ids\.map\(\(id\) => createCustomerFactory\(companyName, id\)\)/)
  assert.match(factory, /return \{ id, name: `\$\{company\} 공장 \$\{code\}`, code, zones: FACTORY_ZONES \}/)
  assert.match(factory, /const flaggedLocationCount = factoryLocations\.filter\(\(location\) => location\.status === '주의' \|\| location\.status === '점검'\)\.length/)
  assert.doesNotMatch(factory, /'운영 중'/, '블록이 있다는 사실을 공장이 운영 중이라고 부르지 않는다')
})

// ── business-admin-15: 판매채널 연결 설정 · 플랫폼 연동 행 ──────────

test('15 판매채널은 비밀키를 받지 않고, 남아 있던 흔적은 저장할 때 걷어 낸다', () => {
  assert.doesNotMatch(business, /saveChannelCredentials|credentialDraft|type=\{field\.secret \? 'password'/)
  assert.doesNotMatch(business, /label: '(?:Secret Key|Access Key|ADMIN KEY|Client Secret|애플리케이션 Secret)'/)
  assert.doesNotMatch(business, /secret: true/)
  assert.doesNotMatch(business, /연결 상태 점검|runChannelHealthCheck|\/api\/sales-channels\//, '커넥터가 없는 점검 버튼')
  assert.match(business, /const result = await setChannels\(\(current\) => action\(current\)\.map\(withoutCredentialTraces\)\)/)
  assert.match(business, /delete next\.credentialHint\n  delete next\.credentialFields/)
  assert.match(business, /판매자센터와 직접 연결 전/)
  assert.match(business, /주문 CSV 가져오기/)
})

test('15 플랫폼 연동 상태는 갱신되지 않는 자리표시 행을 상태처럼 그리지 않는다', () => {
  assert.doesNotMatch(platform, /healthyIntegrations|scopedIntegrations|exceptionIntegrations/)
  assert.doesNotMatch(platform, /item\.successRate|item\.lastSync/)
  assert.doesNotMatch(platform, /kind: 'diagnostic'|kind: 'reconnect'/)
  assert.match(platform, /label="연동 상태" value="수집 전" note="아직 데이터 없음"/)
  assert.match(platform, /고객사별 연동 상태는 아직 모으지 않습니다/)
})
