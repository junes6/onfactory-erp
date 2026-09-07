import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_TRANSCRIPT_CHARS,
  TRANSCRIPTION_PROVIDERS,
  TranscriptionError,
  createTranscription,
  clipCharacters,
  countCharacters,
  transcriptFormatOf,
  transcriptFromCues,
  transcriptFromPlainText,
} from './transcription.mjs'

/** 오늘의 두 구현은 네트워크를 부르지 않는다. 부르면 이 fetch가 테스트를 깨뜨린다. */
function explodingFetch() {
  throw new Error('전사 어댑터가 네트워크를 불렀습니다 — none·text는 아무 곳에도 접속하지 않아야 합니다.')
}

const VTT = [
  'WEBVTT',
  'Kind: captions',
  'Language: ko',
  '',
  'NOTE 이 줄은 자막 파일의 주석이다',
  '',
  '1',
  '00:00:01.000 --> 00:00:04.000',
  '안녕하세요. 회의 시작하겠습니다.',
  '',
  '2',
  '00:00:04.500 --> 00:00:07.250',
  '네, 라벨 시안부터 보겠습니다.',
  '',
].join('\n')

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  '안녕하세요. 회의 시작하겠습니다.',
  '',
  '2',
  '00:00:04,500 --> 00:00:07,250',
  '네, 라벨 시안부터 보겠습니다.',
  '',
].join('\n')

test('none 어댑터는 오디오를 받지 않는다고 분명히 말한다', () => {
  const transcription = createTranscription({ env: {}, fetchImpl: explodingFetch })
  assert.equal(transcription.name, 'none')
  assert.equal(transcription.acceptsAudio, false)
  assert.equal(transcription.acceptsTranscript, false)
  assert.deepEqual(transcription.mimeTypes, [])
  assert.equal(transcription.accepts('text/plain'), false)
})

test('none 어댑터를 부르면 설정되지 않았다는 사실을 503으로 답한다 — 가짜 전사를 지어내지 않는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'none' }, fetchImpl: explodingFetch })
  await assert.rejects(
    () => transcription.transcribe({ body: Buffer.from('무엇이든'), mime: 'audio/webm' }),
    (error) => {
      assert.ok(error instanceof TranscriptionError)
      assert.equal(error.code, 'TRANSCRIPTION_NOT_CONFIGURED')
      assert.equal(error.status, 503)
      assert.equal(
        error.message,
        '음성 전사 연결이 아직 설정되지 않았습니다. 관리자가 TRANSCRIPTION_PROVIDER를 text로 켜면 회의록 원문(.txt·.vtt·.srt)을 올려 요약과 업무 추출까지 할 수 있습니다.',
      )
      return true
    },
  )
})

test('text 어댑터는 평문 원문을 그대로 옮긴다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const source = '김지훈: 오늘 회의 시작합니다.\n박서연: 라벨 시안부터 보겠습니다.'
  const result = await transcription.transcribe({ body: Buffer.from(source, 'utf8'), mime: 'text/plain; charset=utf-8' })
  assert.equal(result.text, source)
  assert.equal(result.provider, 'text')
  assert.equal(result.model, 'transcript-upload')
  assert.equal(result.durationMs, 0)
  assert.equal(result.characters, result.text.length)
})

test('VTT의 헤더·주석·큐 번호·타임코드는 사라지고 말만 남는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const result = await transcription.transcribe({ body: Buffer.from(VTT, 'utf8'), mime: 'text/vtt' })
  assert.equal(result.text, '안녕하세요. 회의 시작하겠습니다.\n\n네, 라벨 시안부터 보겠습니다.')
  assert.ok(!result.text.includes('WEBVTT'))
  assert.ok(!result.text.includes('-->'))
  assert.ok(!result.text.includes('00:00:01'))
  assert.ok(!result.text.includes('이 줄은 자막 파일의 주석이다'))
})

