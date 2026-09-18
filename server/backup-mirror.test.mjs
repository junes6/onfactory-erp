import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BACKUP_SET_MARKER,
  assertBackupSetSource,
  backupGenerationName,
  backupSettings,
  millisecondsUntilNextRun,
  nextBackupStatus,
  pruneGenerations,
  runBackupCycle,
} from './backup-mirror.mjs'

function memoryStorage({ fail = false } = {}) {
  const objects = new Map()
  return {
    objects,
    put: async (key, body) => {
      if (fail) throw new Error('cloud unavailable')
      objects.set(key, Buffer.from(body))
    },
  }
}

async function seedDataDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-src-'))
  await writeFile(path.join(directory, 'workspace-state.json'), JSON.stringify({ version: 2, tenants: {} }))
  await mkdir(path.join(directory, 'documents', 'TENANT-A'), { recursive: true })
  await writeFile(path.join(directory, 'documents', 'TENANT-A', 'DOC-1.bin'), '원본 파일')
  return directory
}

test('backup settings come from environment variables with safe defaults', () => {
  const off = backupSettings({})
  assert.equal(off.enabled, false)
  assert.equal(off.retention, 14)
  assert.equal(off.scheduleHour, 3)
  assert.equal(off.intervalHours, 24)
  const custom = backupSettings({ BACKUP_ENABLED: '1', BACKUP_NAS_DIRECTORY: '/mnt/nas', BACKUP_CLOUD_BUCKET: 'b', BACKUP_RETENTION_GENERATIONS: '7', BACKUP_SCHEDULE_HOUR: '2', BACKUP_INTERVAL_HOURS: '12' })
  assert.deepEqual(
    { enabled: custom.enabled, retention: custom.retention, scheduleHour: custom.scheduleHour, intervalHours: custom.intervalHours },
    { enabled: true, retention: 7, scheduleHour: 2, intervalHours: 12 },
  )
  // 말도 안 되는 값은 기본값으로 되돌린다.
  assert.equal(backupSettings({ BACKUP_SCHEDULE_HOUR: '99', BACKUP_RETENTION_GENERATIONS: '-3' }).scheduleHour, 3)
})

test('one cycle leaves the dump on NAS and mirrors the same dump to the cloud bucket', async () => {
  const source = await seedDataDirectory()
  const nas = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-nas-'))
  const storage = memoryStorage()
  try {
    const result = await runBackupCycle({
      dataDirectory: source,
      settings: { nasDirectory: nas, cloudBucket: 'backup-bucket', cloudPrefix: 'inthefield-backup', retention: 3 },
      storage,
      now: new Date('2026-08-31T18:00:00.000Z'),
    })
    assert.equal(result.ok, true)
    assert.equal(result.nas.ok, true)
    assert.ok(result.nas.bytes > 0)
    assert.equal(result.cloud.ok, true)
    assert.ok(result.cloud.objects >= 3, '워크스페이스 덤프 · 문서 원본 · 매니페스트가 모두 미러된다')

    // NAS 쪽 실물 확인. 세트 표식 파일 하나와 세대 폴더 하나가 있어야 한다 —
    // 표식을 세대로 세면 보관 정리가 한 세대를 덜 남긴다.
    const entries = await readdir(nas)
    assert.deepEqual(entries.filter((name) => name.startsWith('inthefield_')), [result.generation])
    assert.ok(entries.includes(BACKUP_SET_MARKER), '첫 백업이 이 세트의 원본을 표식에 적는다')
    const info = JSON.parse(await readFile(path.join(nas, result.generation, 'BACKUP_INFO.json'), 'utf8'))
    assert.equal(info.generation, result.generation)
    assert.equal(info.schemaVersion, 2)

    // 클라우드 쪽에도 같은 세대가 통째로 올라간다 (교차 보관).
    const keys = [...storage.objects.keys()]
    assert.ok(keys.every((key) => key.startsWith(`inthefield-backup/${result.generation}/`)))
    assert.ok(keys.some((key) => key.endsWith('workspace-state.json')))
    assert.ok(keys.some((key) => key.endsWith('documents/TENANT-A/DOC-1.bin')))
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(nas, { recursive: true, force: true })
  }
})

