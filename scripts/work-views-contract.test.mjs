import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * 목록 보기 전환·필터·저장된 보기·커스텀 필드의 소스 계약(설계서 K절).
 *
 * 여기서 고정하는 것은 '고쳐도 되는 것'과 '고치면 안 되는 것'의 경계다:
 * - 카드 드래그가 상태머신을 우회하는 경로(generic PUT)가 생기지 않는다
 * - 죽은 CSS 이름을 새 뷰가 재사용하지 않는다
 * - 화면 primary는 여전히 둘뿐이고, 필터·툴바·새 뷰에는 하나도 없다
 * - 간트차트를 만들지 않는다 — 아이콘 이름조차 피한다
 */
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const count = (source, pattern) => (source.match(pattern) ?? []).length
/**
 * 주석을 걷어낸 본문. '이 이름을 쓰지 않는다'·'이 속성을 쓰지 않는다'를 단언할 때 쓴다 —
 * 그 규칙을 설명한 주석 자체가 위반으로 잡히면, 다음 사람은 규칙을 지키려고 설명을 지운다.
 */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const app = await read('src/App.tsx')
const switcher = await read('src/components/ViewSwitcher.tsx')
const listView = await read('src/components/WorkListView.tsx')
const calendarView = await read('src/components/WorkCalendarView.tsx')
const filterBar = await read('src/components/WorkFilterBar.tsx')
const savedMenu = await read('src/components/SavedViewMenu.tsx')
const savedDialog = await read('src/components/SavedViewDialog.tsx')
const customFields = await read('src/components/CustomFieldInputs.tsx')
const boardDrop = await read('src/utils/workBoardDrop.ts')
const workViews = await read('src/utils/workViews.ts')
const viewsCss = await read('src/components/WorkViews.css')
const styles = await read('src/styles.css')
const workPage = app.slice(app.indexOf('function WorkPage('), app.indexOf('function InventoryPage('))

test('1. 뷰 스위처는 공용 .segmented 하나를 쓰고 간트라는 말을 쓰지 않는다', () => {
  assert.ok(workPage.length > 0, 'WorkPage 슬라이스가 비면 아래 단언이 조용히 통과한다')
  assert.match(switcher, /className="segmented view-switcher"/)
  assert.match(switcher, /aria-pressed=/)
  assert.equal(count(switcher, /tone="primary"/g), 0)
  for (const source of [switcher, app, listView, calendarView, filterBar, boardDrop, viewsCss]) {
    assert.doesNotMatch(source, /Gantt/i, '간트차트를 만들지 않는다 — 아이콘 이름조차 피한다')
  }
})

test('2. 목록 뷰는 한 줄 원칙을 지키고 죽은 CSS 이름을 재사용하지 않는다', () => {
  assert.match(listView, /className="work-list"/)
  assert.match(listView, /work-list-row/)
  assert.equal(count(listView, /<article/g), 0, '카드 안에 카드를 만들지 않는다')
  assert.equal(count(listView, /tone="primary"/g), 0)
  assert.equal(count(listView, /<SubtaskRows/g), 1, '자식은 세 표면이 이미 쓰는 어휘를 그대로 잇는다')
  for (const dead of ['workflow-row-list', 'workflow-card-list', 'workflow-card-body', 'workflow-summary-strip', 'workflow-stepper']) {
    assert.equal(code(listView).includes(dead), false, `${dead}는 styles.css의 죽은 세대 이름이다`)
    assert.equal(code(viewsCss).includes(dead), false, `${dead}는 styles.css의 죽은 세대 이름이다`)
  }
  // 가짜 0을 만들지 않는다 — 자식이 없으면 진행률 줄 자체가 없다.
  assert.equal(listView.includes("'0%'"), false)

  /*
   * 0건이면 빈 <ul> 하나만 남기지 않는다. 목록은 이 절이 정한 **기본 보기**라(readStoredWorkView의 기본값)
   * 업무가 아직 없는 회사가 화면을 처음 여는 순간이 정확히 이 상태다. 그때 툴바 아래가 통째로 비면
   * 사람은 그것을 '데이터가 사라졌다'로 읽는다 — 조건 때문에 0건인 경우의 문장은 접힌 필터 칸 안에만 있어
   * 접혀 있으면 보이지도 않는다. 다른 세 보기는 전부 빈 상태를 갖는다.
   */
  assert.match(listView, /if \(topLevel\.length === 0\) return <div className="empty-state">/)
  assert.match(listView, /filtered \? WORK_EMPTY_FILTERED_TITLE : '아직 지시된 업무가 없습니다'/)
  assert.match(listView, /업무를 지시하면 여기에 한 줄로 나타납니다\./)
  assert.match(listView, /filtered && onClearFilter && <Button/, '되돌릴 버튼이 그 자리에 있다')
  // 조건 때문에 빈 경우의 두 문장은 타임라인과 같은 상수에서 온다 — 한 절 안에서 두 표면이 다른 말을 하지 않는다.
  assert.match(listView, /import \{ WORK_EMPTY_FILTERED_HINT, WORK_EMPTY_FILTERED_TITLE \} from '\.\.\/utils\/workViews'/)
  assert.equal(listView.includes("'이 조건에 맞는 업무가 없습니다'"), false, '문장을 두 번 적으면 두 곳이 갈라진다')
})