test('SRT도 같은 결과가 된다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const result = await transcription.transcribe({ body: Buffer.from(SRT, 'utf8'), mime: 'application/x-subrip' })
  assert.equal(result.text, '안녕하세요. 회의 시작하겠습니다.\n\n네, 라벨 시안부터 보겠습니다.')
})

test('숫자만 적힌 말은 큐 번호가 아니므로 지우지 않는다', () => {
  assert.equal(transcriptFromCues('예산은 얼마인가요?\n3000\n만원입니다.'), '예산은 얼마인가요?\n3000\n만원입니다.')
})

test('원문은 상한에서 자르고, characters는 실제 글자 수와 같다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const source = '가'.repeat(MAX_TRANSCRIPT_CHARS + 5_000)
  const result = await transcription.transcribe({ body: Buffer.from(source, 'utf8'), mime: 'text/plain' })
  assert.equal(result.text.length, MAX_TRANSCRIPT_CHARS)
  assert.equal(result.characters, MAX_TRANSCRIPT_CHARS)
})

test('읽을 글이 없는 파일은 400으로 돌려보낸다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  await assert.rejects(
    () => transcription.transcribe({ body: Buffer.from('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n\n', 'utf8'), mime: 'text/vtt' }),
    (error) => {
      assert.equal(error.code, 'MEETING_TRANSCRIPT_EMPTY')
      assert.equal(error.status, 400)
      return true
    },
  )
})

test('오디오는 text 어댑터가 받지 않는다 — accepts와 transcribe가 같은 말을 한다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  assert.equal(transcription.acceptsAudio, false)
  assert.equal(transcription.accepts('audio/webm'), false)
  assert.equal(transcription.accepts('text/markdown'), true)
  await assert.rejects(
    () => transcription.transcribe({ body: Buffer.from([0, 1, 2]), mime: 'audio/webm' }),
    (error) => {
      assert.equal(error.code, 'MEETING_SOURCE_UNSUPPORTED')
      assert.equal(error.status, 415)
      return true
    },
  )
})

test('알 수 없는 TRANSCRIPTION_PROVIDER는 부팅에서 드러난다 — 조용히 none이 되지 않는다', () => {
  assert.deepEqual([...TRANSCRIPTION_PROVIDERS], ['none', 'text'])
  assert.throws(
    () => createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'whisper' }, fetchImpl: explodingFetch }),
    (error) => {
      assert.ok(error instanceof TranscriptionError)
      assert.equal(error.code, 'TRANSCRIPTION_PROVIDER_UNKNOWN')
      assert.equal(error.status, 500)
      assert.ok(error.message.includes('whisper'))
      return true
    },
  )
})

test('환경변수가 비어 있으면 none으로 읽는다', () => {
  assert.equal(createTranscription({ env: { TRANSCRIPTION_PROVIDER: '   ' }, fetchImpl: explodingFetch }).name, 'none')
  assert.equal(createTranscription({ env: {}, fetchImpl: explodingFetch }).name, 'none')
})

// ---------------------------------------------------------------------------
// M1 1회차 검증 지적 — 재현 테스트
// ---------------------------------------------------------------------------

test('평문 회의록의 NOTE·STYLE·REGION 줄은 회의 내용이다 — 문단을 통째로 지우지 않는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const source = [
    '9월 정례 회의',
    '',
    'STYLE 가이드는 A안으로 확정',
    '담당은 이과장, 금요일까지 정리해 주세요',
    '',
    'REGION 별 매출은 다음 주에 다시 본다',
    '수도권은 김대리가 맡기로 결정',
    '',
    'NOTE: 다음 회의 준비물은 노트북',
    '견적서도 함께 가져오기로 합의',
    '',
    '이상.',
  ].join('\n')
  for (const mime of ['text/plain', 'text/markdown']) {
    const result = await transcription.transcribe({ body: source, mime })
    assert.equal(result.text, source, `${mime}에서 올린 글이 그대로 남아야 한다`)
  }
  assert.equal(transcriptFromPlainText(source), source)
})

