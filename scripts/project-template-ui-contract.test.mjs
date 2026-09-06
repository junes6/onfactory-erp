import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * 프로젝트 템플릿 화면 계약(설계서 B절 §4).
 * 브라우저 스모크와 별개로, 소스가 계약을 담고 있는지 여기서 고정한다.
 * - 화면마다 기본 버튼(primary)은 하나다 — 목록은 '새 프로젝트', 상세는 '글 · 파일 올리기', 대화상자·드로어는 자기 층에서 하나.
 * - App은 템플릿을 모른다. 프로젝트 화면이 컴포넌트를 붙이고, 목록 호출은 훅 하나를 지난다.
 * - 업종 분기는 코드에 두지 않는다(자료 분류 목록은 업종 표면에서 읽는다).
 */
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const count = (source, pattern) => (source.match(pattern) ?? []).length

const projectSpaces = await read('src/components/ProjectSpaces.tsx')
const templatePicker = await read('src/components/TemplatePicker.tsx')
const app = await read('src/App.tsx')
const originBadge = await read('src/components/OriginBadge.tsx')
const templateCss = await read('src/components/TemplatePicker.css')
const projectCss = await read('src/components/ProjectSpaces.css')
const templateServer = await read('server/project-templates.mjs')

// 목록 화면은 마지막 return 하나다(그 앞은 상세·게스트 분기). 편집기는 그 뒤에 온다.
const listScreen = projectSpaces.slice(
  projectSpaces.lastIndexOf('return <div className="content-page project-page">'),
  projectSpaces.indexOf('function ProjectEditor('),
)
const detailHeader = projectSpaces.slice(
  projectSpaces.indexOf('<header className="page-header project-detail-header">'),
  projectSpaces.indexOf('<div className="segmented project-detail-tabs"'),
)
// 상세 화면 전체(헤더 + 탭 + 피드). 헤더만 세면 빈 피드의 두 번째 기본 버튼을 놓친다.
// 끝 앵커는 상세 return 뒤에 오는 게스트 분기다 — 같은 문자열이 위쪽 useEffect에도 있어 헤더 뒤부터 찾는다.
const detailHeaderAt = projectSpaces.indexOf('<header className="page-header project-detail-header">')
const detailScreen = projectSpaces.slice(detailHeaderAt, projectSpaces.indexOf('if (guestMode) {', detailHeaderAt))
const projectEditor = projectSpaces.slice(
  projectSpaces.indexOf('function ProjectEditor('),
  projectSpaces.indexOf('function AttachmentPicker('),
)

