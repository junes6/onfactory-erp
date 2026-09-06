import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * 외부 연동 화면 계약(설계서 L절 §6·§7).
 *
 * 브라우저 스모크는 사람이 하지만, 여기서 잠그는 것은 문장으로 되돌아오지 않는 것들이다.
 *  - 이 화면은 관리자에게만 존재한다(탭 선언·버튼·패널 세 곳이 모두 같은 조건).
 *  - 평문 비밀값은 state 밖으로 나가지 않는다(localStorage 접근 0건).
 *  - 영문 사건 id를 사람에게 보여 주지 않는다.
 *  - 어댑터가 없는 채널의 열은 아예 그리지 않는다.
 *  - 가짜 0을 그리지 않는다(빈 목록·빈 기록은 문장으로 답한다).
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const people = await read('src/components/PeopleOperations.tsx')
const settings = await read('src/components/WebhookSettings.tsx')
const settingsCss = await read('src/components/WebhookSettings.css')
const notifications = await read('src/components/NotificationCenter.tsx')
const notificationsCss = await read('src/components/NotificationCenter.css')
const app = await read('src/App.tsx')

const count = (source, pattern) => (source.match(pattern) ?? []).length

test('외부 연동 탭은 선언·버튼·패널 세 곳이 모두 관리자 조건 아래에 있다', () => {
  assert.match(people, /type PeopleTab = [^\n]*\| 'integrations'/)
  assert.match(people, /\{canManage && <button type="button" role="tab" aria-selected=\{tab === 'integrations'\}/)
  assert.match(people, /\{canManage && tab === 'integrations' && <section className="people-content-card" role="tabpanel"><WebhookSettings /)
  // 게스트 계약이 글자 그대로 고정한 modal union은 건드리지 않았다.
  assert.match(people, /'guest-invite' \| 'guest-scope'/)
  // 페이지 헤더의 primary는 여전히 '구성원 초대' 하나다 — 화면당 primary 하나.
  const header = people.match(/<div className="page-header-actions">[\s\S]*?<\/div>/)?.[0] ?? ''
  assert.equal(count(header, /tone="primary"/g), 1, '헤더의 primary는 하나뿐이다')
})

test('스스로 멈춘 연동의 수가 탭 이름표에 상시로 남는다 — 알림 한 번을 놓쳐도 보인다', () => {
  // 옆 탭(계정·권한)과 같은 모양이다. 0이면 그리지 않는다 — 가짜 0을 만들지 않는다.
  assert.match(people, /외부 연동 \{stoppedWebhooks > 0 && <em>\{stoppedWebhooks\}<\/em>\}/)
  assert.match(people, /\.filter\(\(item\) => item\?\.disabledAt\)\.length/)
  // 탭을 나올 때 다시 센다. 고쳐 놓은 연동의 배지가 남으면 그 숫자는 소음이다.
  assert.match(people, /\}, \[canManage, workspaceScope, integrationsOpen\]\)/)
  // 못 읽은 것을 '멈춘 것이 없다'로 말하지 않는다 — 배지를 그리지 않는 쪽으로 접는다.
  assert.match(people, /\.catch\(\(\) => \{ if \(active\) setStoppedWebhooks\(0\) \}\)/)
})