test('평문 회의록의 WEBVTT·타임코드처럼 보이는 줄도 회의 내용이다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const header = 'WEBVTT 자막 규격으로 통일하기로 결정했습니다.\n박서연: 다음 회의에서 최종 확인합니다.'
  assert.equal((await transcription.transcribe({ body: header, mime: 'text/plain' })).text, header)
  const agenda = '9월 정례 회의\n09:00 --> 10:00 라벨 시안 검토 — 납기를 월요일로 확정했습니다.\n이상.'
  assert.equal((await transcription.transcribe({ body: agenda, mime: 'text/plain' })).text, agenda)
})

test('WEBVTT 헤더 뒤에 빈 줄이 없어도 첫 발언이 사라지지 않는다', () => {
  const source = 'WEBVTT\n00:00:01.000 --> 00:00:03.000\n첫 번째 발언입니다\n\n00:00:04.000 --> 00:00:05.000\n두 번째 발언입니다\n'
  assert.equal(transcriptFromCues(source), '첫 번째 발언입니다\n\n두 번째 발언입니다')
})

test('상한 절단이 서로게이트 쌍을 반으로 가르지 않는다 — 저장본과 반환본이 같다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const source = 'ㄱ'.repeat(MAX_TRANSCRIPT_CHARS - 1) + '😀' + '뒤'
  const result = await transcription.transcribe({ body: source, mime: 'text/plain' })
  assert.ok(result.text.isWellFormed(), '짝 없는 서로게이트로 끝나면 UTF-8 저장에서 글자가 망가진다')
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text)
  assert.equal(countCharacters(result.text), MAX_TRANSCRIPT_CHARS)
})

test('characters는 사람이 세는 글자 수이고, bytes가 저장 크기다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const result = await transcription.transcribe({ body: '😀😀😀', mime: 'text/plain' })
  assert.equal(result.characters, 3)
  assert.equal(result.bytes, 12)
  assert.equal(countCharacters('😀😀😀'), 3)
  assert.equal(clipCharacters('😀😀😀', 2), '😀😀')
})

test('MIME이 비어 있어도 파일 이름의 확장자로 읽는다 — 윈도우는 .vtt·.srt·.md에 MIME을 주지 않는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  for (const mime of ['', undefined, 'application/octet-stream']) {
    assert.equal(transcription.accepts(mime, '9월 회의.vtt'), true)
    assert.equal(transcription.accepts(mime, '9월 회의.srt'), true)
    assert.equal(transcription.accepts(mime, '9월 회의.md'), true)
    assert.equal(transcription.accepts(mime, '9월 회의.txt'), true)
    assert.equal(transcription.accepts(mime, '9월 회의.webm'), false)
    assert.equal(transcription.accepts(mime), false)
  }
  assert.equal(transcriptFormatOf({ mime: '', filename: 'a.vtt' }), 'cue')
  assert.equal(transcriptFormatOf({ mime: '', filename: 'a.txt' }), 'plain')
  assert.equal(transcriptFormatOf({ mime: 'audio/webm', filename: 'a.webm' }), null)
  const result = await transcription.transcribe({
    body: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n안녕하세요\n',
    mime: '',
    filename: '9월 회의.vtt',
  })
  assert.equal(result.text, '안녕하세요')
  assert.equal(result.format, 'cue')
})

test('문자열도 바이트도 아닌 body에는 TranscriptionError로 답한다 — NUL을 전사 결과로 지어내지 않는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  for (const body of [{ a: 1 }, 42, ['안녕'], null, undefined]) {
    await assert.rejects(
      () => transcription.transcribe({ body, mime: 'text/plain' }),
      (error) => {
        assert.ok(error instanceof TranscriptionError, `TranscriptionError가 아니면 라우트가 500으로 흘린다: ${error?.name}`)
        assert.equal(error.code, 'MEETING_SOURCE_UNREADABLE')
        assert.equal(error.status, 400)
        return true
      },
    )
  }
})