test('프로젝트 화면은 출처·자료 분류를 받고 템플릿 조각을 붙이기만 한다', () => {
  // 서버가 주는 두 필드. 없으면 배지도 칩도 그리지 않는다.
  assert.match(projectSpaces, /origin\?: ProjectOrigin \| null/)
  assert.match(projectSpaces, /documentCategories\?: string\[\]/)
  // 출처 배지는 상세 제목 옆과 목록 카드에 한 번씩.
  assert.equal(count(projectSpaces, /<ProjectOriginBadge origin=\{detail\.origin\} \/>/g), 1)
  assert.equal(count(projectSpaces, /<ProjectOriginBadge origin=\{project\.origin\} \/>/g), 1)
  // 목록 호출은 훅 하나를 지난다 — 화면이 직접 부르지 않는다(관리자·만들기 모드에서만 켜진다).
  assert.equal(count(projectSpaces, /fetch\('\/api\/project-templates'/g), 0)
  assert.match(projectSpaces, /useProjectTemplates\(workspaceScope, !project && Boolean\(canManage\)\)/)
})

test('프로젝트 화면의 기본 버튼은 화면마다 하나뿐이다', () => {
  // 목록: 헤더 '새 프로젝트' 하나. 빈 상태의 '첫 프로젝트 만들기'는 두 번째 primary라 없앴다(DECISIONS.md:61).
  assert.equal(count(listScreen, /tone="primary"/g), 1)
  assert.doesNotMatch(listScreen, /첫 프로젝트 만들기/)
  // 남은 문구는 템플릿을 실제로 쓸 수 있는 사람에게만 보인다 — 피커도 목록 호출도 관리자에게만 있다.
  assert.match(listScreen, /\{canManage && <small className="project-toolbar-note">템플릿을 고르면 업무·하위 업무·채널이 함께 만들어집니다\.<\/small>\}/)
  // 목록 헤더의 '템플릿'과 상세 헤더의 '템플릿으로 저장'은 보조 행동이다.
  assert.match(listScreen, /<Button tone="secondary" type="button" onClick=\{\(\) => \{ setEditorOpen\(null\); setTemplatesOpen\(true\) \}\}><LayoutTemplate/)
  assert.equal(count(detailHeader, /tone="primary"/g), 1)
  assert.match(detailHeader, /<Button tone="secondary" type="button" onClick=\{\(\) => setSaveTemplateOpen\(true\)\}><LayoutTemplate size=\{17\} \/> 템플릿으로 저장<\/Button>/)
  // 상세도 같은 규칙이다 — 빈 피드의 '첫 글 올리기'는 두 번째 primary라 없앴고, 문구만 남겼다.
  assert.equal(count(detailScreen, /tone="primary"/g), 1)
  assert.doesNotMatch(detailScreen, /첫 글 올리기/)
  assert.match(detailScreen, /위 ‘글 · 파일 올리기’로/)
})

test('만들기 편집기는 템플릿을 고르고 역할을 다 채워야 프로젝트를 만든다', () => {
  assert.equal(count(projectEditor, /<TemplatePicker/g), 1)
  assert.equal(count(projectEditor, /<TemplateRoleMapper/g), 1)
  assert.equal(count(projectEditor, /'프로젝트 만들기'/g), 1)
  // 같은 편집기에서 두 번 눌러도 프로젝트가 둘 생기지 않게 요청 id는 하나로 고정한다.
  assert.match(projectEditor, /clientRequestId: clientRequestId\.current/)
  // 역할이 덜 채워졌으면 만들 수 없다 — 서버도 같은 이유로 거절하므로 화면이 먼저 말해 준다.
  // 고른 템플릿을 아직 못 받은 동안에도 만들지 않는다. 그대로 만들면 템플릿 없는 빈 프로젝트가 조용히 생긴다.
  assert.ok(projectEditor.includes('disabled={busy || name.trim().length < 2 || templatePending || (template !== null && mappedCount < template.roles.length)}'))
  assert.ok(projectEditor.includes("const templatePending = templateId !== '' && template === null"))
  // 막힌 까닭은 눈에 보이고, 기본 버튼이 그 줄을 가리킨다.
  assert.match(projectEditor, /id="project-template-pending"/)
  assert.match(projectEditor, /aria-describedby=\{templatePending \? 'project-template-pending' : undefined\}/)
  // 목록을 못 불러온 사정은 훅에서 그대로 받아 피커로 넘긴다 — '없습니다'로 바꿔 말하지 않는다.
  assert.match(projectEditor, /error: templatesError \} = useProjectTemplates/)
  assert.match(projectEditor, /error=\{templatesError\}/)
  // 템플릿을 바꾸면 앞 템플릿이 채워 넣은 사람도 함께 걷어낸다.
  // setMembers의 함수는 다음 렌더에서 실행된다 — ref를 비우기 전에 명단을 먼저 손에 쥐어야 실제로 걸러진다.
  const seededAt = projectEditor.indexOf('const seeded = roleAddedRef.current')
  const resetAt = projectEditor.indexOf('roleAddedRef.current = new Set()')
  assert.ok(seededAt > -1, '걷어낼 명단을 먼저 붙잡지 않았다')
  assert.ok(resetAt > seededAt, 'ref를 비운 뒤에 명단을 읽으면 아무도 걸러지지 않는다')
  assert.match(projectEditor, /current\.filter\(\(member\) => !seeded\.has\(member\.id\)\)/)
  // '제외'와 역할 매핑이 한 사실을 말한다 — 매핑에 남으면 서버가 그 사람을 편집 멤버로 되살린다.
  assert.match(projectEditor, /setRoleMap\(\(current\) => Object\.fromEntries\(Object\.entries\(current\)\.filter\(\(\[, value\]\) => value !== id\)\)\)/)
  assert.match(projectEditor, /roleAddedRef\.current\.delete\(id\)/)
  // 소유자는 멤버 목록에 다시 넣지 않는다 — 서버가 걸러 내므로 넣으면 '멤버 N명'만 부풀고 지울 수도 없다.
  assert.match(projectEditor, /if \(id === ownerId\) return/)
  // 미리 고른 템플릿으로 열리면 시작일도 함께 채운다(마감의 기준일).
  assert.match(projectEditor, /initialTemplateId \? seoulDateInputValue\(\) : ''/)
})