test('3. 캘린더 뷰는 공휴일 한 출처를 쓰고 마감 미정 업무를 버리지 않는다', () => {
  assert.ok(count(calendarView, /dayKind\(/g) >= 1)
  assert.ok(count(calendarView, /holidayName\(/g) >= 1)
  assert.match(calendarView, /import \{ dayKind, holidayName \} from '\.\.\/utils\/koreanHolidays'/)
  assert.match(calendarView, /monthGridKeys/, '격자 규칙을 다시 적지 않고 dateTime.ts의 것을 쓴다')
  assert.equal(count(calendarView, /function monthGridKeys/g), 0)
  assert.equal(calendarView.includes('"calendar-grid"'), false, '일정 화면의 셀 클래스를 나눠 쓰지 않는다')
  assert.equal(calendarView.includes('"calendar-day"'), false)
  assert.match(calendarView, /work-calendar-undated/)
  // 격자에는 행이 있어야 한다 — ARIA에서 columnheader·gridcell은 row가 소유한다.
  // 행이 없으면 스크린리더의 표 탐색이 걸어 다닐 것이 없고, 역할 자체가 무시될 수 있다.
  assert.equal(count(calendarView, /role="row"/g), 2, '요일 머리 한 줄 + 주 단위 한 줄')
  assert.match(calendarView, /weeks\.map\(\(week\) => <div className="work-calendar-row" role="row"/)
  assert.match(viewsCss, /\.work-calendar-row \{ display: contents; \}/, '행 상자는 눈에서만 지운다 — 격자 배치는 그대로다')
  assert.equal(count(calendarView, /new Intl\./g), 0, 'KST 단일 출처는 utils/dateTime.ts 하나다')
  assert.equal(count(calendarView, /\.toLocale/g), 0)
  assert.equal(count(calendarView, /tone="primary"/g), 0)
})

test('4. 필터 바는 입력값을 변형하지 않고 primary를 두지 않는다', () => {
  assert.match(filterBar, /placeholder="이 화면에서 좁히기/)
  // 검색 칸의 onChange는 값을 그대로 넘긴다 — 여기서 자르면 한글 IME 조합이 끊긴다.
  assert.match(filterBar, /onChange=\{\(event\) => set\(\{ text: event\.target\.value \}\)\}/)
  assert.equal(/onChange=\{[^}]*\.trim\(\)/.test(filterBar), false)
  assert.equal(/onChange=\{[^}]*\.replace\(/.test(filterBar), false)
  assert.equal(count(filterBar, /tone="primary"/g), 0)
  // 0건이면 숫자가 아니라 문장이 나온다.
  assert.equal(filterBar.includes("'0건'"), false)
  assert.match(filterBar, /조건에 맞는 업무가 없습니다/)
  // details는 한 곳에서만 열리고 닫힌다 — open만 주고 onToggle을 빼면 화면과 DOM이 갈린다.
  assert.match(filterBar, /<details className="work-filter" open=\{open\} onToggle=/)
  /*
   * 조건이 밖에서 들어오면(저장된 보기·범위 버튼) 접혀 있던 칸이 스스로 펴진다.
   * 칩도 '업무 N건'도 '필터 지우기'도 전부 이 details 안에 있어서, 접힌 채로 조건만 늘면
   * 사람은 짧아진 목록만 보고 '데이터가 사라졌다'고 읽는다. 0 → 양수 전이에서만 편다.
   */
  assert.match(filterBar, /previousCount\.current === 0\) setOpen\(true\)/)

  // '직접'은 값이 아니라 화면 상태다 — 빈 문자열을 filters에 적어 두고 그것으로 판정하면 버튼이 영영 켜지지 않는다.
  assert.match(filterBar, /const \[customOpen, setCustomOpen\] = useState/)
  assert.match(filterBar, /dueQuickId\(filters, customOpen\)/)
  assert.match(filterBar, /applyDueQuick\(filters, id, quick\)/)
  assert.equal(/dueFrom: filters\.dueFrom \?\? ''/.test(filterBar), false, "빈 문자열을 필터에 넣지 않는다")

  // 정렬 축이 화면에 있어야 저장된 보기의 sort가 만들 수 있는 값이 된다.
  assert.match(filterBar, /className="work-filter-sort"/)
  assert.match(filterBar, /onSortChange\(\{ \.\.\.sort, field: event\.target\.value as WorkSortField \}\)/)
  assert.match(filterBar, /aria-pressed=\{sort\.direction === 'asc'\}/)
  assert.match(filterBar, /aria-pressed=\{sort\.direction === 'desc'\}/)
  assert.match(filterBar, /WORK_SORT_FIELD_LABELS\[field\]/, '축 이름은 서버와 대조되는 한 표에서만 나온다')
  assert.match(filterBar, /value=\{`cf:\$\{definition\.key\}`\}/, '커스텀 필드로도 줄을 세울 수 있다')
  /*
   * 정렬 축이 보관되면(또는 정의가 아직 안 도착했으면) 그 값의 option이 하나도 없어져
   * select만 빈 칸이 되고 목록은 여전히 그 축으로 줄을 선다 — 보이는 컨트롤과 실제 순서가 갈린다.
   * 사람 항목 select가 이미 쓰는 탈출구(값에 맞는 option을 남긴다)를 정렬 select에도 둔다.
   */
  assert.match(filterBar, /sort\.field\.startsWith\('cf:'\) && !sortFields\.some/)
  assert.match(filterBar, /\{orphanSortLabel && <option value=\{sort\.field\}>\{orphanSortLabel\}<\/option>\}/)

  // 정렬 칸은 고른 순서가 실제로 보이는 보기에서만 그린다 — 보드·캘린더·타임라인은 각자의 축이 순서를 이미 정한다.
  assert.match(filterBar, /\{!hideSort && <div className="work-filter-sort">/)

  // 커스텀 필드 필터 축은 다섯 타입 중 넷에 생긴다 — 텍스트는 위의 검색 칸이 이미 훑는다.
  for (const branch of ["definition.type === 'select'", "definition.type === 'person'", "definition.type === 'date'"]) {
    assert.ok(filterBar.includes(branch), `${branch} 축이 있어야 한다`)
  }
  assert.match(filterBar, /definition\.type !== 'text'/)
  /*
   * 그 결정을 정당화하는 문장은 참이어야 한다: 검색 칸이 텍스트 항목의 값까지 훑어야
   * 관리자가 만든 '발주번호'·'메모' 항목을 어떤 방법으로든 좁힐 수 있다(축도 없고 검색도 안 걸리면 길이 없다).
   */
  assert.match(workViews, /textFieldKeys\.map\(\(key\) => customFieldValue\(item, key\)/)
  assert.match(filterBar, /placeholder="이 화면에서 좁히기 — 제목·담당·추가 항목"/)
  assert.equal(count(code(filterBar), /type="number"/g), 0, '휠이 지나가기만 해도 값이 바뀐다')
  assert.match(filterBar, /inputMode="decimal"/)

  /*
   * 세는 축과 보이는 축은 같아야 한다. activeFilterCount·describeFilters가 priorities·hasParent를
   * 이미 세고 이름에도 넣으므로, 컨트롤과 칩이 없으면 '필터 N개'와 보이는 칩 수가 어긋나고
   * 개별 해제 버튼이 없는 조건이 생긴다.
   */
  assert.match(filterBar, /aria-label="우선순위로 좁히기"/)
  assert.match(filterBar, /aria-label="상위 업무로 좁히기"/)
  assert.match(filterBar, /key: `priority-\$\{priority\}`/)
  assert.match(filterBar, /key: 'parent'/)
  // 검색어 상한은 maxLength로 막고 onChange에서 자르지 않는다(IME).
  assert.match(filterBar, /maxLength=\{WORK_FILTER_TEXT_MAX\}/)

  /*
   * 상태 문구의 표는 workStatus.ts 하나뿐이다. 이 파일이 짧은 표를 하나 더 들고 있던 동안,
   * 같은 업무가 한 화면에서 행 배지 '확인 기다리는 중'과 필터 칩 '확인 대기' 두 이름으로 불렸다.
   */
  assert.equal(filterBar.includes('STATUS_CHIP_LABEL'), false)
  assert.match(filterBar, /import \{ workStatusLabel \} from '\.\.\/utils\/workStatus'/)
  assert.equal(count(filterBar, /workStatusLabel\(status\)/g), 2, '칩과 세그먼트가 같은 표를 부른다')

  /*
   * 사람 축의 탈출구. 저장된 보기가 실어 온 계정이 디렉터리에서 사라지면(퇴사·삭제) 후보가 없어
   * select가 빈 칸으로 그려지는데 목록은 여전히 그 축으로 걸린 채다 — 보이는 컨트롤과 실제 조건이 갈린다.
   * 값 입력의 사람 select(CustomFieldInputs)와 정렬 select가 이미 쓰는 같은 줄이다.
   */
  assert.match(filterBar, /\{selected && !people\.some\(\(person\) => person\.id === selected\) && <option value=\{selected\}>\{UNKNOWN_ACCOUNT_LABEL\}<\/option>\}/)
})

test('5. 저장된 보기는 관리자 게이트를 disabled가 아니라 aria-disabled로 말한다', async () => {
  assert.equal(count(savedDialog, /tone="primary"/g), 1, '모달 footer의 저장 하나뿐')
  // aria-disabled의 뒷부분이 걸리지 않게 앞 글자를 함께 본다 — 여기서 찾는 것은 진짜 disabled 하나다.
  assert.equal(/name="saved-view-visibility"[\s\S]{0,200}?(?<![\w-])disabled=\{/.test(savedDialog), false, 'disabled는 포커스와 사유를 함께 지운다')
  assert.match(savedDialog, /aria-disabled=\{!canShare\}/)
  assert.match(savedDialog, /회사 전체 공유는 관리자가 만듭니다\./)
  // aria-disabled는 정말로 거절하는 컨트롤에만 붙는다.
  assert.match(savedDialog, /onChange=\{\(\) => \{ if \(canShare\) setVisibility\('tenant'\) \}\}/)
  /*
   * 세는 수·거절하는 수·저장하는 값이 한 함수에서 나온다. 보관된 항목을 실어 온 보기를 열면 체크된 칸이
   * 하나뿐인데 나머지가 전부 '최대 3개'로 거절당하던 화면이 그 셋이 갈라져 있던 자리다.
   * 정의가 아직 안 온 것과 보관된 것은 다른 사실이라, 덜어 내는 것은 보관된 것뿐이다.
   */
  assert.match(savedDialog, /const livePicked = \(list: string\[\]\) => list\.filter\(\(key\) => !archived\(key\)\)/)
  assert.match(savedDialog, /if \(livePicked\(current\)\.length >= MAX_COLUMNS\) return current/)
  assert.match(savedDialog, /const full = livePicked\(picked\)\.length >= MAX_COLUMNS/)
  assert.match(savedDialog, /columns: livePicked\(picked\)/)
  assert.match(savedDialog, /definition\.key === key\.slice\(3\) && definition\.archivedAt/)
  assert.equal(count(savedDialog, /describeFilters\(/g), 1, '이름 자동 제안은 한 곳에서만 만든다')
  assert.match(savedDialog, /!event\.nativeEvent\.isComposing/, '한글 조합 중의 Enter는 글자를 확정하는 키다')
  // 공유는 '회사 전체 보기' 하나뿐 — URL 쿼리스트링을 만들지 않는다.
  assert.equal(count(savedMenu, /URLSearchParams/g), 0)
  assert.match(savedMenu, /내 보기로 복사/, '남의 공유 보기를 덮어쓰려다 403을 받는 막다른 길이 없다')

  /*
   * 이름 상한은 서버와 같은 숫자여야 한다. maxLength는 사람이 치는 글자만 막으므로,
   * 화면이 스스로 넣는 제안 이름과 '사본' 이름을 같은 상수로 자르지 않으면
   * 축이 네댓 개인 조건에서 저장이 400으로 떨어지고 사람이 볼 수 있는 것은 일반 문장 하나뿐이다.
   */
  const savedViewsServer = await read('server/saved-views.mjs')
  const serverMax = savedViewsServer.match(/const MAX_NAME_LENGTH = (\d+)/)?.[1]
  assert.ok(serverMax, '서버의 이름 상한을 찾지 못하면 아래 대조가 조용히 통과한다')
  assert.match(savedDialog, new RegExp(`export const SAVED_VIEW_NAME_MAX = ${serverMax}\\b`))
  assert.match(savedDialog, /\.slice\(0, SAVED_VIEW_NAME_MAX\)/)
  assert.match(savedDialog, /maxLength=\{SAVED_VIEW_NAME_MAX\}/)
  assert.match(savedMenu, /사본`\.trim\(\)\.slice\(0, SAVED_VIEW_NAME_MAX\)/)

  /*
   * 검색어 상한도 같은 갈래다. 81자짜리 filters.text를 담은 보기는 400 path='filters.text'인데
   * 화면은 서버 message만 토스트하므로, 이름 칸도 필터도 멀쩡해 보이는 채 저장만 안 되는 화면이 된다.
   */
  const serverText = savedViewsServer.match(/const MAX_TEXT_LENGTH = (\d+)/)?.[1]
  assert.ok(serverText, '서버의 검색어 상한을 찾지 못하면 아래 대조가 조용히 통과한다')
  assert.match(workViews, new RegExp(`export const WORK_FILTER_TEXT_MAX = ${serverText}\\b`))
})

test('6. 커스텀 필드 입력은 다섯 타입을 모두 그리고 숫자에 type="number"를 쓰지 않는다', async () => {
  for (const type of ["'text'", "'number'", "'select'", "'date'", "'person'"]) {
    assert.ok(customFields.includes(type), `${type} 분기가 있어야 한다`)
  }
  // type="number"는 IME 조합 중 값이 튀고 휠 스크롤로 값이 바뀐다.
  assert.equal(count(code(customFields), /type="number"/g), 0)
  assert.match(customFields, /inputMode=\{definition\.type === 'number' \? 'decimal' : undefined\}/)
  assert.match(customFields, /알 수 없는 계정/, '계정이 사라져도 값을 지우지 않는다')
  assert.match(customFields, /if \(value == null\) return ''/, '값이 없으면 줄 자체를 그리지 않는다')
  assert.equal(count(customFields, /tone="primary"/g), 0)

  /*
   * 정의 목록이 드로어보다 늦게 도착해도 값이 있는 칸이 빈 칸으로 그려지지 않는다.
   * 그 상태에서 '추가 정보 저장'을 한 번 누르면 빈 칸들이 null(= 지우기)로 서버에 가고,
   * 화면이 사람의 조작 없이 값을 지운다 — 알림으로 들어오는 경로에서 결정적으로 일어난다.
   */
  assert.match(customFields, /\}, \[definitions\]\)/, '정의가 도착하면 씨앗을 다시 뿌린다')
  assert.match(customFields, /if \(key in current\) continue/, '입력 중인 칸은 덮어쓰지 않는다')
  assert.match(customFields, /hasOwnProperty\.call\(draft, definition\.key\)\) continue/, '그려진 적 없는 칸은 보내지 않는다')

  // 순서 버튼은 이웃의 자리 번호로 말한다 — ±1은 이웃과 번호가 같아져 목록이 한 칸도 움직이지 않는다.
  assert.match(customFields, /position: neighbour\.position/)
  assert.equal(/position: Math\.max\(0, definition\.position/.test(customFields), false)
  // 409가 실어 보낸 건수·선택지를 버리지 않는다 — 몇 건을 정리해야 하는지가 삭제와 보관을 가른다.
  assert.match(customFields, /payload\.error\?\.count != null/)
  // 값 오류의 key도 같은 규율이다 — 칸이 서너 개인 화면에서 문장만 뜨면 어느 칸인지 알 길이 없다.
  assert.match(customFields, /definitions\.find\(\(definition\) => definition\.key === saved\.key\)\?\.label/)
  /*
   * 정의를 바꾸는 응답이 이미 '바뀐 목록'을 싣고 온다. 그것을 버리고 재조회만 걸면,
   * 응답과 재조회 사이에 누른 두 번째 ↑가 옛 자리 번호로 이웃을 읽어 목록이 한 칸도 움직이지 않는다.
   */
  assert.match(customFields, /if \(onItems && Array\.isArray\(payload\.items\)\) onItems\(payload\.items\)/)

  /*
   * 상한은 서버와 같은 숫자여야 한다. 서버는 셋을 전부 한 문장('형식을 확인해 주세요')으로 답하거나
   * 어느 칸인지를 말하지 못하므로, 화면이 먼저 막지 않으면 사람은 무엇이 길거나 빠졌는지 알 수 없다.
   */
  const customFieldsServer = await read('server/custom-fields.mjs')
  for (const [server, client] of [['MAX_TEXT_VALUE', 'WORK_FIELD_TEXT_MAX'], ['MAX_LABEL', 'CUSTOM_FIELD_LABEL_MAX'], ['MAX_OPTION_LENGTH', 'CUSTOM_FIELD_OPTION_MAX']]) {
    const value = customFieldsServer.match(new RegExp(`const ${server} = (\\d+)`))?.[1]
    assert.ok(value, `서버의 ${server}를 찾지 못하면 아래 대조가 조용히 통과한다`)
    assert.match(customFields, new RegExp(`export const ${client} = ${value}\\b`))
  }
  assert.match(customFields, /maxLength=\{WORK_FIELD_TEXT_MAX\}/)
  assert.match(customFields, /maxLength=\{CUSTOM_FIELD_LABEL_MAX\}/)
  // select인데 선택지가 없으면 서버가 400을 내므로, 그 조합은 애초에 눌리지 않는다.
  assert.match(customFields, /type === 'select' && \(selectOptions\.length === 0/)

  // dl의 콘텐츠 모델은 dt·dd·div뿐이다 — 안내 문장은 dl 밖, section 직계로 둔다.
  const readonlyStart = customFields.indexOf('<dl className="work-field-readonly">')
  assert.ok(readonlyStart > 0, '읽기 전용 갈래를 찾지 못하면 아래 단언이 조용히 통과한다')
  assert.equal(customFields.slice(readonlyStart, customFields.indexOf('</dl>', readonlyStart)).includes('<p'), false)
  // 잠글 것이 하나도 없으면 잠금 문장만 남기지 않는다.
  assert.match(customFields, /if \(locked && !readable\.length\) return null/)

  // JSX는 줄바꿈만 있는 공백을 지운다 — 공백을 명시하지 않으면 '금액선택'·'발주번호보관됨'이 된다.
  assert.equal(count(customFields, /\{definition\.label\}\{' '\}/g), 2, '드로어 라벨과 새 업무 지시 라벨 두 곳')

  /*
   * 보관된 항목에 남은 값을 지울 길이 화면과 서버 양쪽에 있어야 한다.
   * 없으면 관리자에게는 보이는 값이 있는데(드로어가 읽기 전용으로 그린다) 정의는 영영 삭제되지 않는다 —
   * DELETE가 그 값을 세어 409를 내고, 그 409는 이미 한 일('보관하세요')을 다시 시킨다.
   */
  assert.match(customFields, /if \(definition\.archivedAt && next !== null\) continue/)
  assert.match(customFields, /aria-label=\{`\$\{definition\.label\} 값 비우기`\}/)
  assert.match(customFieldsServer, /const definition = clearing \? known\.get\(key\) : active\.get\(key\)/)
  assert.match(customFieldsServer, /previous\.archivedAt \? CUSTOM_FIELD_ERRORS\.IN_USE_ARCHIVED : CUSTOM_FIELD_ERRORS\.IN_USE/)
  // '값 없음'은 한 가지다 — 빈 글자를 값으로 받으면 화면에 없는 값이 삭제를 막는다.
  assert.match(customFieldsServer, /typeof value === 'string' && value\.trim\(\) !== '' \? null/)
})

test('7. 순수 유틸은 날짜 산술을 dateTime.ts에만 맡긴다', async () => {
  const dateTime = await read('src/utils/dateTime.ts')
  for (const name of ['shiftDateKey', 'dayKeyDiff', 'seoulTimeOf', 'monthGridKeys', 'seoulDateInputValue']) {
    assert.equal(count(dateTime, new RegExp(`export function ${name}\\(`, 'g')), 1, `${name}는 KST 단일 출처의 공개 표면이다`)
  }
  // seoulDateKey는 일부러 내보내지 않는다 — 바깥이 부르는 같은 값의 이름은 seoulDateInputValue 하나다.
  assert.equal(count(dateTime, /export function seoulDateKey\(/g), 0)

  assert.equal(count(workViews, /new Intl\./g), 0)
  assert.equal(count(workViews, /\.toLocaleDateString/g), 0)
  assert.ok(count(workViews, /shiftDateKey\(/g) >= 1)
  assert.ok(count(workViews, /seoulDateInputValue\(/g) >= 1)
  // 판정은 한 함수에서만 나온다 — 목록의 '지연'과 막대의 빨강이 같은 사실을 말해야 한다.
  assert.match(workViews, /import \{ isWorkOverdue \} from '\.\/workTimeline\.ts'/)
  assert.equal(count(boardDrop, /subtaskBlockReason\(/g), 1, '하위 차단 문장은 한 곳에서만 만든다')
})

test('7-b. 놓기 전 경고와 서버 409는 글자 그대로 같은 문장을 만든다', async () => {
  // 두 런타임이라 함수는 나뉘지만 문장은 하나여야 한다 — 다르면 사람은 두 가지 일이 일어난 줄 안다.
  // 주석으로만 일치시키면 언젠가 갈린다. 서버 소스의 템플릿을 직접 꺼내 대조한다.
  const server = await read('server/app.mjs')
  const template = '점검 항목 ${remaining.length}건이 남아 있습니다: ${remaining.slice(0, 3).join(\', \')}${remaining.length > 3 ? \' 외\' : \'\'}'
  assert.ok(server.includes(template), '서버 CHECKLIST_INCOMPLETE 템플릿이 바뀌면 이 시험이 먼저 실패해야 한다')
  const client = '점검 항목 ${labels.length}건이 남아 있습니다: ${labels.slice(0, 3).join(\', \')}${labels.length > 3 ? \' 외\' : \'\'}'
  assert.ok(boardDrop.includes(client))
  // 변수 이름만 다르고 문장은 같다.
  assert.equal(template.replaceAll('remaining', 'X'), client.replaceAll('labels', 'X'))
})

test('8. WorkPage는 네 보기를 그리고, 카드 이동은 전이 라우트만 지난다', () => {
  assert.match(workPage, /viewMode === 'board' && <div className="workflow-board"/)
  for (const tag of ['<ViewSwitcher', '<WorkListView', '<WorkCalendarView', '<WorkTimeline', '<WorkFilterBar', '<SavedViewMenu']) {
    assert.equal(count(workPage, new RegExp(tag, 'g')), 1, `${tag}는 정확히 한 번`)
  }
  assert.equal(count(workPage, /tone="primary"/g), 2, '헤더 새 업무 지시 + 드로어 지금 할 일 둘뿐이다')
  // 알림 진입 · 필터 바의 '필터 지우기' · 타임라인 빈 상태 · 목록 빈 상태 — 네 곳이 같은 한 값으로 돌아간다.
  assert.equal(count(workPage, /setFilters\(EMPTY_WORK_FILTERS\)/g), 4)
  assert.match(workPage, /setViewMode\(\(current\) => current === 'rules'/)
  assert.match(workPage, /isTopLevelIn\(item, scopedIds\)/)
  for (const label of ['요청됨', '진행 중', '결재 대기', '완료']) assert.ok(workPage.includes(`label: '${label}'`))
  // 놓기 전에 답한다: 같은 표를 dragOver와 drop 양쪽이 지난다.
  assert.ok(count(workPage, /boardDropAction\(/g) >= 3)
  // 정렬은 저장된 보기에서만 오는 값이 아니다 — 화면에서 고를 수 있어야 한다.
  assert.match(workPage, /sort=\{sort\}/)
  assert.match(workPage, /onSortChange=\{setSort\}/)
  /*
   * 그리고 정렬 칸은 그 순서가 실제로 화면에 나타나는 보기에서만 그린다. 보드는 columnItems가
   * (내 처리 필요, 마감)으로·완료 칼럼은 reviewedAt으로 다시 줄을 세우고, 캘린더는 칸 안을 제목순으로,
   * 타임라인은 groupBars가 막대 위치로 줄을 세운다 — 세 곳 모두 고른 정렬이 화면을 움직이지 않는다.
   */
  assert.match(workPage, /hideSort=\{viewMode !== 'list'\}/)
  // 텍스트 항목의 값이 검색에 걸리려면 그 키 목록이 필터로 흘러가야 한다.
  assert.match(workPage, /applyWorkFilters\(items, filters, currentUserId, undefined, textFieldKeys\)/)
  assert.match(workPage, /definitions\.filter\(\(definition\) => definition\.type === 'text'\)/)
  // 잡은 카드가 목록에서 사라질 수 있다. 렌더 경로의 non-null 단언은 화면 전체를 빈 화면으로 만든다.
  assert.match(workPage, /const grabbedItem = grabbedId \? items\.find/)
  assert.equal(/boardDropAction\(items\.find\([^)]*\)!/.test(workPage), false)
  assert.match(workPage, /onDragOver=\{\(event\) => \{/)
  assert.match(workPage, /onDrop=\{\(event\) => \{/)
  assert.ok(count(workPage, /dropEffect = 'none'/g) >= 1)
  assert.match(workPage, /setDialog\(\{ type: 'completion', item \}\)/)
  assert.match(workPage, /event\.stopPropagation\(\); action\.run\(\)/)
  assert.match(workPage, /id="workflow-board-drag-status"/)
  assert.match(workPage, /aria-live="polite" id="workflow-board-drag-status"/)
  // 상태를 바꾸는 generic PUT은 한 번도 없다 — 있으면 관리자 계정에서 상태머신이 통째로 우회된다.
  assert.equal(workPage.includes("'/api/workspace/work-items'"), false)
  // 기간 바꾸기는 타임라인 한 곳에서만 부모의 핸들러로 이어진다(드로어의 '적용'은 같은 함수를 직접 부른다).
  assert.equal(count(workPage, /onSchedule=\{onSchedule\}/g), 1)
  assert.equal(count(app, /\/fields`/g), 1, '값 편집의 문은 하나다')
  assert.equal(count(app, /\/schedule`/g), 1)

  /*
   * 칼럼에 aria-disabled를 붙이지 않는다. listitem은 그 상태를 지고 갈 수 있는 역할이 아니라
   * 보조기술이 무시한다 — 역할이 담을 수 없는 상태를 마크업이 주장하면 '아리아는 정확히'가 무너진다.
   * 같은 사실은 이미 눈(is-blocked·칼럼 머리의 사유)과 귀(#workflow-board-drag-status)로 간다.
   */
  assert.equal(count(code(workPage), /aria-disabled/g), 0)

  /*
   * '카드 옮기기'가 켜졌다고 말하는 문장은 그 화면에서 참이어야 한다. 담당자도 지시자도 아닌 사람의
   * 화면에서는 카드마다 draggable=false이고 grip도 그려지지 않는다 — 그때 '끌 수 있습니다'는 거짓말이다.
   */
  assert.match(workPage, /const draggableCount = scoped\.filter\(\(item\) => boardDropTargets\(item, currentUserId, items\)\.length > 0\)\.length/)
  assert.match(workPage, /지금 화면에는 옮길 수 있는 카드가 없습니다\./)

  /*
   * 프로젝트 이름을 못 받았을 때 '프로젝트 미지정'이라 적지 않는다. 그 option의 값은 **진짜 프로젝트 id**라서
   * 고르면 그 프로젝트의 업무만 걸리는데, 라벨은 정반대를 말하게 된다(이름 없는 것이 둘이면 같은 줄이 겹치기도 한다).
   * '미지정'은 projectId가 **없는** 묶음의 이름이고, 그 판단은 타임라인과 같은 한 함수가 한다.
   */
  assert.match(workPage, /label: projectBarLabel\(id, projectNames\)/)
  assert.equal(workPage.includes("'프로젝트 미지정'"), false, '두 사실이 한 문자열로 겹치지 않는다')
  // 세는 축(activeFilterCount)에 있는 출처는 이름표에도 있어야 이름 제안이 그 조건을 말한다.
  assert.match(workPage, /origins: Object\.fromEntries\(filterOrigins\.map/)

  /*
   * 마지막에 보던 보기는 localStorage를 렌더마다 다시 읽지 않는다 — useRef의 인자는 React가 매 렌더
   * 평가하고 첫 렌더 뒤에는 버린다. 검색어 한 글자·dragover 한 번마다 동기 읽기가 한 번씩 더 붙던 자리다.
   */
  assert.equal(count(workPage, /readStoredWorkView\(/g), 1, '읽는 곳은 useState의 게으른 초기화 하나뿐이다')
  assert.match(workPage, /useRef<WorkViewMode>\(viewMode === 'rules' \? 'list' : viewMode\)/)

  /*
   * 사람 항목의 후보는 서버가 실제로 받는 집합과 같다. /api/directory는 플랫폼 운영자 계정을 kind 없이
   * 맨 앞에 얹는데, 서버는 그 계정을 사람 항목에 넣으면 400 CUSTOM_FIELD_PERSON으로 거절한다 —
   * 고를 수는 있는데 저장은 언제나 실패하는(그리고 필터 축에서는 언제나 0건인) 후보를 내놓지 않는다.
   */
  assert.match(workPage, /assignees\.filter\(\(assignee\) => assignee\.kind === 'employee'\)/)
  assert.match(app, /\.\.\.\(member\.kind \? \{ kind: member\.kind \} : \{\}\)/, '서버가 준 kind를 버리지 않는다')

  // 접힌 줄은 안에 있는 것을 빠짐없이 센다 — 관리자가 만든 항목이 그 안에서 그려진다.
  assert.match(app, /선택 항목 <span>시작일 · 우선순위 · 완료 기준 · 첨부 · 상위 업무\{definitions\.some\(\(definition\) => !definition\.archivedAt\) \? ' · 추가 항목' : ''\}<\/span>/)
})

test('8-b. 고른 보기의 이름은 조건과 같은 자리에 살고, 앱이 조건을 지울 때 함께 떨어진다', () => {
  /*
   * 한 뿌리(activeId가 자식 안에 살았다)에서 두 사고가 나왔다:
   * (1) 알림·전역검색으로 업무 상세에 들어가면 앱이 스스로 필터를 지우는데 이름은 남아서,
   *     사람이 손대지 않은 조건 삭제가 '변경됨'이 되고 '변경 저장'이 그 보기를 빈 조건으로 덮어썼다.
   * (2) '반복 규칙' 탭에서 메뉴가 언마운트되면 조건은 살아 있는데 이름만 사라져,
   *     select는 '기본 보기'라고 말하면서 저장된 보기의 조건이 걸린 화면이 됐다.
   */
  assert.match(workPage, /const \[activeViewId, setActiveViewId\] = useState\(''\)/)
  assert.match(workPage, /activeId=\{activeViewId\}/)
  assert.match(workPage, /onActiveIdChange=\{setActiveViewId\}/)
  assert.equal(/const \[activeId, setActiveId\] = useState/.test(savedMenu), false, '자식은 그 값을 더 이상 자기 안에 두지 않는다')
  assert.match(savedMenu, /const setActiveId = onActiveIdChange/)

  // 필터를 떼는 문과 이름을 떼는 문은 같은 effect 안에 있다 — 둘은 한 동작이다.
  const focusEffect = workPage.slice(workPage.indexOf('handledFocusRef.current = focusId'), workPage.indexOf('setDrawerId(focused.id)'))
  assert.ok(focusEffect.length > 0, '진입 effect를 찾지 못하면 아래 단언이 조용히 통과한다')
  assert.ok(focusEffect.includes('setFilters(EMPTY_WORK_FILTERS)'))
  assert.ok(focusEffect.includes("setActiveViewId('')"), '앱이 스스로 지운 필터는 dirty가 아니다')

  // 목록이 도착하기 전의 빈 배열로 선택을 풀지 않는다 — 규칙 탭 왕복이 그 창을 매번 만든다.
  assert.match(savedMenu, /if \(loaded && activeId && !views\.some/)
  assert.match(savedMenu, /setViews\(items\); setLoaded\(true\)/)
})

test('8-c. 놓은 칼럼과 열리는 모달은 같은 결정을 가리킨다', () => {
  /*
   * 결재대기 카드를 '진행 중'에 놓는 것은 보완 요청이고, 화면은 놓기 전에 그렇게 말한다
   * (칼럼 머리와 #workflow-board-drag-status 둘 다 '진행 중(으)로 옮깁니다.').
   * 그런데 모달이 언제나 승인으로 열리면, 가장 마찰이 적은 버튼('승인 완료'는 코멘트 없이도 제출된다)이
   * 사람이 놓은 칼럼의 **반대**이고 그 결과는 되돌릴 수 없다 — 결재완료 카드는 어디로도 옮길 수 없다(CLOSED).
   * 키보드 경로(grip → 방향키 → Enter)도 같은 runBoardDrop을 지나므로 한 자리만 고치면 둘 다 닫힌다.
   */
  assert.match(app, /type: 'review'; item: WorkItem; decision: 'approve' \| 'request-changes'/)
  assert.match(workPage, /setDialog\(\{ type: 'review', item, decision: drop\.action === 'approve' \? 'approve' : 'request-changes' \}\)/)
  assert.match(workPage, /initialMode=\{dialog\.decision\}/)
  // 결정 없이 검토 모달을 여는 자리가 하나라도 남으면 그 경로만 조용히 승인으로 열린다.
  assert.equal(/setDialog\(\{ type: 'review', item \}\)/.test(app), false)
  assert.match(app, /useState<'approve' \| 'request-changes'>\(initialMode \?\? 'approve'\)/)
  // 모달 안에서 결정을 바꾸는 길은 그대로 남는다 — 검토는 확인만 하는 화면이 아니라 결정하는 화면이다.
  assert.match(app, /role="radiogroup" aria-label="검토 결정"/)
  assert.match(workPage, /if \(drop\.kind === 'action'\) runBoardDrop\(item, drop\)/, '키보드 확정도 같은 함수를 지난다')
})

test('8-d. 새 업무 지시의 값 거절도 어느 칸인지 말한다', async () => {
  /*
   * 배열 PUT의 400은 `{ code, key, itemId }`로 어느 항목이 거절됐는지 싣고 온다. 공용 오류 채널이 그 key를
   * 버리던 동안, 추가 항목이 네 칸 그려진 모달에서 '항목 형식에 맞지 않는 값입니다.' 한 줄만 떴다.
   * 문장은 서버 것 하나 그대로 두고, key만 라벨로 바꿔 괄호로 붙인다 — 드로어(CustomFieldEditor)와 같은 형태다.
   */
  const workspaceHook = await read('src/hooks/useWorkspaceState.ts')
  assert.match(workspaceHook, /if \(typeof body\.error\?\.key === 'string'\) errorKey = body\.error\.key/)
  assert.equal(count(workspaceHook, /key: errorKey/g), 2, '두 실패 갈래가 같은 값을 들고 나간다')
  assert.match(app, /return \{ ok: false, message: result\.message, key: result\.key \}/)
  const taskModal = app.slice(app.indexOf('function TaskModal('), app.indexOf('function SupportSessionModal('))
  assert.ok(taskModal.length > 0, 'TaskModal 슬라이스가 비면 아래 단언이 조용히 통과한다')
  assert.match(taskModal, /const label = saved\.key \? definitions\.find\(\(definition\) => definition\.key === saved\.key\)\?\.label : ''/)
  assert.match(taskModal, /if \(saved\.message && label\) setError\(`\$\{saved\.message\} \(\$\{label\}\)`\)/)
})

test('9. 새 훅은 App 최상위를 늘리지 않고 각 컴포넌트 안에서 부른다', () => {
  assert.equal(count(app, /enabled: tenantDataEnabled,/g), 3)
  assert.equal(app.includes("fetch('/api/saved-views'"), false)
  assert.equal(app.includes("fetch('/api/custom-fields'"), false)
  assert.match(savedMenu, /fetch\(`\/api\/saved-views\?surface=/)
  assert.match(customFields, /fetch\('\/api\/custom-fields\?surface=work'/)
})

test('10. 키보드 대안과 터치 게이트가 함께 있다', () => {
  assert.match(workPage, /aria-keyshortcuts="ArrowLeft ArrowRight Enter Escape"/)
  assert.match(workPage, /aria-label=\{`\$\{item\.title\} 단계 옮기기`\}/)
  // 카드 onKeyDown 가드가 grip 이벤트를 막지 못하므로 grip 쪽에서 명시적으로 멈춘다.
  assert.match(workPage, /event\.stopPropagation\(\); toggleGrab\(item\)/)
  assert.match(workPage, /window\.matchMedia\('\(max-width: 760px\), \(pointer: coarse\)'\)/)
  assert.match(workPage, /boardDragMode && !coarsePointer/)
})

test('11. 새 CSS는 토큰만 쓰고 버튼 모양을 정의하지 않는다', () => {
  assert.doesNotMatch(viewsCss, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(viewsCss, /\.ui-button\s*\{/)
  // tokens.css에 없는 토큰을 쓰면 색이 조용히 사라진다.
  assert.equal(viewsCss.includes('--color-gray-300'), false)
  for (const token of ['--timeline-name', '--timeline-cell', '--timeline-row']) assert.ok(viewsCss.includes(token))
  assert.match(viewsCss, /@media \(max-width: 760px\)/)
  assert.match(viewsCss, /pointer: coarse/)
  assert.match(viewsCss, /\.work-list-row/)
  assert.match(viewsCss, /\.work-calendar-day/)
  assert.match(viewsCss, /\.work-filter/)
  // 드롭 하이라이트는 styles.css에 세 줄만 더한다 — .workflow-board grid 선언은 건드리지 않는다.
  assert.match(styles, /\.workflow-column\.is-drop-target \{ background: var\(--color-primary-soft\); \}/)
  assert.match(styles, /\.workflow-column\.is-blocked \{ background: var\(--color-danger-soft\); cursor: not-allowed; \}/)
  assert.match(styles, /\.workflow-card\.is-dragging \{ opacity: \.5; \}/)
  /*
   * 거절 사유는 끝까지 읽혀야 한다. 칼럼 머리의 <small>은 한 줄로 잘리는데(평소의 안내는 짧다) 사유는
   * 두 문장이라 절반만 보였고, HTML5 드래그 중에는 title 툴팁이 뜨지 않으며 aria-live는 sr-only다 —
   * '대신 무엇을 하면 되는지'를 말하는 두 번째 문장이 마우스 사용자에게 어느 경로로도 닿지 않았다.
   */
  assert.match(styles, /\.workflow-column\.is-blocked \.workflow-column-head small \{ overflow: visible; text-overflow: clip; white-space: normal; \}/)
})

test('12. 자료실·기회는 정렬만 얻는다 — 상태축이 없는 목록에 보드를 만들지 않는다', async () => {
  const library = await read('src/components/CompanyLibrary.tsx')
  const opportunity = await read('src/components/OpportunityWatch.tsx')
  assert.match(library, /className="library-sort"/)
  assert.equal(library.includes('<ViewSwitcher'), false)
  assert.equal(library.includes('<WorkFilterBar'), false)
  assert.match(opportunity, /className="opportunity-below-sort"/)
  assert.equal(opportunity.includes('<ViewSwitcher'), false)
  assert.equal(opportunity.includes('<SavedViewMenu'), false)
  // 대상 집합은 바뀌지 않는다 — 정렬은 순서만 바꾼다.
  assert.match(opportunity, /state\.opportunities\.filter\(\(item\) => item\.status === 'below-threshold'\)/)
})