test('a cloud outage still leaves a usable NAS copy and raises a console warning', async () => {
  const source = await seedDataDirectory()
  const nas = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-nas-fail-'))
  try {
    const result = await runBackupCycle({
      dataDirectory: source,
      settings: { nasDirectory: nas, cloudBucket: 'backup-bucket', cloudPrefix: 'p', retention: 3 },
      storage: memoryStorage({ fail: true }),
      now: new Date('2026-08-31T18:00:00.000Z'),
    })
    assert.equal(result.nas.ok, true, 'NAS 사본은 그대로 남는다')
    assert.equal(result.cloud.ok, false)
    const status = nextBackupStatus(null, result)
    assert.match(status.warning, /클라우드 미러 실패/)
    assert.ok(status.lastSuccessAt, 'NAS가 성공했으므로 마지막 성공 시각은 갱신된다')
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(nas, { recursive: true, force: true })
  }
})

test('a NAS outage fails closed and keeps the previous success time', async () => {
  const source = await seedDataDirectory()
  try {
    const result = await runBackupCycle({
      dataDirectory: source,
      settings: { nasDirectory: '', cloudBucket: '', retention: 3 },
      now: new Date('2026-08-31T18:00:00.000Z'),
    })
    assert.equal(result.ok, false)
    const status = nextBackupStatus({ lastSuccessAt: '2026-08-30T18:00:00.000Z', consecutiveFailures: 1 }, result)
    assert.equal(status.lastSuccessAt, '2026-08-30T18:00:00.000Z', '전일자 성공 기록은 지워지지 않는다')
    assert.equal(status.consecutiveFailures, 2)
    assert.match(status.warning, /백업 실패/)
  } finally { await rm(source, { recursive: true, force: true }) }
})

test('only the configured number of generations is kept', async () => {
  const nas = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-prune-'))
  try {
    for (const stamp of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']) {
      await mkdir(path.join(nas, `inthefield_${stamp}_00-00-00-000`), { recursive: true })
    }
    await mkdir(path.join(nas, 'unrelated-folder'), { recursive: true })
    const removed = pruneGenerations(nas, 2)
    assert.equal(removed.length, 2)
    const remaining = (await readdir(nas)).sort()
    assert.deepEqual(remaining, ['inthefield_2026-08-03_00-00-00-000', 'inthefield_2026-08-04_00-00-00-000', 'unrelated-folder'])
  } finally { await rm(nas, { recursive: true, force: true }) }
})

test('the nightly schedule targets the configured Seoul hour', () => {
  // KST 2026-08-31 10:00 → 다음 실행은 같은 날 03시가 지났으므로 내일 03시.
  const wait = millisecondsUntilNextRun({ scheduleHour: 3 }, new Date('2026-08-31T01:00:00.000Z'))
  assert.equal(Math.round(wait / (60 * 60 * 1_000)), 17)
  // KST 2026-08-31 01:00 → 오늘 03시.
  const soon = millisecondsUntilNextRun({ scheduleHour: 3 }, new Date('2026-08-30T16:00:00.000Z'))
  assert.equal(Math.round(soon / (60 * 60 * 1_000)), 2)
})

test('generation names sort chronologically so pruning removes the oldest', () => {
  const first = backupGenerationName(new Date('2026-08-30T18:00:00.000Z'))
  const second = backupGenerationName(new Date('2026-08-31T18:00:00.000Z'))
  assert.ok(first < second)
  assert.match(first, /^inthefield_\d{4}-\d{2}-\d{2}_/)
})

/**
 * 이 저장소에서 실제로 일어난 일이다: 검증 에이전트가 ONFACTORY_DATA_DIRECTORY만 임시 폴더로
 * 바꿔 두고 .env.local의 BACKUP_ENABLED=1 · BACKUP_NAS_DIRECTORY는 그대로 물려받아,
 * 14KB짜리 빈 덤프 두 세대가 1.7MB짜리 진짜 세대들 위에 쌓였다. 보관 세대 수를 넘겼다면
 * 그 자리에서 가장 오래된 진짜 백업이 지워졌을 것이다.
 */
