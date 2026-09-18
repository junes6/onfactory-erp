import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { cuesToVtt, dictationFileName, dictationSupported, startDictation, vttTimestamp } from '../src/utils/speechDictation.ts'
import { transcriptFormatOf, transcriptFromCues } from '../server/transcription.mjs'

test('받아쓴 마디는 WebVTT가 되고, 서버의 자막 규칙이 말만 그대로 되돌려 읽는다', () => {
  const cues = [
    { startMs: 1_200, endMs: 4_000, text: '라벨 시안은 A안으로 갑시다.' },
    { startMs: 65_500, endMs: 70_010, text: '  이정민님이   금요일까지 인쇄소에 넘겨 주세요. ' },
    { startMs: 71_000, endMs: 71_000, text: '   ' },
    { startMs: 3_725_004, endMs: 3_726_000, text: '화살표 --> 는 타임코드 구분자라 바꾼다' },
  ]
  const vtt = cuesToVtt(cues)
  assert.ok(vtt.startsWith('WEBVTT\n\n'))
  assert.match(vtt, /00:00:01\.200 --> 00:00:04\.000\n라벨 시안은 A안으로 갑시다\./)
  assert.match(vtt, /00:01:05\.500 --> 00:01:10\.010\n이정민님이 금요일까지 인쇄소에 넘겨 주세요\./)
  assert.match(vtt, /01:02:05\.004 --> 01:02:06\.000/)
  assert.doesNotMatch(vtt.split('\n').filter((line) => !/^\d{2}:\d{2}:\d{2}\.\d{3} --> /.test(line)).join('\n'), /-->/, '말 속의 --> 는 남기지 않는다')
  // 빈 마디는 싣지 않는다.
  assert.equal(vtt.match(/ --> /g).length, 3)

  assert.equal(transcriptFormatOf({ mime: 'text/vtt', filename: dictationFileName('회의 녹음 2026-09-18 1430.webm') }), 'cue')
  assert.equal(
    transcriptFromCues(vtt),
    '라벨 시안은 A안으로 갑시다.\n\n이정민님이 금요일까지 인쇄소에 넘겨 주세요.\n\n화살표 → 는 타임코드 구분자라 바꾼다',
  )
})

test('타임코드와 파일 이름', () => {
  assert.equal(vttTimestamp(0), '00:00:00.000')
  assert.equal(vttTimestamp(-5), '00:00:00.000')
  assert.equal(vttTimestamp(59_999), '00:00:59.999')
  assert.equal(vttTimestamp(3_600_000), '01:00:00.000')
  assert.equal(dictationFileName('회의 녹음 2026-09-18 1430.webm'), '회의 녹음 2026-09-18 1430 받아쓰기.vtt')
  assert.equal(dictationFileName(''), '회의 녹음 받아쓰기.vtt')
})

test('브라우저 밖(인식기 없음)에서는 받아쓰기를 말하지 않는다 — 선택지를 그리지 않는다', () => {
  assert.equal(dictationSupported(), false)
  assert.equal(startDictation({ startedAt: new Date() }), null)
})

test('인식기가 스스로 멈추면 녹음이 계속되는 동안 다시 켜고, 확정된 말만 마디가 된다', async () => {
  const instances = []
  class FakeRecognition {
    constructor() { this.started = 0; this.stopped = 0; instances.push(this) }
    start() { this.started += 1 }
    stop() { this.stopped += 1 }
    abort() {}
  }
  const timers = []
  globalThis.window = { SpeechRecognition: FakeRecognition, setTimeout: (fn) => { timers.push(fn); return timers.length } }
  try {
    const updates = []
    const notices = []
    const startedAt = new Date(Date.now() - 2_000)
    const session = startDictation({ startedAt, onUpdate: (state) => updates.push(state), onNotice: (message) => notices.push(message) })
    assert.ok(session)
    assert.equal(instances.length, 1)
    assert.equal(instances[0].lang, 'ko-KR')
    assert.equal(instances[0].continuous, true)
    const result = (text, isFinal) => Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal })
    instances[0].onresult({ resultIndex: 0, results: [result('라벨 시안', false)] })
    instances[0].onresult({ resultIndex: 0, results: [result('라벨 시안은 A안으로', true)] })
    assert.equal(updates.at(-1).cues, 1)
    assert.equal(updates.at(-1).lastFinal, '라벨 시안은 A안으로')
    assert.equal(updates[0].interim, '라벨 시안')

    // 1분쯤 지나 브라우저가 스스로 멈췄다 → 다시 켠다.
    instances[0].onend()
    assert.equal(timers.length, 1)
    timers.shift()()
    assert.equal(instances.length, 2)

    // 권한이 막히면 다시 켜지 않고 사람에게 말한다(녹음은 계속된다).
    instances[1].onerror({ error: 'not-allowed' })
    instances[1].onend()
    assert.equal(timers.length, 0)
    assert.match(notices[0], /받아쓰기가 막혀 있습니다/)

    const cues = session.stop()
    assert.equal(cues.length, 1)
    assert.ok(cues[0].startMs >= 1_500 && cues[0].endMs >= cues[0].startMs + 500)
  } finally {
    delete globalThis.window
  }
})

test('SpeechRecognition은 src/utils/speechDictation.ts 한 파일에서만 나온다', async () => {
  const root = path.resolve('src')
  const offenders = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name)
      if (entry.isDirectory()) { await walk(next); continue }
      if (!/\.(ts|tsx)$/.test(entry.name) || next.endsWith(path.join('utils', 'speechDictation.ts'))) continue
      if (/SpeechRecognition/.test(await readFile(next, 'utf8'))) offenders.push(next)
    }
  }
  await walk(root)
  assert.deepEqual(offenders, [])
})