test('서버에 닿지 못해도 화면이 굳지 않는다', () => {
  // 템플릿 화면의 요청 여섯 자리(초안·템플릿으로 저장·열기·저장·복제·삭제)가 모두 실패를 잡는다.
  assert.match(templatePicker, /const NETWORK_ERROR = '서버에 연결할 수 없습니다\./)
  assert.equal(count(templatePicker, /setError\(NETWORK_ERROR\)/g), 6)
  // 초안을 못 받아도 막다른 길이 아니다 — 다시 불러오기가 있고, 막힌 기본 버튼이 그 까닭을 가리킨다.
  assert.match(templatePicker, /const reloadDraft = useCallback/)
  assert.match(templatePicker, /aria-describedby=\{!draft && error \? 'project-template-save-error' : undefined\}/)
  // 실체화가 실패하면 편집기를 닫지 않는다 — 같은 요청 id로 다시 눌러야 중복이 생기지 않는다.
  assert.match(projectSpaces, /템플릿 서버에 연결할 수 없습니다/)
  assert.match(projectSpaces, /\} finally \{ setBusy\(false\) \}/)
})

test('되풀이·실패·재시도에서 없는 수를 지어내지 않는다', () => {
  // 재시도 응답에는 채널·규칙이 실려 오지 않는다 — 0개라고 부르지 않고 실린 것만 말한다.
  assert.match(projectSpaces, /body\.replayed/)
  assert.match(projectSpaces, /이미 만들어져 있습니다/)
  // 실패를 빈 목록으로 바꾸지 않는다(빈 배열은 '이 회사에 템플릿이 없다'는 사실이다).
  assert.equal(count(templatePicker, /setTemplates\(\[\]\)/g), 0)
  assert.match(templatePicker, /error\?: string/)
  assert.match(templatePicker, /다시 불러오기/)
  // 드로어를 '이 템플릿으로'로 닫으면 처음 열 템플릿 지목도 함께 지운다.
  assert.match(projectSpaces, /setTemplatesOpen\(false\)\s*\n\s*\/\/[^\n]*\n\s*setTemplateInitialId\(undefined\)/)
  // 서버가 알려 준 자리·역할을 문장에 싣는다.
  assert.match(templatePicker, /\$\{error\.path\}/)
  assert.match(projectSpaces, /역할 ‘\$\{error\.role\}’/)
})