test('a run from a different data directory is refused before it can evict a real generation', async () => {
  const real = await seedDataDirectory()
  const stranger = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-stranger-'))
  await writeFile(path.join(stranger, 'workspace-state.json'), JSON.stringify({ version: 2, tenants: {} }))
  const nas = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-guard-'))
  try {
    const settings = { nasDirectory: nas, cloudBucket: '', cloudPrefix: 'inthefield-backup', retention: 1 }
    const first = await runBackupCycle({ dataDirectory: real, settings, now: new Date('2026-09-01T18:00:00.000Z') })
    assert.equal(first.ok, true)

    const intruder = await runBackupCycle({ dataDirectory: stranger, settings, now: new Date('2026-09-02T18:00:00.000Z') })
    assert.equal(intruder.ok, false)
    assert.match(intruder.error, /다른 데이터 디렉터리/)
    assert.match(intruder.error, /BACKUP_SET\.json/)

    // 보관 세대 수가 1이므로, 막지 못했다면 진짜 백업은 이미 사라졌을 자리다.
    const entries = await readdir(nas)
    assert.deepEqual(entries.filter((name) => name.startsWith('inthefield_')), [first.generation])
    assert.equal(intruder.pruned.length, 0, '거절된 실행은 아무것도 지우지 않는다')
    const kept = JSON.parse(await readFile(path.join(nas, first.generation, 'BACKUP_INFO.json'), 'utf8'))
    assert.equal(path.resolve(kept.source), path.resolve(real))

    // 실패는 상태에 남고, 마지막 성공 시각은 진짜 백업의 것을 지킨다.
    const status = nextBackupStatus(nextBackupStatus({}, first), intruder)
    assert.equal(status.lastGeneration, first.generation)
    assert.equal(status.consecutiveFailures, 1)
    assert.match(status.warning, /백업 실패/)
  } finally {
    for (const directory of [real, stranger, nas]) await rm(directory, { recursive: true, force: true })
  }
})

test('the same data directory keeps writing to its own set, whatever the path is spelled like', async () => {
  const source = await seedDataDirectory()
  const nas = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-same-'))
  try {
    const settings = { nasDirectory: nas, cloudBucket: '', cloudPrefix: 'inthefield-backup', retention: 5 }
    const first = await runBackupCycle({ dataDirectory: source, settings, now: new Date('2026-09-01T18:00:00.000Z') })
    // 같은 폴더를 슬래시 방향과 뒤 슬래시만 달리 적어도 같은 세트다(윈도 NAS 마운트에서 흔하다).
    const spelled = `${source.split(path.sep).join('/')}/`
    const second = await runBackupCycle({ dataDirectory: spelled, settings, now: new Date('2026-09-02T18:00:00.000Z') })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true, second.error)
    const entries = await readdir(nas)
    assert.equal(entries.filter((name) => name.startsWith('inthefield_')).length, 2)
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(nas, { recursive: true, force: true })
  }
})

test('an existing backup set with no marker adopts the directory that is backing it up', async () => {
  const source = await seedDataDirectory()
  const nas = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-legacy-'))
  try {
    // 이 기능 이전에 만들어진 세트. 표식이 없다고 해서 백업을 멈추면, 고치자마자 백업이 끊긴다.
    await mkdir(path.join(nas, 'inthefield_2026-08-30_18-00-00-000'), { recursive: true })
    const settings = { nasDirectory: nas, cloudBucket: '', cloudPrefix: 'inthefield-backup', retention: 5 }
    const result = await runBackupCycle({ dataDirectory: source, settings, now: new Date('2026-09-01T18:00:00.000Z') })
    assert.equal(result.ok, true, result.error)
    const marker = JSON.parse(await readFile(path.join(nas, BACKUP_SET_MARKER), 'utf8'))
    assert.equal(path.resolve(marker.dataDirectory), path.resolve(source))
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(nas, { recursive: true, force: true })
  }
})

test('a broken marker is not a way around the guard', async () => {
  const source = await seedDataDirectory()
  const nas = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-broken-'))
  try {
    await writeFile(path.join(nas, BACKUP_SET_MARKER), '{ 이건 JSON이 아니다')
    assert.throws(
      () => assertBackupSetSource(nas, source),
      (error) => error.code === 'BACKUP_SET_MARKER_UNREADABLE',
    )
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(nas, { recursive: true, force: true })
  }
})