// ---------------------------------------------------------------------------
// M1 2회차 검증 지적 — 재현 테스트
// ---------------------------------------------------------------------------

test('큐 식별자는 숫자가 아니라 자리로 정한다 — Teams의 GUID 식별자가 발언으로 남지 않는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const teams = [
    'WEBVTT',
    '',
    '4f1c7b20-55aa-4c0e-8d31-2b0a7e6c4410/1-0',
    '00:00:01.000 --> 00:00:03.000',
    '<v 김지훈>오늘 회의 시작하겠습니다.</v>',
    '',
    '4f1c7b21-55aa-4c0e-8d31-2b0a7e6c4411/2-0',
    '00:00:04.000 --> 00:00:06.000',
    '<v 박서연>라벨 시안은 월요일까지 넘기기로 결정했습니다.</v>',
    '',
  ].join('\n')
  const result = await transcription.transcribe({ body: teams, mime: 'text/vtt' })
  assert.equal(
    result.text,
    '<v 김지훈>오늘 회의 시작하겠습니다.</v>\n\n<v 박서연>라벨 시안은 월요일까지 넘기기로 결정했습니다.</v>',
  )
  assert.ok(!result.text.includes('4f1c7b20'), '큐 식별자가 요약 첫머리에 찍힌다')
  // Otter·Descript식 이름 식별자도 같은 자리다.
  assert.equal(
    transcriptFromCues('WEBVTT\n\nintro-01\n00:00:01.000 --> 00:00:03.000\n첫 발언입니다\n\nspeaker-kim-2\n00:00:04.000 --> 00:00:05.000\n두 번째 발언입니다\n'),
    '첫 발언입니다\n\n두 번째 발언입니다',
  )
  // 자리로 정한다는 말은 큐 본문은 건드리지 않는다는 뜻이다 — 빈 줄 없이 다음 타임코드가 와도 발언은 남는다.
  assert.equal(
    transcriptFromCues('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n첫 번째 발언입니다\n00:00:04.000 --> 00:00:05.000\n두 번째 발언입니다\n'),
    '첫 번째 발언입니다\n두 번째 발언입니다',
  )
})

test('자막 본문이 NOTE·STYLE·REGION으로 시작해도 발언은 지우지 않는다 — 큐 밖의 블록만 지운다', () => {
  const srt = [
    '1', '00:00:01,000 --> 00:00:03,000', 'REGION별 매출 목표를 다시 잡기로 했습니다', '다음 안건입니다', '',
    '2', '00:00:04,000 --> 00:00:06,000', 'STYLE 가이드는 A안으로 확정합니다', '',
    '3', '00:00:07,000 --> 00:00:09,000', 'NOTE 항목은 회의록에 남깁니다', '',
  ].join('\n')
  assert.equal(
    transcriptFromCues(srt),
    'REGION별 매출 목표를 다시 잡기로 했습니다\n다음 안건입니다\n\nSTYLE 가이드는 A안으로 확정합니다\n\nNOTE 항목은 회의록에 남깁니다',
  )
  // 큐 밖(헤더 다음)의 NOTE 블록은 파일의 주석이므로 그대로 사라진다.
  assert.ok(!transcriptFromCues(VTT).includes('이 줄은 자막 파일의 주석이다'))
})

test('UTF-8이 아닌 바이트는 400으로 되돌려 보낸다 — 깨진 글자를 전사 결과라고 부르지 않는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  // CP949로 저장한 '안녕하세요' — SubRip에는 인코딩 선언이 없어 한국에서 흔한 저장 방식이다.
  const cp949 = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4])
  assert.ok(!cp949.includes(Buffer.from([0xef, 0xbf, 0xbd])), '원본 바이트에는 U+FFFD가 없다')
  await assert.rejects(
    () => transcription.transcribe({ body: cp949, mime: 'text/plain', filename: '9월 회의.txt' }),
    (error) => {
      assert.ok(error instanceof TranscriptionError)
      assert.equal(error.code, 'MEETING_SOURCE_NOT_UTF8')
      assert.equal(error.status, 400)
      assert.equal(error.message, '이 파일은 UTF-8이 아닙니다. 메모장에서 「UTF-8」로 다시 저장해 올려 주세요.')
      return true
    },
  )
  // UTF-8 바이트는 그대로 통과한다.
  const ok = await transcription.transcribe({ body: Buffer.from('안녕하세요', 'utf8'), mime: 'text/plain' })
  assert.equal(ok.text, '안녕하세요')
})

