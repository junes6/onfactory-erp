import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('inventory defaults to four-column compact warehouses and preserves the large LOT view', () => {
  assert.match(app, /useState<'compact' \| 'large'>\('compact'\)/)
  assert.match(app, /className=\{`warehouse-grid is-\$\{warehouseView\}`\}/)
  assert.match(app, /warehouseView === 'compact' \? '크게 보기' : '컴팩트 보기'/)
  assert.match(css, /\.warehouse-grid\.is-compact\s*\{[^}]*repeat\(4,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /\.warehouse-grid\.is-large\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
})

test('warehouse cards reuse the real movement ledger for quick stock changes and recent activity', () => {
  assert.match(app, /const recentMovements = \[\.\.\.movements\]\.filter\(\(movement\) => movement\.warehouseId === location\.id\)\.sort\(\(a, b\) => b\.occurredAt\.localeCompare\(a\.occurredAt\)\)\.slice\(0, 2\)/)
  assert.match(app, /openWarehouseMovement\(location\.id, '입고'\)[\s\S]*?재고 추가/)
  assert.match(app, /openWarehouseMovement\(location\.id, '출고'\)[\s\S]*?재고 차감/)
  assert.match(app, /defaultValue=\{movementPreset\?\.direction \?\? '입고'\}/)
  assert.match(app, /defaultValue=\{movementPreset\?\.warehouseId \?\? locations\[0\]\?\.id \?\? ''\}/)
  assert.match(app, /if \(direction === '출고'\)[\s\S]*?quantity > currentLot\.quantity/)
  assert.match(app, /setMovements\(\(current\) => \[movement, \.\.\.current\]\)/)
})