test('WebhookSettings의 primary는 대화상자 저장 하나뿐이다', () => {
  assert.equal(count(settings, /tone="primary"/g), 1)
  assert.ok(count(settings, /tone="secondary"/g) >= 1)
  // 저장 버튼은 aria-disabled로 막고 handler가 실제로 거절한다 — 초점과 사유가 남는다.
  assert.match(settings, /aria-disabled=\{blockedByKey \|\| busy !== ''\}/)
  assert.match(settings, /if \(blockedByKey\) \{ onToast\(feed\?\.secretBoxMessage/)
  // 만들기의 경로는 빈 문자열이고 그것이 곧 놀고 있음의 값이다. 그대로 표식으로 쓰면 만드는 동안에만
  // 잠금이 풀려, Enter 두 번이 연동 둘을 만들고 두 번째의 서명 비밀키는 아무도 본 적이 없게 된다.
  assert.match(settings, /setBusy\(path \|\| 'create'\)/)
  assert.doesNotMatch(settings, /\n\s*setBusy\(path\)\n/)
})

test('가짜 0을 그리지 않고, 한 번만 보이는 값은 화면에 저장하지 않는다', () => {
  assert.match(settings, /아직 연결된 외부 시스템이 없습니다/)
  assert.match(settings, /아직 보낸 기록이 없습니다/)
  assert.match(settings, /이 창을 닫으면 다시 볼 수 없습니다\./)
  // 주석으로는 규칙을 적되, 실제 접근은 한 건도 없어야 한다.
  assert.doesNotMatch(settings, /localStorage\s*[.[]/, '평문 비밀값이 브라우저에 남으면 안 된다')
  // 없는 것과 걸러진 것을 구분한다 — 필터가 비었을 때 '없습니다'라고 말하면 거짓말이 된다.
  assert.match(settings, /feed && feed\.endpoints\.length === 0 &&/)
  assert.match(settings, /feed && feed\.endpoints\.length > 0 && endpoints\.length === 0 &&/)
  assert.match(settings, /이 조건에 맞는 연동이 없습니다\./)
  assert.match(settings, /feed && feed\.deliveries\.length === 0 &&/)
  assert.match(settings, /feed && feed\.deliveries\.length > 0 && deliveries\.length === 0 &&/)
  // 범위를 말하지 않는 '없습니다'는 재지 않은 것까지 없다고 하는 문장이다.
  // 반대도 마찬가지다 — 서버가 전부 걸러 답한 뒤에 '최근 N건 안에는'이라고 물러서면
  // 있지도 않은 실패를 찾아 나서게 만든다. 두 문장이 잰 범위에 따라 갈린다.
  assert.match(settings, /serverFiltered \? '이 상태의 기록이 없습니다\.' : `최근 \$\{logScope\}건 안에는 이 상태의 기록이 없습니다\.`/)
})

test('상태로 거르면 화면이 아니라 서버가 찾는다 — 최근 100건 뒤의 실패를 없다고 하지 않는다', () => {
  assert.match(settings, /fetch\(`\/api\/webhooks\/deliveries\?status=\$\{encodeURIComponent\(statusFilter\)\}&limit=\$\{DELIVERY_PAGE\}`/)
  assert.match(settings, /const serverFiltered = statusFilter !== 'all' && statusRows !== null/)
  // 못 읽었을 때는 빈 목록으로 바꾸지 않고, 무엇을 보고 있는지 문장으로 밝힌다.
  assert.match(settings, /최근 100건만 보고 있습니다\./)
})

test('받을 곳 고르개는 서버가 받아 주는 것만 보여 주고, 지워진 채널을 감추지 않는다', () => {
  assert.match(settings, /\(room\.lifecycle \?\? 'active'\) === 'active'/)
  assert.match(settings, /지워진 채널/)
  assert.match(settings, /받을 곳을 다시 골라야 저장할 수 있습니다\./)
  // 목록이 아직 오지 않았을 때 '지워졌다'고 말하지 않는다.
  assert.match(settings, /&& optionsReady && !rooms\.some\(\(room\) => room\.id === form\.conversationId\)/)
})

test('전달 기록의 응답 칸은 코드와 사유를 함께 남긴다', () => {
  assert.match(settings, /className="webhook-log-reason"/)
  assert.match(settings, /\.filter\(Boolean\)\.join\(' · '\) \|\| '—'/)
  assert.match(settingsCss, /td\.webhook-log-reason \{ white-space: normal; \}/)
})

test('아직 보내지 않은 테스트에 사유를 지어내지 않는다', () => {
  assert.match(settings, /if \(result\.queued\) \{ setTestResult\('보내는 중입니다\./)
})

test('한글 조합 중의 Enter는 저장이 아니라 글자 확정이다 — 가드에 지킬 것이 있다', () => {
  // 가드가 막을 대상이 실제로 있어야 한다: 본문이 form이고 Enter가 저장으로 이어진다.
  assert.match(settings, /<form className="webhook-form" onSubmit=\{\(event\) => \{ event\.preventDefault\(\); void save\(\) \}\}>/)
  assert.match(settings, /tone="primary"\s*\n\s*type="submit"/)
  assert.equal(
    (settings.match(/if \(event\.key === 'Enter' && event\.nativeEvent\.isComposing\) event\.preventDefault\(\)/g) ?? []).length,
    2,
    '이름·보낼 주소 두 입력칸 모두에서 조합 중 Enter가 저장을 부르지 않는다',
  )
})

test('대화상자는 초점을 가두고, 닫으면 연 버튼으로 돌려준다', () => {
  // form 객체를 의존성에 두면 글자를 칠 때마다 대화상자가 초점을 도로 가져간다.
  assert.match(settings, /\}, \[dialogKey\]\)/)
  assert.doesNotMatch(settings, /\}, \[form, revealed\]\)/)
  assert.match(settings, /triggerRef\.current = trigger/)
  assert.match(settings, /trigger\?\.focus\(\)/)
  assert.match(settings, /if \(event\.key === 'Tab' && node\)/)
})

test('영문 사건 id를 사람에게 그대로 보여 주지 않는다', () => {
  assert.doesNotMatch(settings, />work\.transitioned<|>notice\.posted</)
  assert.match(settings, /const eventLabel = \(id: string\) => feed\?\.events\.find/)
  // 서버가 준 label을 먼저 쓰고, 없을 때만 사전을 본다 — 두 벌이 갈라지지 않게 순서를 고정한다.
  assert.match(settings, /EVENT_LABELS\[id\] \?\? id/)
})

test('막힌 이유의 문장은 서버가 한 벌로 보낸다 — 화면이 따로 짓지 않는다', () => {
  assert.match(settings, /\{feed\.secretBoxMessage\}/)
  assert.doesNotMatch(settings, /SECRET_BOX_KEY/, '같은 뜻의 문장을 화면이 다시 쓰면 한쪽만 고쳐도 갈라진다')
  // 걸러진 행이 있다는 사실도 같은 자리에 같은 문장으로 온다. 목록만 멀쩡하고 쓰기만 막히면
  // 관리자는 그 둘을 이을 단서를 화면에서 찾지 못한다.
  assert.match(settings, /\{feed\?\.dataIssueMessage && <p className="webhook-note" role="status">\{feed\.dataIssueMessage\}<\/p>\}/)
  assert.doesNotMatch(settings, /형식이 깨진/, '그 문장도 서버 한 벌이다')
  // 이름이 비었다는 사실도 마찬가지다. 화면이 먼저 거절하면 서버의 '이름은 1~60자로 적어 주세요.'가
  // 이 화면에서 영영 닿지 않는 자리가 되어, 두 문장이 갈라져도 아무도 모른다.
  assert.doesNotMatch(settings, /연동 이름을 적어 주세요/)
})

test('알림 설정 표의 열은 서버가 준 채널 목록에서 나온다 — 화면이 채널 이름을 알지 못한다', () => {
  // 채널 이름을 화면에 박아 두면 채널 하나를 늘리는 데 이 파일이 함께 바뀌어야 한다.
  // 그러면 '어댑터 하나 + 환경변수 하나'라는 약속이 거짓이 된다.
  assert.doesNotMatch(notifications, /feed\.channels\?\.(kakao|email)/)
  assert.doesNotMatch(notifications, /feed\.settings\.(kakao|email)/)
  assert.equal(count(notifications, /channels\.map\(\(channel\) =>/g), 3, '열 제목 · 칸 · 안내 문장')
  assert.match(notifications, /const channels: ChannelMeta\[\] = Array\.isArray\(feed\.channels\) \? feed\.channels : \[\]/)
  assert.match(notifications, /channels\.length \? ` \$\{channels\.map\(\(channel\) => channel\.label\)\.join\('·'\)\}은 켠 유형만 나갑니다\.` : ''/)
  assert.equal(count(notifications, /'webhook-disabled'/g), 3, 'union · icon · tone')
  assert.match(notificationsCss, /\.notification-settings-table \{ overflow-x: auto; \}/)
})

test('출처 배지를 누르면 관리자만 외부 연동 탭으로 가고, 그 한 번으로 끝난다', () => {
  assert.match(app, /if \(originPage === 'people'\) setPeopleInitialTab\('integrations'\)/)
  assert.match(app, /useState<'members' \| 'accounts' \| 'performance' \| 'integrations' \| null>\(null\)/)
  // 지우지 않으면 그 뒤로는 사이드바로 들어와도 늘 외부 연동이 먼저 열린다.
  assert.match(app, /if \(nextPage !== 'people'\) setPeopleInitialTab\(null\)/)
})

test('중지 알림을 누르면 고칠 수 있는 화면에 내려놓는다 — 두 입구가 같은 곳으로 간다', () => {
  // '주소를 고친 뒤 다시 켜 주세요'라고 말해 놓고 기본 탭(구성원)에 내려놓으면 그 문장이 헛말이 된다.
  assert.match(app, /if \(page === 'people'\) \{ setPeopleInitialTab\('integrations'\); setNotificationsOpen\(false\); navigate\('people'\); return \}/)
  // 엔드포인트 id를 업무 초점 슬롯에 밀어 넣지 않는다 — 그 자리는 업무 id만 뜻한다.
  const handler = app.match(/onNavigate=\{\(page, focusId\) => \{[\s\S]*?\n\s{16}\}\}/)?.[0] ?? ''
  assert.ok(handler.indexOf("if (page === 'people')") < handler.indexOf('if (focusId) setWorkFocusId(focusId)'))
})

test('열 때마다 채널 목록을 다시 읽고, 못 읽으면 빈 목록으로 접지 않는다', () => {
  // 빈 목록으로 접으면 화면은 도착한 적 없는 데이터를 근거로 '채널이 지워졌다'고 말한다.
  assert.match(settings, /if \(!roomResponse\.ok \|\| !memberResponse\.ok\) throw new Error\('options'\)/)
  assert.doesNotMatch(settings, /roomResponse\.ok \? await roomResponse\.json\(\) :/)
  assert.match(settings, /const refreshOptions = \(\) => \{ setOptionsLoaded\(false\); setOptionsReady\(false\); setOptionsError\(false\) \}/)
  assert.equal(count(settings, /\n\s*refreshOptions\(\)\n/g), 2, '만들기·고치기 두 입구 모두에서 다시 읽는다')
  // 실패가 곧바로 같은 요청을 다시 띄우면 토스트를 뿌리는 무한 재시도가 된다.
  assert.doesNotMatch(settings, /setOptionsLoaded\(false\)\n\s*onToast/)
  // 못 읽었을 때도 고르개가 거짓을 말하지 않는다 — 저장될 값이 칸에 그대로 보인다.
  assert.match(settings, /\{optionsError && form\.conversationId && <option value=\{form\.conversationId\} disabled>지금 지정된 채널<\/option>\}/)
  assert.match(settings, /이 창을 닫았다 다시 열면 다시 읽습니다\./)
})

test('회수한 토큰은 대화상자의 사용 스위치에도 접힌다 — 다음 저장이 몰래 켜지 않는다', () => {
  assert.match(settings, /setForm\(\(current\) => \(current \? \{ \.\.\.current, enabled: result\.endpoint\?\.enabled === true \} : current\)\)/)
})

test('상태를 바꾸는 순간 앞 상태의 행을 지운다 — 표와 라벨이 어긋나지 않는다', () => {
  assert.match(settings, /setStatusRows\(null\)\n\s*setLogNote\(''\)\n\s*if \(statusFilter === 'all'\) return/)
})

test('CSS는 토큰만 쓰고, px는 상태 점과 반응형 분기점뿐이다', () => {
  assert.equal(count(settingsCss, /#[0-9a-f]{3,8}\b/gi), 0)
  assert.equal(count(settingsCss, /\.ui-button\s*\{/g), 0, '공용 버튼의 모양은 Button.css에서만 정한다')
  assert.deepEqual([...settingsCss.matchAll(/\d+px/g)].map((match) => match[0]), ['8px', '8px', '720px'])
  // 표는 자기 안에서만 가로로 흐른다 — 페이지를 밀지 않는다.
  assert.match(settingsCss, /\.webhook-log-scroll \{ overflow-x: auto; \}/)
  // footer의 음수 마진(.modal-card footer)이 되물 안쪽 여백이 두 대화상자 모두에 있다.
  assert.match(settings, /<form className="webhook-form"/, '설정 창은 .modal-card form의 여백을 받는다')
  assert.match(settingsCss, /\.webhook-reveal \{[^}]*padding: var\(--space-16\);/)
})