test('짝 없는 서로게이트가 든 문자열 body에도 bytes가 참말이다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const result = await transcription.transcribe({ body: '앞\uD83D뒤', mime: 'text/plain' })
  assert.ok(result.text.isWellFormed(), '반환본이 well-formed가 아니면 UTF-8 저장본과 달라진다')
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text)
  assert.equal(result.bytes, Buffer.byteLength(result.text, 'utf8'))
})

test('WEBVTT 헤더 뒤에 빈 줄도 큐도 없는 파일에서 글이 사라지지 않는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const result = await transcription.transcribe({ body: 'WEBVTT\n안녕하세요\n네 알겠습니다\n', mime: 'text/vtt' })
  assert.equal(result.text, '안녕하세요\n네 알겠습니다')
  // 헤더 메타데이터(`Kind: captions`)는 여전히 사라진다.
  assert.equal(transcriptFromCues('WEBVTT\nKind: captions\nLanguage: ko\n안녕하세요\n'), '안녕하세요')
})

test('MIME이 형식을 분명히 말하면 확장자가 그것을 되살리지 못한다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01])
  for (const [mime, filename] of [['audio/webm', '9월 회의.txt'], ['audio/mpeg', '녹음.md'], ['application/pdf', '보고서.txt'], ['video/mp4', '회의.vtt']]) {
    assert.equal(transcriptFormatOf({ mime, filename }), null, `${mime} + ${filename}`)
    assert.equal(transcription.accepts(mime, filename), false, `${mime} + ${filename}`)
    await assert.rejects(
      () => transcription.transcribe({ body: webm, mime, filename }),
      (error) => {
        assert.equal(error.code, 'MEETING_SOURCE_UNSUPPORTED')
        assert.equal(error.status, 415)
        return true
      },
    )
  }
  // 형식을 말하는 MIME이 회의록 원문일 때는, 더 구체적인 확장자가 갈래를 정한다.
  assert.equal(transcriptFormatOf({ mime: 'text/plain', filename: '9월 회의.vtt' }), 'cue')
  assert.equal(transcriptFormatOf({ mime: 'text/plain; charset=utf-8', filename: '9월 회의.txt' }), 'plain')
})

test('설계가 선언한 숫자를 그대로 못 박는다 — 상수를 다시 import해 자기를 증명하지 않는다', () => {
  assert.equal(MAX_TRANSCRIPT_CHARS, 200_000)
  assert.equal(new TranscriptionError('X', '메시지').status, 400)
})

// ---------------------------------------------------------------------------
// M1 3회차 검증 지적 — 재현 테스트
// ---------------------------------------------------------------------------

test('종결자 없는 NOTE 블록은 블록이 아니다 — 타임코드 없는 파일에서 회의 내용이 통째로 사라지지 않는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  const source = [
    'WEBVTT',
    '9월 정례 회의',
    'NOTE 지난 회의 결과를 먼저 확인했습니다',
    '예산은 3000만원으로 확정했습니다',
    'REGION 확장 계획도 논의했습니다',
    '보고서를 금요일까지 보내 주세요',
    'STYLE 가이드 개정도 하기로 했습니다',
    '이상.',
  ].join('\n')
  const result = await transcription.transcribe({ body: source, mime: 'text/vtt', filename: 'e.vtt' })
  for (const line of source.split('\n').slice(1)) {
    assert.ok(result.text.includes(line), `블록을 닫는 줄이 없는데 삼켰다: ${line}`)
  }
  // 블록이 제대로 닫히면 지금처럼 사라진다 — 넓힌 것은 '종결자가 없을 때'뿐이다.
  const closed = 'WEBVTT\n\nNOTE 이건 진짜 주석이다\n\n00:00:01.000 --> 00:00:04.000\n예산은 3000만원으로 확정했습니다\n'
  assert.equal(transcriptFromCues(closed), '예산은 3000만원으로 확정했습니다')
  const nextCue = 'WEBVTT\n\nNOTE 이건 진짜 주석이다\n00:00:01.000 --> 00:00:04.000\n예산은 3000만원으로 확정했습니다\n'
  assert.equal(transcriptFromCues(nextCue), '예산은 3000만원으로 확정했습니다')
})

