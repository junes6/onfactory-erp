import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { looksLikeBackup, resolveRestoreSource, restoreDestination } from './restore-data.mjs'

/** 백업 세대 하나를 흉내 낸다. */
async function seedGeneration(root, name) {
  const directory = path.join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'workspace-state.json'), JSON.stringify({ version: 2, tenants: {} }))
  await writeFile(path.join(directory, 'BACKUP_INFO.json'), JSON.stringify({ generation: name, schemaVersion: 2 }))
  return directory
}

/**
 * 이 파일이 지키는 것은 하나다: **야간 백업을 그 백업이 있는 곳에서 되돌릴 수 있어야 한다.**
 *
 * 예전 판은 `server/backups` 아래만 받았다. README의 복구 절차 4단계가 NAS 경로를 `--from=`에 넣으라고
 * 적어 두었는데도 그랬다 — 문서가 시키는 그대로 하면 언제나 실패했고, 그 사실은 진짜 장애가 났을 때
 * 처음 드러났을 것이다.
 */
test('NAS 백업 세대를 복원 소스로 받는다 — README의 복구 절차가 실제로 통한다', async () => {
  const nas = await mkdtemp(path.join(os.tmpdir(), 'restore-nas-'))
  try {
    const generation = await seedGeneration(nas, 'inthefield_2026-09-01_03-00-00-000')
    const resolved = resolveRestoreSource(generation, { env: { BACKUP_ENABLED: '1', BACKUP_NAS_DIRECTORY: nas } })
    assert.equal(resolved.ok, true, resolved.message)
    assert.equal(resolved.root, 'BACKUP_NAS_DIRECTORY')
    assert.equal(path.resolve(resolved.source), path.resolve(generation))
  } finally { await rm(nas, { recursive: true, force: true }) }
})

test('로컬 backup:data 사본도 그대로 받는다', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'restore-cwd-'))
  try {
    const generation = await seedGeneration(path.join(cwd, 'server', 'backups'), 'onfactory_2026-09-01_03-00-00-000')
    const resolved = resolveRestoreSource(generation, { env: {}, cwd })
    assert.equal(resolved.ok, true, resolved.message)
    assert.equal(resolved.root, 'server/backups')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('허용된 두 뿌리 밖의 폴더는 받지 않는다 — 아무 폴더나 데이터 디렉터리에 붓지 못하게', async () => {
  const nas = await mkdtemp(path.join(os.tmpdir(), 'restore-nas-'))
  const stranger = await mkdtemp(path.join(os.tmpdir(), 'restore-stranger-'))
  try {
    await writeFile(path.join(stranger, 'workspace-state.json'), '{}')
    const resolved = resolveRestoreSource(stranger, { env: { BACKUP_ENABLED: '1', BACKUP_NAS_DIRECTORY: nas } })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, 'OUTSIDE_ROOTS')
    // 오류 문구가 **어디는 되는지**를 말해야 한다. 안 그러면 사람이 장애 중에 추측하게 된다.
    assert.match(resolved.message, /BACKUP_NAS_DIRECTORY/)
    assert.match(resolved.message, /server\/backups/)
  } finally { for (const directory of [nas, stranger]) await rm(directory, { recursive: true, force: true }) }
})

test('상위로 빠져나가는 경로는 뿌리 안으로 치지 않는다', async () => {
  const nas = await mkdtemp(path.join(os.tmpdir(), 'restore-nas-'))
  try {
    const resolved = resolveRestoreSource(path.join(nas, '..'), { env: { BACKUP_ENABLED: '1', BACKUP_NAS_DIRECTORY: nas } })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, 'OUTSIDE_ROOTS')
    // 뿌리 자기 자신도 세대가 아니다 — 세대 폴더 하나를 지목해야 한다.
    assert.equal(resolveRestoreSource(nas, { env: { BACKUP_ENABLED: '1', BACKUP_NAS_DIRECTORY: nas } }).ok, false)
  } finally { await rm(nas, { recursive: true, force: true }) }
})

test('허용된 뿌리 아래여도 백업처럼 생기지 않았으면 거절한다', async () => {
  const nas = await mkdtemp(path.join(os.tmpdir(), 'restore-nas-'))
  try {
    await seedGeneration(nas, 'inthefield_2026-09-01_03-00-00-000')
    const empty = path.join(nas, '_격리_시험실행분')
    await mkdir(empty, { recursive: true })
    const resolved = resolveRestoreSource(empty, { env: { BACKUP_ENABLED: '1', BACKUP_NAS_DIRECTORY: nas } })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, 'NOT_A_BACKUP')
    // 무엇을 고르면 되는지 함께 말한다.
    assert.match(resolved.message, /inthefield_2026-09-01/)
    assert.equal(looksLikeBackup(empty), false)
  } finally { await rm(nas, { recursive: true, force: true }) }
})

test('NAS가 설정되지 않은 배포에서는 그 사실을 문구가 말한다', async () => {
  const resolved = resolveRestoreSource('/mnt/nas/inthefield_2026-09-01_03-00-00-000', { env: {} })
  assert.equal(resolved.ok, false)
  assert.match(resolved.message, /BACKUP_NAS_DIRECTORY가 설정되지 않아/)
})

test('--from 이 없으면 어디서 고르면 되는지 알려 준다', () => {
  const resolved = resolveRestoreSource('', { env: { BACKUP_ENABLED: '1', BACKUP_NAS_DIRECTORY: '/mnt/nas' } })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, 'MISSING')
  assert.match(resolved.message, /server\/backups/)
  assert.match(resolved.message, /mnt[\\/]nas/)
})

test('복원 대상은 저장소가 읽는 것과 같은 환경변수를 본다', () => {
  assert.equal(
    restoreDestination({ env: { ONFACTORY_DATA_DIRECTORY: 'server/data' }, cwd: '/repo' }),
    path.resolve('/repo', 'server/data'),
  )
  assert.equal(
    restoreDestination({ env: { WORKSPACE_STORE_FILE: '/var/lib/inthefield/workspace-state.json' }, cwd: '/repo' }),
    path.resolve('/var/lib/inthefield'),
  )
  assert.equal(restoreDestination({ env: {}, cwd: '/repo' }), path.resolve('/repo', 'server/data'))
})
