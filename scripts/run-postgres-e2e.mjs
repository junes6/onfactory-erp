import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import pg from 'pg'

import { emptyWorkspaceStore } from '../server/store/constants.mjs'
import { applyPostgresGuestContext, PostgresStoreAdapter } from '../server/store/postgres-store.mjs'

// 실 Postgres 전용 e2e. pg-mem이 못 검증하는 두 가지를 여기서 본다:
//   (a) 접속 롤이 슈퍼유저/BYPASSRLS면 RLS가 앱 커넥션에 적용되지 않는다 → "RLS 미검증"으로 표시.
//   (b) 게스트 컨텍스트로 SELECT하면 정책이 허락한 행만 보이고, 쓰기는 거부되는가.
// 전용 테스트 DB만 쓴다 — 어댑터 커밋은 스냅샷에 없는 계정·행을 soft-delete한다.

const databaseUrl = process.env.DATABASE_URL?.trim()

const E2E_TENANT = 'TENANT-E2E-GUEST'
const ADMIN = 'USR-E2E-GUEST-ADMIN'
const STAFF = 'USR-E2E-GUEST-STAFF'
const GUEST = 'USR-TENANT-E2E-GUEST-GUEST01'
const GRANT = 'GST-TENANT-E2E-GUEST-000001'

export async function checkRolePrivileges(pool) {
  const result = await pool.query('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')
  const row = result.rows[0] ?? { rolname: '(unknown)', rolsuper: null, rolbypassrls: null }
  return {
    rolname: row.rolname,
    rolsuper: row.rolsuper === true,
    rolbypassrls: row.rolbypassrls === true,
    // 둘 다 false여야 RLS가 이 커넥션에 실제로 걸린다.
    rlsEffective: row.rolsuper === false && row.rolbypassrls === false,
  }
}

// 설계서 §6-2 픽스처: 프로젝트 A(게스트 멤버)·B(company)·C(멤버 아님), 업무 W1/W2/W3,
// 방 R1/R2/team-ops/D1, 문서 DOC-ALL/DOC-R, 게시글 P1(A)/P2(C).
function guestScopeFixture(base) {
  const snapshot = structuredClone(base)
  snapshot.tenantMetadata ??= {}
  snapshot.tenantMetadata[E2E_TENANT] = { name: 'E2E 게스트 검증', isDemo: true }
  snapshot.accounts ??= []
  snapshot.platform ??= emptyWorkspaceStore().platform
  snapshot.platform.tenants ??= []
  const admin = { id: ADMIN, tenantId: E2E_TENANT, email: 'e2e-admin@guest-scope.invalid', name: 'E2E 관리자', role: 'tenant-admin', approvalStatus: 'approved' }
  const staff = { id: STAFF, tenantId: E2E_TENANT, email: 'e2e-staff@guest-scope.invalid', name: 'E2E 직원', role: 'tenant-member', approvalStatus: 'approved' }
  snapshot.accounts = snapshot.accounts.filter((account) => ![ADMIN, STAFF].includes(account?.id)).concat([admin, staff])
  snapshot.platform.tenants = snapshot.platform.tenants.filter((tenant) => tenant?.id !== E2E_TENANT)
    .concat([{ id: E2E_TENANT, name: 'E2E 게스트 검증', isDemo: true, adminAccount: admin }])
  snapshot.invitedAccounts = (snapshot.invitedAccounts ?? []).filter((invited) => invited?.id !== GUEST).concat([{
    id: GUEST, tenantId: E2E_TENANT, email: 'e2e-guest@guest-scope.invalid', name: 'E2E 게스트',
    role: 'tenant-guest', guestGrantId: GRANT, team: '파트너사', jobRole: '외부 게스트', approved: true, approvalStatus: 'approved',
  }])
  snapshot.guestGrants = (snapshot.guestGrants ?? []).filter((grant) => grant?.id !== GRANT).concat([{
    id: GRANT, tenantId: E2E_TENANT, accountId: GUEST, email: 'e2e-guest@guest-scope.invalid', name: 'E2E 게스트', orgName: '파트너사',
    projectIds: ['PRJ-A'], invitedById: ADMIN, invitedByName: 'E2E 관리자', status: 'active',
    tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null, accessExpiresAt: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }])
  const stamp = { updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: ADMIN }
  snapshot.tenants[E2E_TENANT] = {
    'project-spaces': { ...stamp, data: [
      { id: 'PRJ-A', name: 'A', visibility: 'members', members: [{ id: ADMIN, role: 'owner' }, { id: STAFF, role: 'editor' }, { id: GUEST, role: 'viewer' }] },
      { id: 'PRJ-B', name: 'B', visibility: 'company', members: [{ id: ADMIN, role: 'owner' }] },
      { id: 'PRJ-C', name: 'C', visibility: 'members', members: [{ id: ADMIN, role: 'owner' }, { id: STAFF, role: 'editor' }] },
    ] },
    'project-posts': { ...stamp, data: [
      { id: 'P1', projectId: 'PRJ-A', title: 'A 글', authorId: STAFF },
      { id: 'P2', projectId: 'PRJ-C', title: 'C 글', authorId: STAFF },
    ] },
    'work-items': { ...stamp, data: [
      { id: 'W1', title: 'W1', projectId: 'PRJ-A', ownerId: GUEST, requesterId: STAFF, due: '2026-09-10T09:00:00.000Z', status: '업무요청' },
      { id: 'W2', title: 'W2', projectId: 'PRJ-A', ownerId: STAFF, requesterId: ADMIN, due: '2026-09-10T09:00:00.000Z', status: '업무요청' },
      { id: 'W3', title: 'W3', ownerId: GUEST, requesterId: STAFF, due: '2026-09-10T09:00:00.000Z', status: '업무요청' },
    ] },
    'messenger-conversations': { ...stamp, data: [
      { id: 'R1', type: 'group', name: 'A 채널', projectId: 'PRJ-A', participantIds: [STAFF, GUEST], messages: [] },
      { id: 'R2', type: 'group', name: 'C 채널', projectId: 'PRJ-C', participantIds: [STAFF, GUEST], messages: [] },
      { id: 'team-ops', type: 'team', name: '운영팀', messages: [] },
      { id: 'D1', type: 'direct', participantIds: [STAFF, GUEST], messages: [] },
    ] },
    'company-documents': { ...stamp, data: [
      { id: 'DOC-ALL', name: '전사 공지.pdf', visibility: 'all', uploadedById: ADMIN, mime: 'application/pdf', size: 10, storageKey: `${E2E_TENANT}/DOC-ALL` },
      { id: 'DOC-R', name: '게스트 공유.pdf', visibility: 'restricted', allowedUserIds: [GUEST, STAFF], uploadedById: STAFF, mime: 'application/pdf', size: 10, storageKey: `${E2E_TENANT}/DOC-R` },
    ] },
  }
  return snapshot
}

