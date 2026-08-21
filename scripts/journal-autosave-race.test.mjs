import assert from 'node:assert/strict'
import test from 'node:test'

import { readFile } from 'node:fs/promises'

import {
  canApplyGeneratedJournalDraft,
  canApplyJournalAutosaveToEditor,
  canFlushJournalDraftOnExit,
  nextJournalRevisionAfterConflict,
} from '../src/utils/journalAutosaveRevision.ts'

const collaborationSource = await readFile(new URL('../src/components/CollaborationSuite.tsx', import.meta.url), 'utf8')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('a delayed journal autosave response never replaces newer typing or attachment refs', async () => {
  let revision = 7
  let editor = { id: 'JR-RACE', completed: '• 첫 기록', attachments: [] }
  let dirty = true
  const uploadedRefs = new Set(['DOC-BEFORE'])
  const removedRefs = new Set(['DOC-REMOVED-BEFORE'])
  const request = { revision, journalId: editor.id, snapshot: structuredClone(editor) }
  const network = deferred()

  const responseTask = network.promise.then((saved) => {
    const canApply = canApplyJournalAutosaveToEditor({
      requestedRevision: request.revision,
      responseRevision: request.revision,
      currentRevision: revision,
      requestedJournalId: request.journalId,
      currentJournalId: editor.id,
      dirty,
    })
    if (canApply) {
      editor = saved
      dirty = false
      uploadedRefs.clear()
      removedRefs.clear()
    }
    return { saved, canApply }
  })

  // The employee keeps working while the PUT is waiting on the network.
  revision += 1
  editor = { ...editor, completed: '• 첫 기록\n• 네트워크 중 추가 입력', attachments: [{ id: 'DOC-NEW' }] }
  uploadedRefs.add('DOC-NEW')
  removedRefs.add('DOC-REMOVED-LATER')
  network.resolve({ ...request.snapshot, updatedAt: '2026-08-21T01:00:00.000Z' })

  const result = await responseTask
  assert.equal(result.canApply, false)
  assert.match(editor.completed, /네트워크 중 추가 입력/)
  assert.deepEqual(editor.attachments, [{ id: 'DOC-NEW' }])
  assert.equal(dirty, true)
  assert.deepEqual([...uploadedRefs], ['DOC-BEFORE', 'DOC-NEW'])
  assert.deepEqual([...removedRefs], ['DOC-REMOVED-BEFORE', 'DOC-REMOVED-LATER'])
})

test('an unchanged journal autosave response may commit and clear pending refs', () => {
  assert.equal(canApplyJournalAutosaveToEditor({
    requestedRevision: 3,
    responseRevision: 3,
    currentRevision: 3,
    requestedJournalId: 'JR-STABLE',
    currentJournalId: 'JR-STABLE',
    dirty: true,
  }), true)
})

test('pagehide flushes a newer revision even while an older autosave is pending', async () => {
  let stored = { draftRevision: 0, completed: '' }
  const saveMonotonic = async (snapshot, gate) => {
    await gate
    if (snapshot.draftRevision <= stored.draftRevision) return { ...stored, stale: true }
    stored = { ...snapshot }
    return { ...stored, stale: false }
  }
  const oldNetwork = deferred()
  const pagehideNetwork = deferred()
  const oldRequest = saveMonotonic({ draftRevision: 10, completed: '• 자동저장 시작 시점' }, oldNetwork.promise)

  const shouldFlush = canFlushJournalDraftOnExit({ dirty: true, editable: true, attachmentBusy: false })
  assert.equal(shouldFlush, true, 'pending autosave must not suppress pagehide flush')
  const pagehideRequest = saveMonotonic({ draftRevision: 11, completed: '• 자동저장 중 새 입력' }, pagehideNetwork.promise)

  // The pagehide request reaches storage first; the delayed older response is stale.
  pagehideNetwork.resolve()
  assert.equal((await pagehideRequest).stale, false)
  oldNetwork.resolve()
  assert.equal((await oldRequest).stale, true)
  assert.deepEqual(stored, { draftRevision: 11, completed: '• 자동저장 중 새 입력' })
})

test('pagehide does not race a manual save or approval submission', () => {
  assert.equal(canFlushJournalDraftOnExit({ dirty: true, editable: true, attachmentBusy: false, manualSaving: true }), false)
})

test('a stale response with a different server revision never replaces the editor', () => {
  assert.equal(canApplyJournalAutosaveToEditor({
    requestedRevision: 4,
    responseRevision: 5,
    currentRevision: 4,
    requestedJournalId: 'JR-STABLE',
    currentJournalId: 'JR-STABLE',
    dirty: true,
  }), false)
})

test('two tabs sending the same revision keep the losing tab dirty and retry above the server revision', () => {
  const tabB = {
    requestedRevision: 12,
    responseRevision: 12,
    currentRevision: 12,
    requestedJournalId: 'JR-SHARED',
    currentJournalId: 'JR-SHARED',
    dirty: true,
    stale: true,
  }

  assert.equal(canApplyJournalAutosaveToEditor(tabB), false)
  assert.equal(nextJournalRevisionAfterConflict(tabB), 13)
  assert.match(collaborationSource, /if \(body\.stale\) \{[\s\S]*?nextJournalRevisionAfterConflict/)
  assert.match(collaborationSource, /retryAfterConflict = true/)
  assert.match(collaborationSource, /autoSaveRetryTimerRef\.current = window\.setTimeout/)
})

test('manual journal writes lock all editable inputs until the request settles', () => {
  assert.match(collaborationSource, /journalManualSavingRef\.current = true/)
  assert.match(collaborationSource, /disabled=\{journalManualSaving\}[\s\S]*?onChange=\{\(event\) => updateEditor\('completed'/)
  assert.match(collaborationSource, /value=\{editor\.issue\} disabled=\{journalManualSaving\}/)
  assert.match(collaborationSource, /type="file" multiple disabled=\{journalManualSaving\}/)
  assert.match(collaborationSource, /journalManualSavingRef\.current = false/)
})

test('an AI draft cannot replace input changed while generation is pending', () => {
  const stable = {
    requestedRevision: 4,
    currentRevision: 4,
    requestedJournalId: 'JR-AI',
    currentJournalId: 'JR-AI',
    currentStatus: '임시저장',
    viewMode: 'editor',
    editorMode: 'edit',
    manualSaving: false,
  }
  assert.equal(canApplyGeneratedJournalDraft(stable), true)
  assert.equal(canApplyGeneratedJournalDraft({ ...stable, currentRevision: 5 }), false)
  assert.equal(canApplyGeneratedJournalDraft({ ...stable, viewMode: 'list' }), false)
  assert.equal(canApplyGeneratedJournalDraft({ ...stable, currentStatus: '결재요청' }), false)
  assert.equal(canApplyGeneratedJournalDraft({ ...stable, manualSaving: true }), false)
  assert.match(collaborationSource, /canApplyGeneratedJournalDraft\(\{[\s\S]*?requestedRevision,[\s\S]*?currentRevision: journalRevisionRef\.current/)
})