test('TemplatePicker는 라디오·전용 라우트·IME 안전 입력 규칙을 지킨다', () => {
  // primary는 두 층에 하나씩: 저장 대화상자 바닥과 관리 드로어 편집 바닥.
  assert.equal(count(templatePicker, /tone="primary"/g), 2)
  // 피커에는 버튼이 없다 — 고르는 일은 라디오가 한다.
  assert.match(templatePicker, /<input type="radio" name="template"/)
  assert.match(templatePicker, /StatusBadge className="status-pill project-origin-badge"/)
  assert.match(templatePicker, /origin\?\.kind === 'template'/)
  // 전용 라우트만 쓴다. generic 저장소 라우트는 서버가 403으로 막는다.
  assert.match(templatePicker, /\/api\/project-templates/)
  assert.equal(count(templatePicker, /\/api\/workspace\/project-templates/g), 0)
  // 업종 분기는 코드에 두지 않는다 — 자료 분류 후보는 업종 표면에서 읽는다.
  assert.equal(count(templatePicker, /industryType\s*===/g), 0)
  assert.match(templatePicker, /useIndustrySurface\(\)/)
  // 없는 것은 없다고 말한다(가짜 0 금지).
  assert.match(templatePicker, /아직 템플릿이 없습니다/)
  assert.match(templatePicker, /아직 수정 이력이 없습니다/)
  // 한글 입력 중의 Enter는 글자를 고르는 중이라 행동으로 읽지 않는다.
  assert.match(templatePicker, /event\.nativeEvent\.isComposing/)
  // 드로어 목록의 행 버튼은 조용한 톤 하나뿐.
  assert.match(templatePicker, /<Button tone="quiet" size="sm" type="button" onClick=\{\(\) => void openTemplate\(template\.id\)\}>열기<\/Button>/)
  // 카드 안에 카드를 두지 않는다.
  assert.equal(count(templatePicker, /<article/g), 0)
  // 이름을 붙인 묶음은 role을 가진다 — 맨 div의 aria-label은 낭독기가 버린다.
  assert.match(templatePicker, /className="project-template-roles" role="group" aria-label/)
  // 하위 업무 key는 서버 상한(24자)을 넘길 수 없다 — 상위 key를 통째로 앞에 붙이지 않는다.
  assert.match(templatePicker, /nextKey\(used, `\$\{task\.key\.slice\(0, KEY_PREFIX_MAX\)\}-c`\)/)
  // React key에 편집 중인 값을 넣지 않는다 — 한 글자마다 input이 새로 만들어져 커서와 한글 조합이 끊긴다.
  assert.equal(count(templatePicker, /key=\{`\$\{channel\.name\}/g), 0)
  assert.equal(count(templatePicker, /key=\{`\$\{category\}/g), 0)
  assert.match(templatePicker, /key=\{`channel-\$\{index\}`\}/)
  assert.match(templatePicker, /key=\{`doc-category-\$\{index\}`\}/)
  // 명부가 오기 전에는 '역할을 채웠다'고 표시하지 않는다 — 표시하면 명부가 온 뒤에도 영영 안 채워진다.
  assert.match(templatePicker, /if \(!staff\.length\) return\s*\n\s*seededRef\.current = template\.id/)
  // 목록을 못 불러온 갈래에도 빠져나갈 길이 있다('템플릿 없이' 라디오가 그 갈래에는 없다).
  assert.match(templatePicker, /템플릿 없이 만들기/)
})

test('App은 템플릿 화면을 모르고, 테넌트 데이터 훅 세 개만 그대로 둔다', () => {
  assert.equal(count(app, /enabled: tenantDataEnabled,/g), 3)
  assert.equal(count(app, /import .*TemplatePicker/g), 0)
})

test('템플릿 CSS는 토큰만 쓰고 버튼 모양을 다시 정의하지 않는다', () => {
  for (const css of [templateCss, projectCss]) {
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i)
    assert.doesNotMatch(css, /\.ui-button\s*\{/)
  }
  // 폭은 기본 클래스를 이겨야 한다 — 같은 특정도면 나중에 실린 styles.css(.workflow-drawer 520px·.modal-card 690px)가 이긴다.
  assert.match(templateCss, /\.workflow-drawer\.project-template-drawer \{ width: min\(720px, 100%\); \}/)
  assert.match(templateCss, /\.modal-card\.project-template-save \{ width: min\(640px, 100%\); \}/)
  assert.equal(count(templateCss, /^\.project-template-drawer \{/gm), 0)
  // 칸 수가 다른 줄은 자기 격자를 가진다(자식 행 4칸·자료 분류 줄 2칸).
  assert.match(templateCss, /\.project-template-children \.project-template-task-row \{/)
  assert.match(templateCss, /\.project-template-line\.is-single \{/)
  // 드로어 목록 줄도 한 줄 원칙을 지킨다 — 규칙 줄과 이력 줄까지.
  assert.match(templateCss, /\.project-template-row small \{[^}]*white-space: nowrap;/)
  assert.match(templateCss, /\.project-template-rule > span \{[^}]*white-space: nowrap;/)
  assert.match(templateCss, /\.project-template-history ol li \{[^}]*white-space: nowrap;/)
  // 배지 말줄임은 글자를 담은 label에 건다 — inline-flex인 배지 자신에게는 text-overflow가 듣지 않는다.
  assert.match(projectCss, /\.project-origin-badge \.unified-status-badge__label \{[^}]*text-overflow: ellipsis;/)
  // 가리키는 요소가 없는 규칙은 두지 않는다(읽는 사람의 시간을 쓴다).
  assert.equal(count(templateCss, /\.project-role-map small \{/g), 0)
  assert.equal(count(templateCss, /\.project-template-foot \.project-template-note \{/g), 0)
})

test('출처 배지 아이콘과 기본 템플릿 상수는 사람 이름을 담지 않는다', () => {
  assert.match(originBadge, /kind === 'template' \? LayoutTemplate/)
  // 기본 템플릿은 코드 상수다 — 계정 id·실명·이메일·비밀번호가 시드로 굳어지면 안 된다.
  assert.doesNotMatch(templateServer, /USR-|@|햇살바다|박지현|김서원|demo1234/)
})
