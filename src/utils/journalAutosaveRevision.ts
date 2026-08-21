export type JournalAutosaveRevision = {
  requestedRevision: number
  responseRevision: number
  currentRevision: number
  requestedJournalId: string
  currentJournalId: string
  dirty: boolean
  stale?: boolean
}

/**
 * A delayed autosave response may update the shared list, but it may replace
 * the active editor only when the exact draft sent by that request is still
 * on screen. This keeps newer typing and attachment bookkeeping intact.
 */
export function canApplyJournalAutosaveToEditor(revision: JournalAutosaveRevision) {
  return revision.stale !== true
    && revision.dirty
    && revision.requestedRevision === revision.currentRevision
    && revision.requestedRevision === revision.responseRevision
    && revision.requestedJournalId === revision.currentJournalId
}

export function nextJournalRevisionAfterConflict(input: {
  requestedRevision: number
  responseRevision: number
  currentRevision: number
}) {
  return Math.max(input.requestedRevision, input.responseRevision, input.currentRevision) + 1
}

export function canApplyGeneratedJournalDraft(input: {
  requestedRevision: number
  currentRevision: number
  requestedJournalId: string
  currentJournalId: string
  currentStatus: string
  viewMode: string
  editorMode: string
  manualSaving: boolean
}) {
  return input.requestedRevision === input.currentRevision
    && input.requestedJournalId === input.currentJournalId
    && (input.currentStatus === '임시저장' || input.currentStatus === '반려')
    && input.viewMode === 'editor'
    && input.editorMode === 'edit'
    && !input.manualSaving
}

export function canFlushJournalDraftOnExit(input: { dirty: boolean; editable: boolean; attachmentBusy: boolean; manualSaving?: boolean }) {
  return input.dirty && input.editable && !input.attachmentBusy && input.manualSaving !== true
}
