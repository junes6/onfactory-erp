import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
const [app, collaboration, dashboard, business, factory, people, library, compliance, taxAssets, taxWorkspace, ipRights, apiSmoke, quickLinkSmoke, workspaceHook, serverApp, packageJsonText] = await Promise.all([
  read('src/App.tsx'),
  read('src/components/CollaborationSuite.tsx'),
  read('src/components/DashboardWorkspace.tsx'),
  read('src/components/BusinessPages.tsx'),
  read('src/components/FactoryManagement.tsx'),
  read('src/components/PeopleOperations.tsx'),
  read('src/components/CompanyLibrary.tsx'),
  read('src/components/ComplianceCenter.tsx'),
  read('src/components/TaxAssets.tsx'),
  read('src/components/TaxWorkspace.tsx'),
  read('src/components/IpRights.tsx'),
  read('server/store/menu-write-smoke.test.mjs'),
  read('scripts/quick-links-storage.test.mjs'),
  read('src/hooks/useWorkspaceState.ts'),
  read('server/app.mjs'),
  read('package.json'),
])

function expectAll(source, checks, screen) {
  for (const [pattern, message] of checks) {
    assert.match(source, pattern, `${screen}: ${message}`)
  }
}

const contracts = [
  {
    screen: 'AI 업무허브', persistenceId: 'localStorage:onfactory-dashboard-links', source: dashboard, checks: [
      [/quickLinksStorageKey\(scope\)/, 'tenant/user scoped refresh key'],
      [/writeQuickLinks\(window\.localStorage, storageKey, links\)/, 'refresh persistence'],
      [/<form className="dashboard-link-form" onSubmit=\{submit\}>/, 'create/update form wiring'],
      [/editingId\s*\? current\.map\(\(link\) => link\.id === editingId/, 'edit updates the visible list'],
      [/: \[\.\.\.current, \{ id: `LINK-\$\{Date\.now\(\)\}`/, 'create updates the visible list'],
      [/aria-label=\{`\$\{link\.name\} 수정`\}[\s\S]*?setEditingId\(link\.id\)/, 'edit button wiring'],
      [/aria-label=\{`\$\{link\.name\} 삭제`\}[\s\S]*?current\.filter\(\(item\) => item\.id !== link\.id\)/, 'delete button wiring'],
      [/className="text-button"[\s\S]*?onClick=\{onOpenLibrary\}[\s\S]*?자료실 열기/, 'company library action follows the shared dashboard tone'],
    ],
  },
  {
    screen: '일정관리', persistenceId: 'calendar-events', source: collaboration, checks: [
      [/useWorkspaceState<CalendarEvent\[]>\('calendar-events'/, 'shared refresh source'],
      [/const saveEvent = async[\s\S]*?current\.map\(\(event\) => event\.id === editingId[\s\S]*?\[\.\.\.current, \{ \.\.\.ownedDraft, id:/, 'create and update handlers'],
      [/const saveEvent = async[\s\S]*?if \(!result\.ok\)[\s\S]*?if \(!result\.ok\)/, 'both write failures stop the UI flow'],
      [/const deleteEvent = async[\s\S]*?current\.filter\(\(event\) => event\.id !== editingId\)[\s\S]*?if \(!result\.ok\)/, 'delete failure handling'],
      [/onSave=\{saveEvent\}[\s\S]*?onDelete=\{deleteEvent\}/, 'dialog save/delete wiring'],
      [/onClick=\{\(\) => openCreate\(\)\}[\s\S]*?> 일정 등록<\/button>/, 'create button wiring'],
    ],
  },
  {
    screen: '업무지시·결재', persistenceId: 'work-rules', source: app, checks: [
      [/useWorkspaceState<WorkRule\[]>\('work-rules'/, 'shared refresh source'],
      [/const createWorkRule = async[\s\S]*?setWorkRules\(\(current\) => \[body\.rule!, \.\.\.current/, 'create response immediately updates the list'],
      [/const toggleWorkRule = async[\s\S]*?method: 'PATCH'[\s\S]*?current\.map\(\(item\) => item\.id === rule\.id/, 'update handler and immediate list update'],
      [/const deleteWorkRule = async[\s\S]*?current\.filter\(\(item\) => item\.id !== rule\.id\)[\s\S]*?if \(!result\.ok\)/, 'delete handler and failure handling'],
      [/onSubmit=\{onCreateRule\}/, 'create form wiring'],
      [/onClick=\{\(\) => void onToggleRule\(rule\)\}/, 'update button wiring'],
      [/onClick=\{\(\) => void onDeleteRule\(rule\)\}/, 'delete button wiring'],
    ],
  },
  {
    screen: '일일업무일지', persistenceId: 'daily-journals', source: collaboration, checks: [
      [/useWorkspaceState<Journal\[]>\('daily-journals'/, 'shared refresh source'],
      [/const persistJournal = async[\s\S]*?current\.some\(\(journal\) => journal\.id === saved\.id\)[\s\S]*?current\.map[\s\S]*?: \[saved, \.\.\.current\][\s\S]*?if \(!result\.ok\)/, 'create/update with failure rollback'],
      [/const deleteJournalDraft = async[\s\S]*?editor\.status !== '임시저장'[\s\S]*?current\.filter\(\(journal\) => journal\.id !== editor\.id\)[\s\S]*?if \(!result\.ok\)/, 'only an own draft can be deleted and failure is handled'],
      [/onClick=\{\(\) => void deleteJournalDraft\(\)\}/, 'delete button wiring'],
      [/onClick=\{saveDraft\}/, 'save/update button wiring'],
      [/onClick=\{\(\) => void createJournal\(\)\}/, 'create button wiring'],
      [/setInterval\([\s\S]*?autoSaveActionRef\.current/, 'refresh-safe 30 second draft persistence path'],
    ],
  },
  {
    screen: '제품관리', persistenceId: 'product-catalog', source: business, checks: [
      [/useWorkspaceState<ManagedProduct\[]>\([\s\S]*?'product-catalog'/, 'shared refresh source'],
      [/const saveProduct = async[\s\S]*?isNew[\s\S]*?\[next, \.\.\.current\][\s\S]*?current\.map[\s\S]*?if \(!result\.ok\)/, 'create/update and failure handling'],
      [/const deleteProduct = async[\s\S]*?current\.filter\(\(item\) => item\.id !== product\.id\)[\s\S]*?if \(!result\.ok\)/, 'delete and failure handling'],
      [/onSave=\{saveProduct\}/, 'editor form save wiring'],
      [/onEdit=\{\(\) => openEditor\(selectedProduct\.id\)\}/, 'edit button wiring'],
      [/onDelete=\{\(\) => void deleteProduct\(selectedProduct\)\}/, 'delete button wiring'],
    ],
  },
  {
    screen: '재고·LOT', persistenceId: 'inventory-locations', source: app, checks: [
      [/useWorkspaceState<WarehouseLocation\[]>\('inventory-locations'/, 'shared refresh source'],
      [/const saveWarehouse = async[\s\S]*?editing === 'new'[\s\S]*?\[\.\.\.current, \{ id: `WH-[\s\S]*?current\.map\(\(item\) => item\.id === editing\.id[\s\S]*?if \(!result\.ok\)/, 'create/update and failure handling'],
      [/const removeWarehouse = async[\s\S]*?current\.filter\(\(item\) => item\.id !== editing\.id\)[\s\S]*?if \(!result\.ok\)/, 'delete and failure handling'],
      [/<form onSubmit=\{saveWarehouse\}>/, 'warehouse form wiring'],
      [/onClick=\{\(\) => setEditing\('new'\)\}[\s\S]*?> 창고 등록<\/button>/, 'create button wiring'],
      [/onClick=\{\(\) => void removeWarehouse\(\)\}/, 'delete button wiring'],
      [/<h3>아직 등록된 항목이 없습니다<\/h3>[\s\S]*?첫 창고 등록/, 'empty state first action'],
    ],
  },
  {
    screen: '공장관리', persistenceId: 'factory-layouts', source: factory, checks: [
      [/useWorkspaceState<FactoryLayouts>\('factory-layouts'/, 'shared refresh source'],
      [/const registerFactory = async[\s\S]*?setLayouts\(\(current\) => \(\{ \.\.\.current, \[next\.id\]: \[\] \}\)\)[\s\S]*?if \(!result\.ok\)/, 'factory create and failure handling'],
      [/const saveLocation = async[\s\S]*?current\.map[\s\S]*?: \[\.\.\.current, location\][\s\S]*?if \(!result\.ok\)/, 'location create/update and failure handling'],
      [/const deleteFactory = async[\s\S]*?delete next\[factory\.id\][\s\S]*?if \(!layoutResult\.ok\)/, 'factory delete and failure handling'],
      [/onClick=\{\(\) => void registerFactory\(\)\}[\s\S]*?첫 공장 등록/, 'empty state create wiring'],
      [/onClick=\{\(\) => void deleteFactory\(\)\}/, 'delete button wiring'],
      [/onChange=\{\(patch\) => selectedBlock && updateBlock\(selectedBlock\.id, patch\)\}/, 'block mouse/inspector update wiring'],
      [/onSave=\{saveLocation\}/, 'location editor form wiring'],
    ],
  },
  {
    screen: '판매채널', persistenceId: 'sales-shipments', source: business, checks: [
      [/useWorkspaceState<SalesShipment\[]>\([\s\S]*?'sales-shipments'/, 'shared refresh source'],
      [/const saveShipment = async[\s\S]*?current\.map\(\(item\) => item\.id === shipment\.id[\s\S]*?: \[shipment, \.\.\.current\][\s\S]*?if \(!result\.ok\)/, 'shipment create/update and failure handling'],
      [/const deleteShipment = async[\s\S]*?current\.filter\(\(item\) => item\.id !== shipment\.id\)[\s\S]*?result\.ok \?/, 'shipment delete result handling'],
      [/onClick=\{\(\) => setShipmentDialog\('new'\)\}[\s\S]*?> 배송 주문 등록<\/button>/, 'create button wiring'],
      [/onSave=\{saveShipment\}/, 'editor form wiring'],
      [/confirmShipmentDeleteId === shipment\.id \? void deleteShipment\(shipment\)/, 'confirmed delete button wiring'],
    ],
  },
  {
    screen: '인사·조직', persistenceId: 'leave-requests', source: people, checks: [
      [/useWorkspaceState<LeaveRequest\[]>\('leave-requests'/, 'shared refresh source'],
      [/fetch\(editingLeaveId \? `\/api\/leave-requests\/\$\{encodeURIComponent\(editingLeaveId\)\}` : '\/api\/leave-requests'/, 'create/update route selection'],
      [/method: editingLeaveId \? 'PATCH' : 'POST'/, 'create/update method wiring'],
      [/editingLeaveId[\s\S]*?current\.map\(\(item\) => item\.id === result\.leave!\.id[\s\S]*?: \[result\.leave!, \.\.\.current\.filter/, 'create/update response immediately updates the list'],
      [/const cancelLeave = async[\s\S]*?method: 'DELETE'[\s\S]*?current\.filter\(\(item\) => item\.id !== request\.id\)/, 'delete response immediately updates the list'],
      [/openModal\('leave', event\.currentTarget, undefined, request\)/, 'pending leave edit button wiring'],
      [/onClick=\{\(\) => void cancelLeave\(request\)\}/, 'pending leave cancel button wiring'],
      [/<form onSubmit=\{submitLeave\}>/, 'leave form wiring'],
    ],
  },
  {
    screen: '기업 자료실', persistenceId: 'documents-api', source: library, checks: [
      [/useEffect\(\(\) => \{ if \(workspaceScope\) void load\(\) \}, \[workspaceScope\]\)/, 'refresh reload from document API'],
      [/<form onSubmit=\{async \(event: FormEvent<HTMLFormElement>\) =>/, 'upload/update form wiring'],
      [/if \(document\)[\s\S]*?method: 'PATCH'[\s\S]*?else[\s\S]*?method: 'POST'/, 'update/create API selection'],
      [/if \(!response\.ok\) throw new Error[\s\S]*?await onSaved\(\); onClose\(\)/, 'failure handling before list reload'],
      [/const remove = async[\s\S]*?method: 'DELETE'[\s\S]*?if \(!response\.ok\)[\s\S]*?await load\(\)/, 'delete failure handling and immediate reload'],
      [/onClick=\{\(\) => setEditing\('new'\)\}[\s\S]*?> 자료 업로드<\/button>/, 'create button wiring'],
      [/onClick=\{\(\) => setEditing\(document\)\}/, 'edit button wiring'],
      [/onClick=\{\(\) => remove\(document\)\}/, 'delete button wiring'],
    ],
  },
  {
    screen: '식품안전·인증', persistenceId: 'compliance-records', source: compliance, checks: [
      [/useWorkspaceState<ComplianceRecord\[]>\('compliance-records'/, 'shared refresh source'],
      [/const save = async[\s\S]*?current\.some[\s\S]*?current\.map[\s\S]*?: \[record, \.\.\.current\][\s\S]*?if \(result\.ok\)[\s\S]*?else onToast/, 'create/update result handling'],
      [/const remove = async[\s\S]*?current\.filter\(\(item\) => item\.id !== record\.id\)[\s\S]*?if \(!result\.ok\)/, 'delete failure handling'],
      [/onClick=\{\(\) => setEditing\('new'\)\}[\s\S]*?> 새 항목 등록<\/button>/, 'create button wiring'],
      [/onClick=\{\(\) => setEditing\(record\)\}/, 'edit button wiring'],
      [/onClick=\{\(\) => void remove\(record\)\}/, 'delete button wiring'],
      [/onSave=\{save\}/, 'editor form wiring'],
      [/requestDocumentExtraction\(attachment\.id, 'compliance'/, 'stored certificate content extraction'],
      [/applyBlankFormValues\(formRef\.current, values\)/, 'AI draft fills only blank review fields'],
      [/인증서 원본부터 올려 주세요/, 'file-first registration flow'],
    ],
  },
  {
    screen: '세무·자산 · 자산대장', persistenceId: 'company-assets', source: taxAssets, checks: [
      [/useWorkspaceState<CompanyAsset\[]>\('company-assets'/, 'shared refresh source'],
      [/const removeAsset = async[\s\S]*?current\.filter\(\(item\) => item\.id !== asset\.id\)[\s\S]*?if \(!result\.ok\)/, 'delete and failure handling'],
      [/<form onSubmit=\{submit\}>/, 'create/update form wiring'],
      [/onSave=\{async \(next\) => \{[\s\S]*?setAssets\(\(current\) => current\.some[\s\S]*?: \[next, \.\.\.current\]/, 'create/update list synchronization'],
      [/onClick=\{\(\) => setEditingAsset\('new'\)\}/, 'create button wiring'],
      [/onClick=\{\(\) => void removeAsset\(asset\)\}/, 'delete button wiring'],
    ],
  },
  {
    screen: '세무·자산 · 세무일정', persistenceId: 'tax-events', source: taxWorkspace, checks: [
      [/useWorkspaceState<TaxRecord\[]>\('tax-events'/, 'shared refresh source'],
      [/buildProvidedTaxSchedule\(profile, year\)/, 'company profile generates the schedule'],
      [/recordType: 'profile'/, 'profile record persistence'],
      [/recordType: 'schedule'/, 'provided schedule progress persistence'],
      [/setRecords\(\(current\) => current\.some[\s\S]*?current\.map[\s\S]*?: \[next, \.\.\.current\]/, 'create/update list synchronization'],
      [/tags: \['tax-evidence', `tax-year:\$\{year\}`, `tax-bucket:\$\{uploadBucket\}`\]/, 'annual evidence tags'],
      [/`\/api\/tax\/evidence-export\?year=\$\{year\}`/, 'annual accountant archive download'],
      [/국세청 원문/, 'official source link'],
    ],
  },
  {
    screen: '지식재산·인증', persistenceId: 'ip-rights', source: ipRights, checks: [
      [/useWorkspaceState<IpRight\[]>\('ip-rights'/, 'shared refresh source'],
      [/const remove = async[\s\S]*?current\.filter\(\(item\) => item\.id !== right\.id\)[\s\S]*?if \(!result\.ok\)/, 'delete and failure handling'],
      [/<form ref=\{formRef\} onSubmit=\{submit\}>/, 'create/update form wiring'],
      [/onSave=\{async \(next\) => \{[\s\S]*?setRights\(\(current\) => current\.some[\s\S]*?: \[next, \.\.\.current\]/, 'create/update list synchronization'],
      [/onClick=\{\(\) => setEditor\(\{\}\)\}/, 'create button wiring'],
      [/onClick=\{\(\) => void remove\(right\)\}/, 'delete button wiring'],
      [/requestDocumentExtraction\(attachment\.id, 'ip-right'/, 'stored patent content extraction'],
      [/applyBlankFormValues\(formRef\.current, values\)/, 'AI draft fills only blank review fields'],
      [/deleteDocumentAttachments\(removedRef\.current, workspaceScope\)/, 'detached originals are removed only after a successful save'],
      [/if \(busy \|\| uploading \|\| closingRef\.current\) return/, 'modal cannot close while an upload or save is in flight'],
      [/for \(const id of cleanup\.deleted\) uploadedRef\.current\.delete\(id\)/, 'partial cancel cleanup retries only failed originals'],
      [/useIpDialog\(\(\) => \{ void cancel\(\) \}, locked, \(\) => item \? titleInputRef\.current : uploadButtonRef\.current\)/, 'dialog traps focus and restores it on close'],
    ],
  },
]

for (const contract of contracts) {
  test(`${contract.screen} UI create → update → delete wiring contract`, () => {
    expectAll(contract.source, contract.checks, contract.screen)
  })
}

test('all UI contracts stay paired to the same persistence target exercised by lifecycle smoke', () => {
  assert.equal(contracts.length, 14)
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const { screen, persistenceId } of contracts) {
    if (persistenceId.startsWith('localStorage:')) {
      assert.match(quickLinkSmoke, /create → 재구성 → update → 재구성 → delete/, `${screen} localStorage lifecycle missing`)
      assert.match(quickLinkSmoke, new RegExp(escape(persistenceId.slice('localStorage:'.length))), `${screen} localStorage target mismatch`)
      continue
    }
    const pairedCase = persistenceId === 'documents-api'
      ? /const documentCase = \{ screen: '기업 자료실', persistenceId: 'documents-api' \}/
      : new RegExp(`screen: '${escape(screen)}', key: '${escape(persistenceId)}'`)
    assert.match(apiSmoke, pairedCase, `${screen} UI target ${persistenceId} is not the lifecycle target`)
  }
  for (const marker of ['CREATE', 'RESTART/PERSIST', 'UPDATE', 'RESTART/UPDATE-PERSIST', 'DELETE', 'FINAL RESTART/EMPTY']) {
    const dynamicCount = '\\$\\{workspaceCases\\.length \\+ 1\\}\\/\\$\\{workspaceCases\\.length \\+ 1\\}'
    assert.match(apiSmoke, new RegExp(`t\\.diagnostic\\(\\\`${marker.replace('/', '\\/')} ${dynamicCount} PASS`), `missing dynamic lifecycle marker: ${marker}`)
  }
  assert.ok((apiSmoke.match(/await withRuntimeApp\(/g) ?? []).length >= 4, 'create/update/delete must each cross isolated app/store restarts')
  const packageJson = JSON.parse(packageJsonText)
  assert.match(packageJson.scripts['test:server'], /server\/store\/\*\.test\.mjs/)
  assert.match(packageJson.scripts['test:server'], /scripts\/\*\.test\.mjs/)
})

test('tax workspace provides schedules and evidence instead of asking users to register statutory dates', () => {
  assert.doesNotMatch(taxAssets, /세무 일정 등록|첫 세무 일정 등록/)
  assert.match(taxWorkspace, /회사 세무 조건을 한 번 설정/)
  assert.match(taxWorkspace, /증빙 파일함/)
  assert.match(taxWorkspace, /세무사 전달 묶음 받기/)
})

test('dedicated workspace writes synchronize the next generic write version', () => {
  assert.match(workspaceHook, /serverVersion\?: string/)
  assert.match(workspaceHook, /writeOptions\.persist === false[\s\S]*?serverVersionRef\.current = writeOptions\.serverVersion/)
  assert.match(app, /setWorkRules\([^\n]+\{ persist: false, serverVersion: body\.version \}\)/)
  assert.match(app, /setWorkItems\([^\n]+\{ persist: false, serverVersion: body\.workItemsVersion \}\)/)
  assert.match(collaboration, /setJournals\([\s\S]{0,500}\{ persist: false, serverVersion: body\.version \}\)/)
  assert.match(serverApp, /app\.put\('\/api\/daily-journals\/:id\/draft'[\s\S]*?version: workspaceRecordVersion\(record\)/)
  assert.match(serverApp, /app\.post\('\/api\/work-rules'[\s\S]*?version: workspaceRecordVersion\(tenantStore\['work-rules'\]\)/)
})

test('journal and leave UI ownership never falls back to display-name equality', () => {
  assert.doesNotMatch(collaboration, /journal\.author === currentUser/)
  assert.doesNotMatch(people, /request\.name === currentUser/)
  assert.match(collaboration, /journal\.authorId === currentUserId/)
  assert.match(people, /request\.requesterId === currentUserId/)
})