test('보이지 않는 글자만 든 파일은 다른 빈 파일과 같은 답을 받는다 — 빈 문단을 전사 결과라고 부르지 않는다', async () => {
  const transcription = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' }, fetchImpl: explodingFetch })
  // 공백·전각공백·BOM은 이미 거부된다. 폭 없는 공백(U+200B)·ZWNJ·soft hyphen만 통과하면
  // 같은 자리에서 답이 갈리고, 그 값이 요약으로 흘러가 사람에게는 빈 문단으로 보인다.
  for (const body of [' ', '　', '\uFEFF', '\u200B', '\u200B\u200B\u200B', '\u200C\u2060', '\u00AD', '\u200B \n\t']) {
    await assert.rejects(
      () => transcription.transcribe({ body, mime: 'text/plain', filename: 'a.txt' }),
      (error) => {
        assert.equal(error.code, 'MEETING_TRANSCRIPT_EMPTY', `보이지 않는 글자만 든 파일이 통과했다: ${JSON.stringify(body)}`)
        assert.equal(error.status, 400)
        return true
      },
    )
  }
  // 글 사이에 낀 폭 없는 글자는 걷어내되 사람이 쓴 글은 그대로 남긴다.
  const mixed = await transcription.transcribe({ body: '예산은\u200B 3000만원으로\uFEFF 확정했습니다', mime: 'text/plain', filename: 'a.txt' })
  assert.equal(mixed.text, '예산은 3000만원으로 확정했습니다')
  assert.equal(mixed.characters, countCharacters(mixed.text))
})

test('none 문구는 실제로 되는 설정을 말한다 — 어느 설정에서도 참이 아닌 약속을 하지 않는다', async () => {
  const none = createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'none' }, fetchImpl: explodingFetch })
  const message = await none
    .transcribe({ body: '김지훈: 라벨은 A안으로 확정했습니다.', mime: 'text/plain', filename: '9월 회의.txt' })
    .then(() => '', (error) => error.message)
  // ① 문구가 이름을 댄 설정값이 실제로 있는 값이어야 하고,
  const named = TRANSCRIPTION_PROVIDERS.filter((provider) => provider !== 'none' && message.includes(provider))
  assert.deepEqual(named, ['text'], `실재하지 않는 설정을 약속하는 문구다: ${message}`)
  assert.ok(message.includes('TRANSCRIPTION_PROVIDER'), '켜는 방법을 말하지 않으면 사람이 할 수 있는 일이 없다')
  // ② 그 설정에서 문구가 약속한 일이 실제로 되어야 한다.
  const configured = createTranscription({ env: { TRANSCRIPTION_PROVIDER: named[0] }, fetchImpl: explodingFetch })
  assert.equal(configured.accepts('text/plain', '9월 회의.txt'), true)
  const result = await configured.transcribe({ body: '김지훈: 라벨은 A안으로 확정했습니다.', mime: 'text/plain', filename: '9월 회의.txt' })
  assert.equal(result.text, '김지훈: 라벨은 A안으로 확정했습니다.')
  // ③ none 자신은 그 일을 한다고 말하지 않는다.
  assert.equal(none.accepts('text/plain', '9월 회의.txt'), false)
})