test('보관은 날짜 기준이다 — 하루 하나(14일) · 주 하나(8주) · 달 하나(12달), 최근 48시간과 가장 새 세대는 언제나 남긴다', async () => {
  const { generationsToKeep, generationTime } = await import('./backup-mirror.mjs')
  const now = new Date('2026-09-18T00:00:00.000Z')
  const names = []
  // 1년 동안 매일 03시(KST = 전날 18시 UTC) 백업 + 오늘 수동 실행 세 번.
  for (let day = 0; day < 365; day += 1) names.push(backupGenerationName(new Date(now.getTime() - day * 86_400_000 - 6 * 3_600_000)))
  for (const minutes of [10, 20, 30]) names.push(backupGenerationName(new Date(now.getTime() - minutes * 60_000)))
  const keep = generationsToKeep(names, { daily: 14, weekly: 8, monthly: 12, recentHours: 48 }, { now })
  // 수동 실행 세 번이 하루치 자리를 밀어내지 않는다: 최근 14일이 모두 남는다.
  for (let day = 0; day < 14; day += 1) {
    const name = backupGenerationName(new Date(now.getTime() - day * 86_400_000 - 6 * 3_600_000))
    assert.ok(keep.has(name), `${day}일 전 백업이 남는다`)
  }
  for (const minutes of [10, 20, 30]) assert.ok(keep.has(backupGenerationName(new Date(now.getTime() - minutes * 60_000))), '최근 48시간 안의 수동 실행은 남는다')
  // 1년 전 세대까지 다 남기지는 않는다 — 14 + 8주 + 12달 + 최근분 안쪽.
  assert.ok(keep.size <= 14 + 8 + 12 + 3 + 2, `남은 세대 ${keep.size}`)
  const oldest = Math.min(...[...keep].map(generationTime))
  assert.ok(now.getTime() - oldest > 300 * 86_400_000, '열 달 넘게 거슬러 올라가는 월 세대가 있다')
  // 모르는 이름은 절대 지우지 않는다.
  assert.ok(generationsToKeep(['inthefield_manual-copy', ...names], 3, { now }).has('inthefield_manual-copy'))
})

test('백업에는 로그인 세션과 임시 파일이 담기지 않는다 — 복원으로 끝난 세션이 되살아나지 않는다', async () => {
  const source = await seedDataDirectory()
  const nas = await mkdtemp(path.join(os.tmpdir(), 'inthefield-backup-excl-'))
  try {
    await writeFile(path.join(source, 'sessions.json'), JSON.stringify({ version: 1, sessions: {} }))
    await writeFile(path.join(source, 'workspace-state.json.123.456.tmp'), '{')
    const result = await runBackupCycle({ dataDirectory: source, settings: { nasDirectory: nas, retention: 3 }, now: new Date('2026-08-31T18:00:00.000Z'), snapshot: () => '{"version":2}' })
    assert.equal(result.ok, true, result.error)
    const copied = await readdir(result.nas.path)
    assert.ok(copied.includes('workspace-state.json'))
    assert.ok(!copied.includes('sessions.json'))
    assert.ok(!copied.some((name) => name.endsWith('.tmp')))
    assert.ok(copied.includes('workspace-snapshot.json'), 'Postgres 모드 스냅샷이 함께 담긴다')
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(nas, { recursive: true, force: true })
  }
})

test('백업 주기는 설정을 따른다 — 24시간 미만이면 기준 시각부터 N시간마다', async () => {
  const { backupScheduleSpec } = await import('./backup-mirror.mjs')
  const { describeSpec, lastOccurrence, nextOccurrence } = await import('./scheduler.mjs')
  assert.deepEqual(backupScheduleSpec(backupSettings({ BACKUP_SCHEDULE_HOUR: '2' })), { every: 'day', hour: 2 })
  const spec = backupScheduleSpec(backupSettings({ BACKUP_SCHEDULE_HOUR: '3', BACKUP_INTERVAL_HOURS: '6' }))
  assert.deepEqual(spec, { every: 'hours', hour: 3, interval: 6 })
  assert.equal(describeSpec(spec), '매일 03:00부터 6시간마다')
  // KST 2026-09-18 10:30 → 직전은 09:00, 다음은 15:00.
  const now = new Date('2026-09-18T01:30:00.000Z')
  assert.equal(lastOccurrence(spec, now).toISOString(), '2026-09-18T00:00:00.000Z')
  assert.equal(nextOccurrence(spec, now).toISOString(), '2026-09-18T06:00:00.000Z')
  // KST 02:00(기준 시각 전) → 직전은 어제 21:00, 다음은 오늘 03:00.
  const early = new Date('2026-09-17T17:00:00.000Z')
  assert.equal(lastOccurrence(spec, early).toISOString(), '2026-09-17T12:00:00.000Z')
  assert.equal(nextOccurrence(spec, early).toISOString(), '2026-09-17T18:00:00.000Z')
})