function expectSet(label, actual, expected, failures) {
  const a = [...actual].sort()
  const b = [...expected].sort()
  const ok = a.length === b.length && a.every((value, index) => value === b[index])
  console.log(`[postgres-e2e] ${ok ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(a)}${ok ? '' : ` (기대 ${JSON.stringify(b)})`}`)
  if (!ok) failures.push(label)
}

export async function verifyGuestScope(pool) {
  const failures = []
  const adapter = new PostgresStoreAdapter({ pool })
  await adapter.applySchema()
  await adapter.connect()
  const before = await adapter.loadSnapshot()
  try {
    await adapter.commitSnapshot(guestScopeFixture(before), { referenceDate: '2026-09-01' })
    const scope = { tenantId: E2E_TENANT, accountId: GUEST, projectIds: ['PRJ-A'] }
    expectSet('project_spaces → A만', await adapter.guestVisibleIds({ ...scope, table: 'project_spaces', candidateIds: ['PRJ-A', 'PRJ-B', 'PRJ-C'] }), ['PRJ-A'], failures)
    expectSet('project_posts → P1만', await adapter.guestVisibleIds({ ...scope, table: 'project_posts', candidateIds: ['P1', 'P2'] }), ['P1'], failures)
    expectSet('work_items → W1만', await adapter.guestVisibleIds({ ...scope, table: 'work_items', candidateIds: ['W1', 'W2', 'W3'] }), ['W1'], failures)
    expectSet('messenger_conversations → R1·D1만', await adapter.guestVisibleIds({ ...scope, table: 'messenger_conversations', candidateIds: ['R1', 'R2', 'team-ops', 'D1'] }), ['R1', 'D1'], failures)
    expectSet('items(company-document) → DOC-R만', await adapter.guestVisibleIds({ ...scope, table: 'items', candidateIds: ['DOC-ALL', 'DOC-R'] }), ['DOC-R'], failures)
    // 범위 밖 프로젝트를 세션 변수에 넣어도 members에 없으면 보이지 않는다.
    expectSet('project_spaces(범위 C 주입) → 멤버 아님', await adapter.guestVisibleIds({ ...scope, projectIds: ['PRJ-A', 'PRJ-C'], table: 'project_spaces', candidateIds: ['PRJ-A', 'PRJ-C'] }), ['PRJ-A'], failures)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await applyPostgresGuestContext(client, scope)
      // 설계 §6-2(b): 후보 id를 넘기지 않는 전량 SELECT. guestVisibleIds 경로는 후보 안에서만 자르므로,
      // 정책이 후보 밖 행까지 숨기는지는 여기서만 증명된다.
      const spaces = await client.query('SELECT id FROM project_spaces WHERE org_id = $1', [E2E_TENANT])
      expectSet('project_spaces 전량 SELECT → A만', spaces.rows.map((row) => row.id), ['PRJ-A'], failures)
      const works = await client.query('SELECT id FROM work_items WHERE org_id = $1', [E2E_TENANT])
      expectSet('work_items 전량 SELECT → W1만', works.rows.map((row) => row.id), ['W1'], failures)
      const rooms = await client.query('SELECT id FROM messenger_conversations WHERE org_id = $1', [E2E_TENANT])
      expectSet('messenger_conversations 전량 SELECT → R1·D1만', rooms.rows.map((row) => row.id), ['R1', 'D1'], failures)
      const docs = await client.query("SELECT id FROM items WHERE org_id = $1 AND item_type = 'company-document'", [E2E_TENANT])
      expectSet('items(company-document) 전량 SELECT → DOC-R만', docs.rows.map((row) => row.id), ['DOC-R'], failures)
      const accounts = await client.query('SELECT id FROM core_accounts WHERE tenant_id = $1', [E2E_TENANT])
      expectSet('core_accounts → 본인 행만', accounts.rows.map((row) => row.id), [GUEST], failures)
      const grants = await client.query('SELECT id FROM guest_grants WHERE tenant_id = $1', [E2E_TENANT])
      expectSet('guest_grants → 게스트 컨텍스트에서 0건', grants.rows.map((row) => row.id), [], failures)
      const updated = await client.query('UPDATE work_items SET updated_at = NOW() WHERE org_id = $1', [E2E_TENANT])
      expectSet('work_items UPDATE → 영향 0행', [String(updated.rowCount)], ['0'], failures)
      // INSERT는 RLS 위반(SQLSTATE 42501)으로 거부돼야 한다. 다른 이유(NOT NULL·FK)로 실패한 것을 '거부'로 치면
      // 스키마가 바뀌었을 때 정책이 뚫려도 통과하는 시험이 된다.
      let insertOutcome = 'accepted'
      try {
        await client.query('SAVEPOINT guest_insert')
        await client.query("INSERT INTO work_items (org_id, id, payload, position) VALUES ($1, 'W-GUEST-INSERT', '{}'::jsonb, 0)", [E2E_TENANT])
        await client.query('ROLLBACK TO SAVEPOINT guest_insert')
      } catch (error) {
        insertOutcome = error?.code === '42501' ? 'rls-denied' : `other:${error?.code ?? error?.message}`
        await client.query('ROLLBACK TO SAVEPOINT guest_insert')
      }
      expectSet('work_items INSERT → RLS 거부(42501)', [insertOutcome], ['rls-denied'], failures)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  } finally {
    // 검증 픽스처는 되돌린다(soft-delete). 실패해도 본 검증 결과는 유지한다.
    try { await adapter.commitSnapshot(before, { referenceDate: '2026-09-01' }) } catch (error) { console.warn(`[postgres-e2e] 픽스처 정리 실패: ${error?.message}`) }
    await adapter.flush()
  }
  return failures
}

function runTests(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      '--test',
      'server/store/postgres-store.test.mjs',
      'server/store/postgres-app.integration.test.mjs',
    ], {
      stdio: 'inherit',
      env: { ...process.env, RUN_POSTGRES_E2E: 'true', ...extraEnv },
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`[postgres-e2e] ${signal} 신호로 종료되었습니다.`)
        resolve(1)
        return
      }
      resolve(code ?? 1)
    })
  })
}

async function main() {
  if (!databaseUrl) {
    console.error('[postgres-e2e] DATABASE_URL이 필요합니다. 전용 테스트 DB만 사용하세요.')
    process.exitCode = 2
    return
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  let rlsVerified = false
  let exitCode = 0
  try {
    const privileges = await checkRolePrivileges(pool)
    if (!privileges.rlsEffective) {
      console.warn(`[postgres-e2e] RLS 미검증: 접속 롤 ${privileges.rolname}이(가) rolsuper=${privileges.rolsuper}, rolbypassrls=${privileges.rolbypassrls}입니다.`)
      console.warn('[postgres-e2e] 게스트 격리를 DB에서도 강제하려면 NOBYPASSRLS 비특권 롤(예: onfactory_app)로 DATABASE_URL을 바꿔야 합니다. 게스트 컨텍스트 SELECT 검증을 건너뜁니다.')
      exitCode = 1
    } else {
      console.log(`[postgres-e2e] 접속 롤 ${privileges.rolname}: rolsuper=false, rolbypassrls=false — RLS가 적용됩니다.`)
      const failures = await verifyGuestScope(pool)
      if (failures.length) {
        console.error(`[postgres-e2e] 게스트 범위 RLS 검증 실패 ${failures.length}건: ${failures.join(' / ')}`)
        exitCode = 1
      } else {
        console.log('[postgres-e2e] 게스트 범위 RLS 검증 통과')
        rlsVerified = true
      }
    }
  } finally {
    await pool.end()
  }
  const testCode = await runTests({ POSTGRES_E2E_RLS_VERIFIED: rlsVerified ? 'true' : 'false' })
  process.exitCode = testCode !== 0 ? testCode : exitCode
}

// 직접 실행했을 때만 돈다. checkRolePrivileges/verifyGuestScope를 import하는 쪽에서 즉시 실행·종료되지 않게.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[postgres-e2e] 실패: ${error?.message}`)
    process.exitCode = 1
  })
}
