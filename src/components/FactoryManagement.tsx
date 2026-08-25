import {
  AlertTriangle,
  Archive,
  Boxes,
  BrickWall,
  CheckCircle2,
  ChevronDown,
  DoorOpen,
  Download,
  Edit3,
  Factory as FactoryIcon,
  FileImage,
  FileText,
  Layers3,
  Map as MapIcon,
  MousePointer2,
  Move,
  PackageCheck,
  Palette,
  Plus,
  Save,
  ShieldCheck,
  Snowflake,
  Truck,
  Trash2,
  UploadCloud,
  Warehouse,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import './FactoryManagement.css'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'

type FactoryManagementProps = {
  onToast: (message: string) => void
  canManage: boolean
  companyName?: string
  workspaceScope?: string
}

type ZoneKind = 'raw' | 'frozen' | 'production' | 'packing' | 'shipping'
type ZoneState = '정상' | '주의' | '가동중' | '출하중' | '대기'
type LocationKind = '재고' | '생산'
type LocationState = '정상' | '주의' | '점검' | '비가동'

type FactoryZone = {
  id: ZoneKind
  name: string
  shortName: string
  state: ZoneState
  utilization: number
  primaryLabel: string
  primaryValue: string
  secondaryLabel: string
  secondaryValue: string
  condition: string
  manager: string
  note: string
  nextAction: string
}

type FactoryDefinition = {
  id: string
  name: string
  code: string
  address: string
  area: string
  zones: FactoryZone[]
}

type FactoryLocation = {
  id: string
  factoryId: string
  zoneId: ZoneKind
  kind: LocationKind
  name: string
  code: string
  item: string
  current: number
  capacity: number
  unit: string
  status: LocationState
  note: string
}

type DrawingMeta = {
  id: string
  kind: 'image' | 'pdf'
  name: string
  size: number
  mime: string
  uploadedAt?: string
  url?: string
}

type CompanyDocumentMeta = {
  id: string
  name: string
  originalName?: string
  mime: string
  size: number
  category: string
  tags?: string[]
  uploadedAt?: string
}

type LayoutPurpose = '원료·자재' | '냉장·냉동' | '생산' | '포장' | '출하' | '통로' | '벽' | '문' | '기타'

type LayoutBlock = {
  id: string
  factoryId: string
  zoneId: ZoneKind
  name: string
  purpose: LayoutPurpose
  kind: LocationKind
  x: number
  y: number
  width: number
  height: number
  color: string
  item: string
  current: number
  capacity: number
  unit: string
  note: string
}

type FactoryLayouts = Record<string, LayoutBlock[]>

const layoutColorOptions = [
  { value: 'var(--color-success-soft)', label: '초록 · 원료/안전' },
  { value: 'var(--color-blue-soft)', label: '하늘 · 냉장냉동' },
  { value: 'var(--color-warning-soft)', label: '주황 · 생산/주의' },
  { value: 'var(--color-danger-soft)', label: '빨강 · 위험/점검' },
  { value: 'var(--color-primary-soft)', label: '파랑 · 강조' },
  { value: 'var(--color-violet-soft)', label: '보라 · 특수구역' },
  { value: 'var(--color-teal-soft)', label: '청록 · 위생구역' },
  { value: 'var(--color-rose-soft)', label: '분홍 · 검사/QC' },
  { value: 'var(--color-gray-200)', label: '회색 · 설비' },
  { value: 'var(--color-gray-50)', label: '연회색 · 통로' },
] as const

const layoutColorValues = new Set<string>(layoutColorOptions.map((option) => option.value))

function layoutTokenColor(block: Pick<LayoutBlock, 'color' | 'zoneId'>) {
  if (layoutColorValues.has(block.color)) return block.color
  if (block.zoneId === 'raw') return 'var(--color-success-soft)'
  if (block.zoneId === 'frozen') return 'var(--color-blue-soft)'
  if (block.zoneId === 'production') return 'var(--color-warning-soft)'
  if (block.zoneId === 'packing') return 'var(--color-gray-200)'
  return 'var(--color-gray-50)'
}

type LocationDraft = Omit<FactoryLocation, 'id' | 'factoryId' | 'current' | 'capacity'> & {
  current: string
  capacity: string
}

type LocationModalState =
  | { mode: 'create'; location?: undefined }
  | { mode: 'edit'; location: FactoryLocation }

function createCustomerFactory(companyName?: string, id = `FAC-${Date.now()}`): FactoryDefinition {
  const company = companyName?.trim() || '우리 회사'
  const zone = (id: ZoneKind, name: string, shortName: string): FactoryZone => ({
    id,
    name,
    shortName,
    state: '대기',
    utilization: 0,
    primaryLabel: '등록 위치',
    primaryValue: '0곳',
    secondaryLabel: '연결 품목·설비',
    secondaryValue: '0개',
    condition: '센서 미연결',
    manager: '담당자 미지정',
    note: '배치 블록을 추가하고 실제 운영 정보를 연결해 주세요.',
    nextAction: '편집 모드에서 첫 공간 블록 등록',
  })
  return {
    id,
    name: `${company} 제1공장`,
    code: 'MAIN-01',
    address: '주소 미등록',
    area: '면적 미등록',
    zones: [
      zone('raw', '원료·자재 구역', '원료'),
      zone('frozen', '냉장·냉동 구역', '냉동'),
      zone('production', '생산 구역', '생산'),
      zone('packing', '포장 구역', '포장'),
      zone('shipping', '출하 구역', '출하'),
    ],
  }
}

const emptyFactoryLayouts: FactoryLayouts = {}
const emptyFactoryLocations: FactoryLocation[] = []

function isLayoutBlock(value: unknown): value is LayoutBlock {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<LayoutBlock>
  return typeof item.id === 'string' && typeof item.factoryId === 'string' && typeof item.name === 'string'
    && ['raw', 'frozen', 'production', 'packing', 'shipping'].includes(item.zoneId ?? '')
    && ['원료·자재', '냉장·냉동', '생산', '포장', '출하', '통로', '벽', '문', '기타'].includes(item.purpose ?? '')
    && ['재고', '생산'].includes(item.kind ?? '') && typeof item.color === 'string'
    && ['x', 'y', 'width', 'height', 'current', 'capacity'].every((key) => typeof item[key as keyof LayoutBlock] === 'number')
    && typeof item.item === 'string' && typeof item.unit === 'string' && typeof item.note === 'string'
}

const isFactoryLayouts = (value: unknown): value is FactoryLayouts => Boolean(value) && typeof value === 'object'
  && Object.values(value as Record<string, unknown>).every((blocks) => Array.isArray(blocks) && blocks.every(isLayoutBlock))

function isFactoryLocation(value: unknown): value is FactoryLocation {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<FactoryLocation>
  return typeof item.id === 'string' && typeof item.factoryId === 'string'
    && ['raw', 'frozen', 'production', 'packing', 'shipping'].includes(item.zoneId ?? '')
    && ['재고', '생산'].includes(item.kind ?? '') && typeof item.name === 'string'
    && typeof item.code === 'string' && typeof item.item === 'string'
    && typeof item.current === 'number' && Number.isFinite(item.current)
    && typeof item.capacity === 'number' && Number.isFinite(item.capacity)
    && typeof item.unit === 'string' && ['정상', '주의', '점검', '비가동'].includes(item.status ?? '')
    && typeof item.note === 'string'
}

const isFactoryLocationList = (value: unknown): value is FactoryLocation[] => Array.isArray(value) && value.every(isFactoryLocation)

const zonePresentation: Record<ZoneKind, { icon: LucideIcon; className: string }> = {
  raw: { icon: Archive, className: 'raw' },
  frozen: { icon: Snowflake, className: 'frozen' },
  production: { icon: FactoryIcon, className: 'production' },
  packing: { icon: PackageCheck, className: 'packing' },
  shipping: { icon: Truck, className: 'shipping' },
}

const statusTone = (state: ZoneState | LocationState): StatusBadgeTone => {
  if (state === '주의' || state === '점검') return 'warning'
  if (state === '대기' || state === '비가동') return 'neutral'
  return 'success'
}

const formatFileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FactoryStatusBadge({ state }: { state: ZoneState | LocationState }) {
  return <StatusBadge className="factory-status" dot tone={statusTone(state)}>{state}</StatusBadge>
}

function ZoneIcon({ kind, size = 20 }: { kind: ZoneKind; size?: number }) {
  const Icon = zonePresentation[kind].icon
  return <Icon size={size} aria-hidden="true" />
}

const MIN_BLOCK_SIZE = 8
const MIN_STRUCTURE_SIZE = 1.5
const BLOCK_GAP = .6

/** 벽·문은 공간 블록이 아니라 구조물로 취급한다 — 얇게 그릴 수 있고 다른 블록과 겹쳐도 된다. */
function isStructureBlock(block: Pick<LayoutBlock, 'purpose'>) {
  return block.purpose === '벽' || block.purpose === '문'
}

function blockMinSize(block: Pick<LayoutBlock, 'purpose'>) {
  return isStructureBlock(block) ? MIN_STRUCTURE_SIZE : MIN_BLOCK_SIZE
}

function blocksOverlap(left: LayoutBlock, right: LayoutBlock, gap = BLOCK_GAP) {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y
}

function normalizeBlockGeometry(block: LayoutBlock): LayoutBlock {
  const round = (value: number) => Math.round(value * 10) / 10
  const minSize = blockMinSize(block)
  const width = round(Math.min(100, Math.max(minSize, block.width)))
  const height = round(Math.min(100, Math.max(minSize, block.height)))
  return {
    ...block,
    width,
    height,
    x: round(Math.min(100 - width, Math.max(0, block.x))),
    y: round(Math.min(100 - height, Math.max(0, block.y))),
  }
}

function findFreeBlockPosition(blocks: LayoutBlock[], width: number, height: number) {
  for (let y = 3; y <= 100 - height; y += 4) {
    for (let x = 3; x <= 100 - width; x += 4) {
      const candidate = { x, y, width, height } as LayoutBlock
      if (!blocks.some((block) => blocksOverlap(candidate, block))) return { x, y }
    }
  }
  return null
}

function LayoutEditor({ factory, blocks, selectedId, editable, drawing, showBackground, onSelect, onChange }: {
  factory: FactoryDefinition
  blocks: LayoutBlock[]
  selectedId: string | null
  editable: boolean
  drawing?: DrawingMeta
  showBackground: boolean
  onSelect: (block: LayoutBlock) => void
  onChange: (id: string, patch: Partial<LayoutBlock>, persist?: boolean) => void
}) {
  type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'
  type BlockGesture = {
    kind: 'move' | 'resize'
    corner?: ResizeCorner
    id: string
    pointerId: number
    startX: number
    startY: number
    original: LayoutBlock
  }
  const viewportRef = useRef<HTMLDivElement>(null)
  // React의 onWheel은 passive라 preventDefault가 먹지 않는다 → 배치 편집기 위에서 휠을 돌리면 페이지가 함께 스크롤되던 문제.
  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const stopPageScroll = (event: WheelEvent) => { event.preventDefault() }
    node.addEventListener('wheel', stopPageScroll, { passive: false })
    return () => node.removeEventListener('wheel', stopPageScroll)
  }, [])
  const gestureRef = useRef<BlockGesture | null>(null)
  const gesturePersistTimerRef = useRef<number | null>(null)
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [interactionMessage, setInteractionMessage] = useState('배경을 드래그해 이동하고 마우스 휠로 확대·축소할 수 있습니다.')

  const queueGesturePersist = (id: string) => {
    if (gesturePersistTimerRef.current !== null) window.clearTimeout(gesturePersistTimerRef.current)
    gesturePersistTimerRef.current = window.setTimeout(() => {
      gesturePersistTimerRef.current = null
      onChange(id, {}, true)
    }, 220)
  }

  useEffect(() => () => {
    if (gesturePersistTimerRef.current !== null) window.clearTimeout(gesturePersistTimerRef.current)
  }, [])

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value * 10) / 10))
  const moveBlock = (block: LayoutBlock, x: number, y: number) => onChange(block.id, {
    x: clamp(x, 0, 100 - block.width),
    y: clamp(y, 0, 100 - block.height),
  })

  const constrainPan = (next: { x: number; y: number }, nextZoom = zoom) => {
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (!bounds) return next
    if (nextZoom < 1) return { x: (bounds.width * (1 - nextZoom)) / 2, y: (bounds.height * (1 - nextZoom)) / 2 }
    const edge = 48
    const minX = Math.min(edge, bounds.width - (bounds.width * nextZoom) + edge)
    const minY = Math.min(edge, bounds.height - (bounds.height * nextZoom) + edge)
    return {
      x: clamp(next.x, minX, edge),
      y: clamp(next.y, minY, edge),
    }
  }

  const applyZoom = (nextValue: number, anchor?: { x: number; y: number }) => {
    const nextZoom = clamp(nextValue, .65, 2.2)
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (!bounds || nextZoom === zoom) return
    const point = anchor ?? { x: bounds.width / 2, y: bounds.height / 2 }
    const nextPan = {
      x: point.x - ((point.x - pan.x) / zoom) * nextZoom,
      y: point.y - ((point.y - pan.y) / zoom) * nextZoom,
    }
    setZoom(nextZoom)
    setPan(constrainPan(nextPan, nextZoom))
    setInteractionMessage(`배치도 확대율 ${Math.round(nextZoom * 100)}%`)
  }

  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setInteractionMessage('배치도를 100%와 중앙 위치로 되돌렸습니다.')
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, block: LayoutBlock) => {
    onSelect(block)
    if (!editable || !viewportRef.current) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = { kind: 'move', id: block.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, original: block }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>, block: LayoutBlock) => {
    const gesture = gestureRef.current
    const viewport = viewportRef.current
    if (!editable || !gesture || gesture.kind !== 'move' || gesture.id !== block.id || gesture.pointerId !== event.pointerId || !viewport) return
    const bounds = viewport.getBoundingClientRect()
    const nextX = clamp(gesture.original.x + ((event.clientX - gesture.startX) / (bounds.width * zoom)) * 100, 0, 100 - block.width)
    const nextY = clamp(gesture.original.y + ((event.clientY - gesture.startY) / (bounds.height * zoom)) * 100, 0, 100 - block.height)
    onChange(block.id, { x: nextX, y: nextY }, false)
    queueGesturePersist(block.id)
  }

  const stopPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.kind !== 'move' || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (gesturePersistTimerRef.current !== null) window.clearTimeout(gesturePersistTimerRef.current)
    gesturePersistTimerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onChange(gesture.id, {}, true)
    setInteractionMessage('블록 위치를 공유 저장했습니다.')
  }

  const startResize = (event: ReactPointerEvent<HTMLSpanElement>, block: LayoutBlock, corner: ResizeCorner) => {
    if (!editable || !viewportRef.current) return
    event.preventDefault()
    event.stopPropagation()
    onSelect(block)
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = { kind: 'resize', corner, id: block.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, original: block }
  }

  const resizeBlock = (event: ReactPointerEvent<HTMLSpanElement>, block: LayoutBlock) => {
    const gesture = gestureRef.current
    const viewport = viewportRef.current
    if (!editable || !gesture || gesture.kind !== 'resize' || gesture.id !== block.id || gesture.pointerId !== event.pointerId || !gesture.corner || !viewport) return
    const bounds = viewport.getBoundingClientRect()
    const dx = ((event.clientX - gesture.startX) / (bounds.width * zoom)) * 100
    const dy = ((event.clientY - gesture.startY) / (bounds.height * zoom)) * 100
    const original = gesture.original
    const minSize = blockMinSize(original)
    let x = original.x
    let y = original.y
    let width = original.width
    let height = original.height
    if (gesture.corner.includes('e')) width = clamp(original.width + dx, minSize, 100 - original.x)
    if (gesture.corner.includes('s')) height = clamp(original.height + dy, minSize, 100 - original.y)
    if (gesture.corner.includes('w')) {
      x = clamp(original.x + dx, 0, original.x + original.width - minSize)
      width = original.width + original.x - x
    }
    if (gesture.corner.includes('n')) {
      y = clamp(original.y + dy, 0, original.y + original.height - minSize)
      height = original.height + original.y - y
    }
    onChange(block.id, { x, y, width, height }, false)
    queueGesturePersist(block.id)
  }

  const stopResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.kind !== 'resize' || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (gesturePersistTimerRef.current !== null) window.clearTimeout(gesturePersistTimerRef.current)
    gesturePersistTimerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onChange(gesture.id, {}, true)
    setInteractionMessage('블록 크기를 공유 저장했습니다.')
  }

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('.factory-layout-block, .factory-canvas-controls')) return
    if (event.button !== 0 && event.button !== 1) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: pan.x, y: pan.y }
    setIsPanning(true)
  }

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = panRef.current
    if (!current || current.pointerId !== event.pointerId) return
    setPan(constrainPan({ x: current.x + event.clientX - current.startX, y: current.y + event.clientY - current.startY }))
  }

  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = panRef.current
    if (!current || current.pointerId !== event.pointerId) return
    panRef.current = null
    setIsPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, block: LayoutBlock) => {
    if (!editable || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 5 : 1
    const horizontal = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0
    const vertical = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0
    if (event.altKey) {
      onChange(block.id, {
        width: clamp(block.width + horizontal, blockMinSize(block), 100 - block.x),
        height: clamp(block.height + vertical, blockMinSize(block), 100 - block.y),
      })
      return
    }
    moveBlock(block, block.x + horizontal, block.y + vertical)
  }

  const onViewportKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key === '+' || event.key === '=') { event.preventDefault(); applyZoom(zoom + .1); return }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); applyZoom(zoom - .1); return }
    if (event.key === '0') { event.preventDefault(); resetView(); return }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const distance = event.shiftKey ? 60 : 24
    setPan(constrainPan({
      x: pan.x + (event.key === 'ArrowLeft' ? distance : event.key === 'ArrowRight' ? -distance : 0),
      y: pan.y + (event.key === 'ArrowUp' ? distance : event.key === 'ArrowDown' ? -distance : 0),
    }))
  }

  return <div
    ref={viewportRef}
    className={`factory-layout-viewport${isPanning ? ' is-panning' : ''}`}
    role="application"
    tabIndex={0}
    aria-label={`${factory.name} 블록 배치 편집기`}
    aria-describedby="factory-layout-help"
    onPointerDown={startPan}
    onPointerMove={movePan}
    onPointerUp={stopPan}
    onPointerCancel={stopPan}
    onWheel={(event) => {
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      applyZoom(zoom + (event.deltaY < 0 ? .1 : -.1), { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    }}
    onKeyDown={onViewportKeyDown}
  >
    <div
      className={`factory-plan factory-layout-editor${editable ? ' is-editing' : ''}`}
      style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
    >
      {showBackground && drawing?.kind === 'image' && drawing.url && <img className="factory-layout-background" src={drawing.url} alt="" aria-hidden="true" />}
      <div className="factory-plan__north" aria-hidden="true">N</div>
      {blocks.length === 0 && <div className="factory-layout-empty"><MapIcon size={34} /><strong>아직 배치 블록이 없습니다</strong><span>‘블록 추가’로 공장 공간을 직접 구성하세요.</span></div>}
      {blocks.map((block) => {
      const percent = Math.min(100, Math.round((block.current / Math.max(block.capacity, 1)) * 100))
      const structure = isStructureBlock(block)
      return <button
        type="button"
        className={`factory-layout-block${structure ? ` factory-structure factory-structure--${block.purpose === '벽' ? 'wall' : 'door'}` : ''}${selectedId === block.id ? ' is-selected' : ''}`}
        style={{ left: `${block.x}%`, top: `${block.y}%`, width: `${block.width}%`, height: `${block.height}%`, ...(structure ? {} : { backgroundColor: layoutTokenColor(block) }) }}
        aria-pressed={selectedId === block.id}
        aria-label={structure
          ? `${block.purpose}, 위치 ${Math.round(block.x)} ${Math.round(block.y)}, 크기 ${Math.round(block.width)} ${Math.round(block.height)}`
          : `${block.name}, ${block.purpose}, ${block.item || '품목 미등록'}, 위치 ${Math.round(block.x)} ${Math.round(block.y)}, 크기 ${Math.round(block.width)} ${Math.round(block.height)}`}
        onClick={() => onSelect(block)}
        onPointerDown={(event) => onPointerDown(event, block)}
        onPointerMove={(event) => onPointerMove(event, block)}
        onPointerUp={stopPointer}
        onPointerCancel={stopPointer}
        onLostPointerCapture={stopPointer}
        onKeyDown={(event) => onKeyDown(event, block)}
        key={block.id}
      >
        {structure ? (
          block.purpose === '문' && <span className="factory-structure__label"><DoorOpen size={12} /> {block.name && block.name !== '문' ? block.name : '출입구'}</span>
        ) : <>
          <span className="factory-layout-block__head"><ZoneIcon kind={block.zoneId} /><span><strong>{block.name}</strong><small>{block.purpose} · {block.kind}</small></span>{editable && <Move size={16} />}</span>
          <span className="factory-layout-block__item">{block.item || '품목·설비 미등록'}</span>
          <span className="factory-layout-block__quantity"><strong>{block.current.toLocaleString()} {block.unit}</strong><small>/ {block.capacity.toLocaleString()} {block.unit}</small></span>
          <span className="factory-layout-block__meter"><i style={{ width: `${percent}%` }} /></span>
        </>}
        {editable && selectedId === block.id && (['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((corner) => <span
          className={`factory-resize-handle factory-resize-handle--${corner}`}
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, block, corner)}
          onPointerMove={(event) => resizeBlock(event, block)}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
          onLostPointerCapture={stopResize}
          key={corner}
        />)}
      </button>
      })}
    </div>
    <div className="factory-canvas-controls" role="group" aria-label="배치도 확대 및 위치 도구">
      <button type="button" aria-label="축소" onClick={() => applyZoom(zoom - .1)}><ZoomOut size={17} /></button>
      <button type="button" className="factory-canvas-controls__value" aria-label="배치도 보기 초기화" onClick={resetView}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label="확대" onClick={() => applyZoom(zoom + .1)}><ZoomIn size={17} /></button>
    </div>
    <span className="factory-layout-live factory-sr-only" aria-live="polite">{interactionMessage}</span>
  </div>
}

function LayoutInspector({ block, canManage, onChange, onDelete }: {
  block?: LayoutBlock
  canManage: boolean
  onChange: (patch: Partial<LayoutBlock>) => void
  onDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  if (!block) return <div className="factory-layout-inspector-empty"><MousePointer2 size={28} /><strong>블록을 선택하세요</strong><span>선택한 공간의 용도와 위치 정보를 여기서 확인할 수 있습니다.</span></div>

  const number = (value: string, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback
  const field = (label: string, content: ReactNode) => <label className="factory-layout-field"><span>{label}</span>{content}</label>

  return <div className="factory-layout-inspector">
    <div className="factory-layout-inspector__status"><span><CheckCircle2 size={16} /> 공유 저장됨</span><small>변경사항은 같은 회사 계정에 즉시 반영됩니다.</small></div>
    <div className="factory-layout-form">
      {field('블록 이름', <input value={block.name} disabled={!canManage} onChange={(event) => onChange({ name: event.target.value })} />)}
      <div className="factory-layout-form__row">
        {field('공간 용도', <select value={block.purpose} disabled={!canManage} onChange={(event) => onChange({ purpose: event.target.value as LayoutPurpose })}><option>원료·자재</option><option>냉장·냉동</option><option>생산</option><option>포장</option><option>출하</option><option>통로</option><option>벽</option><option value="문">출입구</option><option>기타</option></select>)}
        {!isStructureBlock(block) && field('위치 유형', <select value={block.kind} disabled={!canManage} onChange={(event) => onChange({ kind: event.target.value as LocationKind })}><option>재고</option><option>생산</option></select>)}
      </div>
      {!isStructureBlock(block) && <div className="factory-layout-form__row">
        {field('연결 구역', <select value={block.zoneId} disabled={!canManage} onChange={(event) => onChange({ zoneId: event.target.value as ZoneKind })}><option value="raw">원료</option><option value="frozen">냉장·냉동</option><option value="production">생산</option><option value="packing">포장</option><option value="shipping">출하</option></select>)}
      </div>}
      {!isStructureBlock(block) && <div className="factory-layout-field">
        <span>블록 색상 <small>구역 성격에 맞게 구분하세요</small></span>
        <div className="factory-color-swatches" role="group" aria-label="블록 색상 선택">
          {layoutColorOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`factory-color-swatch${block.color === option.value ? ' is-selected' : ''}`}
              title={option.label}
              aria-label={option.label}
              aria-pressed={block.color === option.value}
              disabled={!canManage}
              onClick={() => onChange({ color: option.value })}
            ><i style={{ backgroundColor: option.value }} /></button>
          ))}
        </div>
      </div>}
      <div className="factory-layout-size-grid" aria-label="블록 위치와 크기">
        {field('X', <input type="number" min="0" max={100 - block.width} step="1" value={Math.round(block.x)} disabled={!canManage} onChange={(event) => onChange({ x: Math.min(100 - block.width, Math.max(0, number(event.target.value, block.x))) })} />)}
        {field('Y', <input type="number" min="0" max={100 - block.height} step="1" value={Math.round(block.y)} disabled={!canManage} onChange={(event) => onChange({ y: Math.min(100 - block.height, Math.max(0, number(event.target.value, block.y))) })} />)}
        {field('너비 %', <input type="number" min={blockMinSize(block)} max={100 - block.x} step="1" value={Math.round(block.width)} disabled={!canManage} onChange={(event) => onChange({ width: Math.min(100 - block.x, Math.max(blockMinSize(block), number(event.target.value, block.width))) })} />)}
        {field('높이 %', <input type="number" min={blockMinSize(block)} max={100 - block.y} step="1" value={Math.round(block.height)} disabled={!canManage} onChange={(event) => onChange({ height: Math.min(100 - block.y, Math.max(blockMinSize(block), number(event.target.value, block.height))) })} />)}
      </div>
      {!isStructureBlock(block) && field(block.kind === '생산' ? '생산 품목·설비' : '보관 품목', <input value={block.item} disabled={!canManage} placeholder="품목 또는 설비명" onChange={(event) => onChange({ item: event.target.value })} />)}
      {!isStructureBlock(block) && <div className="factory-layout-form__row three">
        {field('현재량', <input type="number" min="0" value={block.current} disabled={!canManage} onChange={(event) => onChange({ current: Math.max(0, number(event.target.value, block.current)) })} />)}
        {field('수용량', <input type="number" min="1" value={block.capacity} disabled={!canManage} onChange={(event) => onChange({ capacity: Math.max(1, number(event.target.value, block.capacity)) })} />)}
        {field('단위', <select value={block.unit} disabled={!canManage} onChange={(event) => onChange({ unit: event.target.value })}><option>kg</option><option>ea</option><option>BOX</option><option>PLT</option><option>라인</option></select>)}
      </div>}
      {field('운영 메모', <textarea rows={3} value={block.note} disabled={!canManage} onChange={(event) => onChange({ note: event.target.value })} />)}
    </div>
    {canManage && <button className={`factory-layout-delete${confirmDelete ? ' is-confirming' : ''}`} type="button" onClick={() => { if (confirmDelete) onDelete(); else setConfirmDelete(true) }} onBlur={() => setConfirmDelete(false)}><Trash2 size={16} />{confirmDelete ? '한 번 더 눌러 삭제' : '블록 삭제'}</button>}
  </div>
}

function LocationModal({
  factory,
  zones,
  selectedZoneId,
  state,
  onClose,
  onSave,
}: {
  factory: FactoryDefinition
  zones: FactoryZone[]
  selectedZoneId: ZoneKind
  state: LocationModalState
  onClose: () => void
  onSave: (location: FactoryLocation) => void
}) {
  const initial = state.mode === 'edit' ? state.location : undefined
  const [draft, setDraft] = useState<LocationDraft>({
    zoneId: initial?.zoneId ?? selectedZoneId,
    kind: initial?.kind ?? (selectedZoneId === 'production' || selectedZoneId === 'packing' ? '생산' : '재고'),
    name: initial?.name ?? '',
    code: initial?.code ?? '',
    item: initial?.item ?? '',
    current: initial ? String(initial.current) : '',
    capacity: initial ? String(initial.capacity) : '',
    unit: initial?.unit ?? (selectedZoneId === 'shipping' ? 'PLT' : 'kg'),
    status: initial?.status ?? '정상',
    note: initial?.note ?? '',
  })
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    const selector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    document.body.style.overflow = 'hidden'
    window.setTimeout(() => dialog.querySelector<HTMLElement>('[autofocus]')?.focus(), 0)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(selector))
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [onClose])

  const update = <K extends keyof LocationDraft>(key: K, value: LocationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setError('')
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const current = Number(draft.current)
    const capacity = Number(draft.capacity)
    if (!Number.isFinite(current) || current < 0 || !Number.isFinite(capacity) || capacity <= 0) {
      setError('현재량과 최대 수용량을 0 이상의 숫자로 입력해 주세요.')
      return
    }
    if (current > capacity) {
      setError('현재량은 최대 수용량을 초과할 수 없습니다.')
      return
    }

    onSave({
      id: initial?.id ?? `LOC-${Date.now().toString().slice(-8)}`,
      factoryId: factory.id,
      ...draft,
      current,
      capacity,
    })
  }

  return (
    <div className="factory-modal-layer" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="factory-modal" role="dialog" aria-modal="true" aria-labelledby="factory-location-modal-title">
        <header className="factory-modal__head">
          <div>
            <span>{state.mode === 'edit' ? 'LOCATION EDIT' : 'NEW LOCATION'}</span>
            <h2 id="factory-location-modal-title">{state.mode === 'edit' ? '위치 정보 수정' : '재고·생산 위치 등록'}</h2>
            <p>{factory.name}의 실제 현장 표기와 동일하게 입력하세요.</p>
          </div>
          <button type="button" aria-label="위치 등록 창 닫기" onClick={onClose}><X size={20} /></button>
        </header>

        <form className="factory-location-form" onSubmit={submit}>
          <div className="factory-form-grid">
            <label className="factory-form-field">
              <span>구역</span>
              <select value={draft.zoneId} onChange={(event) => update('zoneId', event.target.value as ZoneKind)}>
                {zones.map((zone) => <option value={zone.id} key={zone.id}>{zone.name}</option>)}
              </select>
            </label>
            <label className="factory-form-field">
              <span>위치 유형</span>
              <select value={draft.kind} onChange={(event) => update('kind', event.target.value as LocationKind)}>
                <option value="재고">재고 위치</option>
                <option value="생산">생산 위치</option>
              </select>
            </label>
            <label className="factory-form-field">
              <span>위치명</span>
              <input autoFocus required value={draft.name} onChange={(event) => update('name', event.target.value)} placeholder="예: 냉동 A-03 랙" />
            </label>
            <label className="factory-form-field">
              <span>위치 코드</span>
              <input required value={draft.code} onChange={(event) => update('code', event.target.value.toUpperCase())} placeholder="예: FZ-A03" />
            </label>
            <label className="factory-form-field factory-form-field--wide">
              <span>{draft.kind === '생산' ? '현재 생산 품목' : '대표 보관 품목'}</span>
              <input required value={draft.item} onChange={(event) => update('item', event.target.value)} placeholder="제품 또는 원재료명" />
            </label>
            <label className="factory-form-field">
              <span>현재량</span>
              <input inputMode="decimal" required value={draft.current} onChange={(event) => update('current', event.target.value)} placeholder="0" />
            </label>
            <label className="factory-form-field">
              <span>최대 수용량</span>
              <input inputMode="decimal" required value={draft.capacity} onChange={(event) => update('capacity', event.target.value)} placeholder="0" />
            </label>
            <label className="factory-form-field">
              <span>단위</span>
              <select value={draft.unit} onChange={(event) => update('unit', event.target.value)}>
                <option>kg</option><option>ea</option><option>BOX</option><option>PLT</option><option>라인</option>
              </select>
            </label>
            <label className="factory-form-field">
              <span>운영 상태</span>
              <select value={draft.status} onChange={(event) => update('status', event.target.value as LocationState)}>
                <option>정상</option><option>주의</option><option>점검</option><option>비가동</option>
              </select>
            </label>
            <label className="factory-form-field factory-form-field--wide">
              <span>관리 메모</span>
              <textarea rows={3} value={draft.note} onChange={(event) => update('note', event.target.value)} placeholder="피킹 순서, 설비 점검, 보관 조건 등을 입력하세요." />
            </label>
          </div>
          {error && <div className="factory-form-error" role="alert"><AlertTriangle size={17} />{error}</div>}
          <div className="factory-modal__note"><CheckCircle2 size={18} /><span>저장 후 선택한 구역의 위치 목록과 운영 배치도에 즉시 반영됩니다.</span></div>
          <footer className="factory-modal__actions">
            <button type="button" className="factory-button factory-button--ghost" onClick={onClose}>취소</button>
            <button type="submit" className="factory-button factory-button--primary"><Save size={17} />{state.mode === 'edit' ? '변경사항 저장' : '위치 등록'}</button>
          </footer>
        </form>
      </section>
    </div>
  )
}

export function FactoryManagement({ onToast, canManage, companyName, workspaceScope }: FactoryManagementProps) {
  const [locations, setLocations] = useWorkspaceState<FactoryLocation[]>('factory-locations', emptyFactoryLocations, { scope: workspaceScope, seedWhenEmpty: false, validate: isFactoryLocationList })
  const [layouts, setLayouts] = useWorkspaceState<FactoryLayouts>('factory-layouts', emptyFactoryLayouts, { scope: workspaceScope, seedWhenEmpty: false, validate: isFactoryLayouts })
  const availableFactories = useMemo(() => {
    const ids = Array.from(new Set([...Object.keys(layouts), ...locations.map((location) => location.factoryId)]))
    return ids.map((id, index) => {
      const definition = createCustomerFactory(companyName, id)
      return { ...definition, name: `${companyName?.trim() || '우리 회사'} ${ids.length === 1 ? '제1공장' : `${index + 1}공장`}`, code: id.replace(/^FAC-/, '').slice(0, 16) || `SITE-${index + 1}` }
    })
  }, [companyName, layouts, locations])
  const placeholderFactory = useMemo(() => createCustomerFactory(companyName, 'FAC-PENDING'), [companyName])
  const [selectedFactoryId, setSelectedFactoryId] = useState('')
  const [selectedZoneId, setSelectedZoneId] = useState<ZoneKind>('raw')
  const [drawings, setDrawings] = useState<Record<string, DrawingMeta>>({})
  const [drawingsLoading, setDrawingsLoading] = useState(true)
  const [drawingBusy, setDrawingBusy] = useState(false)
  const [showBackground, setShowBackground] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [overviewExpanded, setOverviewExpanded] = useState(false)
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [modalState, setModalState] = useState<LocationModalState | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const objectUrlsRef = useRef(new Set<string>())

  const factory = availableFactories.find((item) => item.id === selectedFactoryId) ?? availableFactories[0] ?? placeholderFactory
  const factoryBlocks = layouts[factory.id] ?? []
  const selectedBlock = factoryBlocks.find((block) => block.id === selectedBlockId)
  const selectedZone = factory.zones.find((zone) => zone.id === (selectedBlock?.zoneId ?? selectedZoneId)) ?? factory.zones[0]
  const factoryLocations = useMemo(
    () => locations.filter((location) => location.factoryId === factory.id),
    [factory.id, locations],
  )
  const selectedLocations = factoryLocations.filter((location) => location.zoneId === selectedZone.id)
  const drawing = drawings[factory.id]
  const warningCount = factory.zones.filter((zone) => zone.state === '주의').length
  const operatingCount = factory.zones.filter((zone) => ['정상', '가동중', '출하중'].includes(zone.state)).length

  useEffect(() => () => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  useEffect(() => {
    let active = true
    setDrawingsLoading(true)
    void fetch('/api/documents', {
      headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message || '저장된 도면을 불러오지 못했습니다.')
      const result = await response.json() as { documents?: CompanyDocumentMeta[] }
      if (!active) return
      const restored: Record<string, DrawingMeta> = {}
      for (const document of result.documents ?? []) {
        if (document.category !== '공장도면' || !document.tags?.includes('factory-drawing')) continue
        const factoryTag = document.tags.find((tag) => tag.startsWith('factory:'))
        const factoryId = factoryTag?.slice('factory:'.length)
        if (!factoryId || restored[factoryId]) continue
        restored[factoryId] = {
          id: document.id,
          kind: document.mime === 'application/pdf' ? 'pdf' : 'image',
          name: document.originalName || document.name,
          size: document.size,
          mime: document.mime,
          uploadedAt: document.uploadedAt,
        }
      }
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current.clear()
      setDrawings(restored)
    }).catch((error: unknown) => {
      if (active) onToast(error instanceof Error ? error.message : '저장된 도면을 불러오지 못했습니다.')
    }).finally(() => {
      if (active) setDrawingsLoading(false)
    })
    return () => { active = false }
  }, [workspaceScope])

  useEffect(() => {
    if (!drawing || drawing.kind !== 'image' || drawing.url) return
    let active = true
    void fetch(`/api/documents/${encodeURIComponent(drawing.id)}/download`, {
      headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
    }).then(async (response) => {
      if (!response.ok) throw new Error('도면 미리보기를 불러오지 못했습니다.')
      const url = URL.createObjectURL(await response.blob())
      if (!active) { URL.revokeObjectURL(url); return }
      objectUrlsRef.current.add(url)
      setDrawings((current) => current[factory.id]?.id === drawing.id
        ? { ...current, [factory.id]: { ...current[factory.id], url } }
        : current)
    }).catch((error: unknown) => {
      if (active) onToast(error instanceof Error ? error.message : '도면 미리보기를 불러오지 못했습니다.')
    })
    return () => { active = false }
  }, [drawing?.id, drawing?.kind, drawing?.url, factory.id, workspaceScope])

  useEffect(() => {
    if (availableFactories.some((item) => item.id === selectedFactoryId)) return
    const first = availableFactories[0]
    if (!first) {
      setSelectedFactoryId('')
      setSelectedBlockId(null)
      return
    }
    setSelectedFactoryId(first.id)
    setSelectedZoneId('raw')
    setSelectedBlockId((layouts[first.id] ?? [])[0]?.id ?? null)
  }, [availableFactories, layouts, selectedFactoryId])

  useEffect(() => {
    const blocks = layouts[selectedFactoryId] ?? []
    if (selectedBlockId && blocks.some((block) => block.id === selectedBlockId)) return
    const first = blocks[0]
    setSelectedBlockId(first?.id ?? null)
    if (first) setSelectedZoneId(first.zoneId)
  }, [layouts, selectedBlockId, selectedFactoryId])

  const selectFactory = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextFactoryId = event.target.value
    setSelectedFactoryId(nextFactoryId)
    setSelectedZoneId('raw')
    setSelectedBlockId((layouts[nextFactoryId] ?? [])[0]?.id ?? null)
    setEditMode(false)
  }

  const registerFactory = async () => {
    if (!canManage) return
    const next = createCustomerFactory(companyName, `FAC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`)
    const result = await setLayouts((current) => ({ ...current, [next.id]: [] }))
    if (!result.ok) {
      onToast(result.message ?? '공장을 등록하지 못했습니다.')
      return
    }
    setSelectedFactoryId(next.id)
    onToast(`${next.name}을 등록했습니다. 배치 블록과 운영 위치를 추가해 주세요.`)
  }

  const deleteFactory = async () => {
    if (!canManage || !availableFactories.some((item) => item.id === factory.id)) return
    if (drawing) {
      onToast('공장 도면을 먼저 제거한 뒤 공장을 삭제해 주세요.')
      return
    }
    if (!window.confirm(`${factory.name}과 연결된 블록·위치 정보를 삭제할까요?`)) return
    const previousBlocks = factoryBlocks
    const previousLocations = factoryLocations
    const layoutResult = await setLayouts((current) => {
      const next = { ...current }
      delete next[factory.id]
      return next
    })
    if (!layoutResult.ok) { onToast(layoutResult.message ?? '공장을 삭제하지 못했습니다.'); return }
    const locationResult = await setLocations((current) => current.filter((location) => location.factoryId !== factory.id))
    if (!locationResult.ok) {
      await setLayouts((current) => ({ ...current, [factory.id]: previousBlocks }))
      onToast(locationResult.message ?? '공장 위치 정리에 실패해 공장 정보를 복구했습니다.')
      return
    }
    setSelectedFactoryId('')
    setSelectedBlockId(null)
    onToast(`${factory.name}과 연결된 블록 ${previousBlocks.length}개, 위치 ${previousLocations.length}개를 삭제했습니다.`)
  }

  const setDrawingReference = async (drawingId: string, factoryId: string, attached: boolean) => {
    const response = await fetch(`/api/documents/${encodeURIComponent(drawingId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
      },
      body: JSON.stringify(attached
        ? { category: '공장도면', tags: ['factory-drawing', `factory:${factoryId}`] }
        : { category: '공장자료', tags: ['공장도면-연결해제'] }),
    }).catch(() => null)
    return Boolean(response?.ok)
  }

  const registerDrawing = async (file?: File) => {
    if (!file || drawingBusy) return
    if (!canManage) {
      onToast('공장 도면은 회사 관리자만 변경할 수 있습니다.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      onToast('도면 파일은 10MB 이하만 등록할 수 있습니다.')
      return
    }
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name)
    if (!isPdf && !isImage) {
      onToast('PNG, JPG, WEBP 이미지 또는 PDF 도면만 등록할 수 있습니다.')
      return
    }

    const mime = isPdf ? 'application/pdf'
      : /\.png$/i.test(file.name) ? 'image/png'
        : /\.webp$/i.test(file.name) ? 'image/webp'
          : 'image/jpeg'
    const previous = drawings[factory.id]
    const params = new URLSearchParams({
      name: file.name,
      category: '공장도면',
      visibility: 'all',
      tags: `factory-drawing,factory:${factory.id}`,
      summary: `${factory.name} 블록 배치 편집기 배경 도면`,
    })
    setDrawingBusy(true)
    try {
      const response = await fetch(`/api/documents?${params}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-type': mime,
          'x-file-name': encodeURIComponent(file.name),
          ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
        },
        body: file,
      })
      const result = await response.json().catch(() => null) as { document?: CompanyDocumentMeta; error?: { message?: string } } | null
      if (!response.ok || !result?.document) throw new Error(result?.error?.message || '도면을 저장하지 못했습니다.')
      if (previous?.url) {
        URL.revokeObjectURL(previous.url)
        objectUrlsRef.current.delete(previous.url)
      }
      const url = isImage ? URL.createObjectURL(file) : undefined
      if (url) objectUrlsRef.current.add(url)
      const saved = result.document
      setDrawings((current) => ({
        ...current,
        [factory.id]: { id: saved.id, kind: isPdf ? 'pdf' : 'image', name: saved.originalName || saved.name, size: saved.size, mime: saved.mime, uploadedAt: saved.uploadedAt, url },
      }))
      if (isImage) setShowBackground(true)
      if (previous?.id && previous.id !== saved.id) {
        const detached = await setDrawingReference(previous.id, factory.id, false)
        if (!detached) {
          onToast('새 도면은 저장했지만 이전 도면 연결 해제에 실패했습니다. 기업자료실에서 확인해 주세요.')
          return
        }
        const cleanup = await fetch(`/api/documents/${encodeURIComponent(previous.id)}`, {
          method: 'DELETE',
          headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
        })
        if (!cleanup.ok) {
          await setDrawingReference(previous.id, factory.id, true)
          onToast('새 도면은 저장했지만 이전 파일 정리에 실패했습니다. 기업자료실에서 확인해 주세요.')
        }
      }
      onToast(`${factory.name} 도면을 회사 파일 저장소에 등록했습니다.`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '도면을 저장하지 못했습니다.')
    } finally {
      setDrawingBusy(false)
    }
  }

  const removeDrawing = async () => {
    const currentDrawing = drawings[factory.id]
    if (!currentDrawing || drawingBusy) return
    if (!canManage) { onToast('공장 도면은 회사 관리자만 삭제할 수 있습니다.'); return }
    setDrawingBusy(true)
    const detached = await setDrawingReference(currentDrawing.id, factory.id, false)
    if (!detached) {
      onToast('도면 연결을 해제하지 못해 원본을 보존했습니다.')
      setDrawingBusy(false)
      return
    }
    const response = await fetch(`/api/documents/${encodeURIComponent(currentDrawing.id)}`, {
      method: 'DELETE',
      headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
    }).catch(() => null)
    if (!response?.ok) {
      const result = await response?.json().catch(() => null)
      const restored = await setDrawingReference(currentDrawing.id, factory.id, true)
      onToast(restored ? (result?.error?.message || '도면을 삭제하지 못해 기존 연결을 복구했습니다.') : '도면 연결은 해제했지만 원본 정리와 연결 복구에 실패했습니다. 기업자료실을 확인해 주세요.')
      if (!restored) {
        setDrawings((current) => {
          const next = { ...current }
          delete next[factory.id]
          return next
        })
      }
      setDrawingBusy(false)
      return
    }
    if (currentDrawing?.url) {
      URL.revokeObjectURL(currentDrawing.url)
      objectUrlsRef.current.delete(currentDrawing.url)
    }
    setDrawings((current) => {
      const next = { ...current }
      delete next[factory.id]
      return next
    })
    setShowBackground(false)
    setDrawingBusy(false)
    onToast(`${factory.name} 도면을 회사 파일 저장소에서 삭제했습니다.`)
  }

  const downloadDrawing = async () => {
    if (!drawing) return
    const response = await fetch(`/api/documents/${encodeURIComponent(drawing.id)}/download`, {
      headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
    }).catch(() => null)
    if (!response?.ok) { onToast('도면 파일을 내려받지 못했습니다.'); return }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = drawing.name
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    void registerDrawing(event.dataTransfer.files?.[0])
  }

  const saveLocation = async (location: FactoryLocation) => {
    const editing = modalState?.mode === 'edit'
    const result = await setLocations((current) => editing
      ? current.map((item) => item.id === location.id ? location : item)
      : [...current, location])
    if (!result.ok) {
      onToast(result.message ?? `위치를 ${editing ? '수정' : '등록'}하지 못했습니다.`)
      return
    }
    setSelectedZoneId(location.zoneId)
    setModalState(null)
    onToast(`${location.name} 위치를 ${editing ? '수정' : '등록'}했습니다.`)
  }

  const deleteLocation = async (location: FactoryLocation) => {
    if (!canManage || !window.confirm(`${location.name} 위치를 삭제할까요?`)) return
    const result = await setLocations((current) => current.filter((item) => item.id !== location.id))
    if (!result.ok) { onToast(result.message ?? '위치를 삭제하지 못했습니다.'); return }
    onToast(`${location.name} 위치를 삭제했습니다.`)
  }

  const selectBlock = (block: LayoutBlock) => {
    setSelectedBlockId(block.id)
    setSelectedZoneId(block.zoneId)
  }

  const updateBlock = (id: string, patch: Partial<LayoutBlock>, persist = true) => {
    let hasCollision = false
    void setLayouts((current) => {
      // 빠른 pointermove 직후 pointerup이 오면 React 렌더보다 공유 상태가
      // 한 박자 앞설 수 있다. 화면 클로저가 아니라 setter의 최신 current를
      // 기준으로 최종 위치·크기를 만들고 저장해야 마지막 제스처가 보존된다.
      const blocks = current[factory.id] ?? []
      const currentBlock = blocks.find((block) => block.id === id)
      if (!currentBlock) return current
      const candidate = normalizeBlockGeometry({ ...currentBlock, ...patch })
      // 벽·문은 공간을 두르는 구조물이므로 블록과 자유롭게 겹칠 수 있다.
      hasCollision = !isStructureBlock(candidate)
        && blocks.some((block) => block.id !== id && !isStructureBlock(block) && blocksOverlap(candidate, block))
      if (hasCollision) return current
      return {
        ...current,
        [factory.id]: blocks.map((block) => block.id === id ? candidate : block),
      }
    }, { persist }).then((result) => {
      if (hasCollision && persist && Object.keys(patch).length > 0) {
        onToast('다른 블록과 겹칠 수 없습니다. 빈 공간으로 이동하거나 크기를 줄여 주세요.')
        return
      }
      if (persist && !result.ok && result.message) onToast(result.message)
    })
  }

  const addBlock = async (structure?: '벽' | '문') => {
    if (!canManage) return
    const spaceBlocks = factoryBlocks.filter((block) => !isStructureBlock(block))
    const size = structure === '벽' ? { width: 36, height: 2 } : structure === '문' ? { width: 7, height: 2 } : { width: 24, height: 22 }
    const freePosition = structure
      ? { x: 6, y: 4 }
      : findFreeBlockPosition(spaceBlocks, size.width, size.height)
    if (!freePosition) {
      onToast('새 블록을 놓을 빈 공간이 없습니다. 기존 블록을 이동하거나 크기를 줄여 주세요.')
      return
    }
    const next: LayoutBlock = {
      id: `BLOCK-${Date.now()}`,
      factoryId: factory.id,
      zoneId: 'production',
      name: structure === '문' ? '출입구' : structure ?? '새 공간 블록',
      purpose: structure ?? '기타',
      kind: '생산',
      x: freePosition.x,
      y: freePosition.y,
      width: size.width,
      height: size.height,
      color: 'var(--color-gray-200)',
      item: '',
      current: 0,
      capacity: 100,
      unit: 'ea',
      note: '',
    }
    const result = await setLayouts((current) => ({ ...current, [factory.id]: [...(current[factory.id] ?? []), next] }))
    if (!result.ok) { if (result.message) onToast(result.message); return }
    selectBlock(next)
    setEditMode(true)
    onToast(structure === '벽'
      ? '벽을 추가했습니다. 드래그로 위치를 잡고 모서리로 길이를 조정하세요.'
      : structure === '문'
        ? '출입구를 추가했습니다. 벽 위로 끌어다 놓고, 이름을 "입구"·"출구"처럼 바꿔 쓸 수 있습니다.'
        : '새 배치 블록을 추가했습니다. 위치와 크기를 조정해 주세요.')
  }

  const deleteSelectedBlock = async () => {
    if (!canManage || !selectedBlock) return
    const remaining = factoryBlocks.filter((block) => block.id !== selectedBlock.id)
    const result = await setLayouts((current) => ({ ...current, [factory.id]: remaining }))
    if (!result.ok) { if (result.message) onToast(result.message); return }
    const next = remaining[0]
    setSelectedBlockId(next?.id ?? null)
    if (next) setSelectedZoneId(next.zoneId)
    onToast(`${selectedBlock.name} 블록을 삭제했습니다.`)
  }

  if (availableFactories.length === 0) {
    return <div className="factory-page">
      <header className="factory-page__head">
        <div><span className="factory-page__kicker">FACTORY CONTROL</span><h1>공장관리</h1><p>공장과 배치 블록을 등록하면 재고·생산 위치를 한눈에 관리할 수 있습니다.</p></div>
      </header>
      <section className="factory-overview factory-empty-state" aria-label="공장 등록 안내">
        <FactoryIcon size={32} aria-hidden="true" />
        <div><h2>아직 등록된 항목이 없습니다</h2><p>{canManage ? '첫 공장을 등록한 뒤 도면 또는 블록 편집기로 실제 공간을 구성하세요.' : '회사 관리자가 공장을 등록하면 이곳에서 운영 위치를 확인할 수 있습니다.'}</p></div>
        {canManage && <button className="factory-button factory-button--primary" type="button" onClick={() => void registerFactory()}><Plus size={17} /> 첫 공장 등록</button>}
      </section>
    </div>
  }

  return (
    <div className="factory-page">
      <header className="factory-page__head">
        <div>
          <span className="factory-page__kicker">FACTORY CONTROL</span>
          <h1>공장관리</h1>
          <p>공장 배치도 위에서 재고, 생산, 포장과 출하 흐름을 확인하고 실제 위치를 관리합니다.</p>
        </div>
        <div className="factory-page__actions">
          <label className="factory-selector">
            <span>관리 공장</span>
            <select value={factory.id} onChange={selectFactory} aria-label="관리할 공장 선택">
              {availableFactories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
          </label>
          {canManage && <div className="factory-page__action-buttons"><button className="factory-button factory-button--ghost" type="button" onClick={() => void registerFactory()}><Plus size={16} /> 공장 추가</button><button className="factory-button factory-button--danger" type="button" onClick={() => void deleteFactory()}><Trash2 size={16} /> 공장 삭제</button></div>}
        </div>
      </header>

      <section className={`factory-overview${overviewExpanded ? ' is-expanded' : ''}`} aria-label="선택 공장 운영 요약">
        <div className="factory-overview__main">
          <div className="factory-identity factory-identity--compact">
            <span className="factory-identity__mark"><FactoryIcon size={20} aria-hidden="true" /></span>
            <div><strong>{factory.name}</strong><span>{factory.code} · {factory.address} · {factory.area}</span></div>
            <span className="factory-identity__live"><i />{factoryBlocks.length || factoryLocations.length ? '운영 중' : '초기 설정'}</span>
          </div>
          <div className="factory-summary factory-summary--compact" aria-label="핵심 지표">
            <article><Layers3 size={16} /><span>블록 <strong>{factoryBlocks.length}</strong></span></article>
            <article><CheckCircle2 size={16} /><span>정상 <strong>{operatingCount}</strong></span></article>
            <article className={warningCount ? 'is-warning' : ''}><AlertTriangle size={16} /><span>확인 <strong>{warningCount}</strong></span></article>
            <article><MapIcon size={16} /><span>연결 <strong>{factoryBlocks.filter((block) => block.item).length}</strong></span></article>
          </div>
          <button className="factory-overview__toggle" type="button" aria-expanded={overviewExpanded} aria-controls="factory-overview-details" onClick={() => setOverviewExpanded((value) => !value)}>
            <UploadCloud size={17} /> 도면·상세 <ChevronDown size={17} />
          </button>
        </div>

        {overviewExpanded && <div className="factory-overview__details" id="factory-overview-details">
          <div className="factory-upload-panel__copy">
            <span className="factory-upload-panel__icon"><UploadCloud size={20} aria-hidden="true" /></span>
            <div><h2 id="factory-upload-title">배경 도면 <small>선택</small></h2><p>이미지는 편집기 배경, PDF는 참고 파일로 관리합니다.</p></div>
          </div>
          {canManage ? <div
            className={`factory-dropzone${dragActive ? ' is-dragging' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
          >
            <input
              ref={fileInputRef}
              className="factory-sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf,.png,.jpg,.jpeg,.webp,.pdf"
              aria-label={`${factory.name} 도면 파일 선택`}
              disabled={drawingBusy}
              onChange={(event) => { void registerDrawing(event.target.files?.[0]); event.target.value = '' }}
            />
            <FileImage size={18} aria-hidden="true" />
            <span>{drawingBusy ? '회사 파일 저장소에 반영 중…' : dragActive ? '여기에 놓아 등록' : '도면 끌어놓기'}</span>
            <button type="button" disabled={drawingBusy} onClick={() => fileInputRef.current?.click()}>{drawing ? '교체' : '파일 선택'}</button>
          </div> : <div className="factory-dropzone" aria-label="공장 도면 조회 전용"><ShieldCheck size={18} aria-hidden="true" /><span>관리자만 도면을 변경할 수 있습니다.</span></div>}
          {drawing ? (
            <div className="factory-file-card">
              {drawing.kind === 'image' && drawing.url
                ? <img src={drawing.url} alt="등록 도면 축소 미리보기" />
                : <span className="factory-file-card__pdf"><FileText size={22} /></span>}
              <div><strong>{drawing.name}</strong><span>{drawing.kind === 'image' ? '이미지' : 'PDF'} · {formatFileSize(drawing.size)} · 회사 파일 저장소</span></div>
              <button type="button" aria-label={`${drawing.name} 다운로드`} onClick={() => void downloadDrawing()}><Download size={17} /></button>
              {canManage && <button type="button" disabled={drawingBusy} aria-label={`${drawing.name} 제거`} onClick={() => void removeDrawing()}><X size={18} /></button>}
            </div>
          ) : <span className="factory-file-empty">{drawingsLoading ? '저장된 도면 확인 중…' : '등록 도면 없음 · 블록 편집은 바로 사용 가능'}</span>}
        </div>}
      </section>

      <section className="factory-layout-panel" aria-labelledby="factory-layout-title">
        <div className="factory-layout-panel__head">
          <div><span>SHARED FLOOR EDITOR</span><h2 id="factory-layout-title">공장 블록 배치 편집기</h2><p id="factory-layout-help">블록 드래그 이동 · 모서리 크기 조절 · 배경 드래그 이동 · 휠 확대/축소(페이지는 움직이지 않음). 키보드는 방향키, Alt+방향키, +/−/0을 지원합니다.</p></div>
          <div className="factory-layout-actions" role="group" aria-label="배치 편집 도구">
            {drawing?.kind === 'image' && <button type="button" className={showBackground ? 'is-active' : ''} aria-pressed={showBackground} onClick={() => setShowBackground((value) => !value)}><FileImage size={16} />배경 도면</button>}
            {canManage && <button type="button" className={editMode ? 'is-active' : ''} aria-pressed={editMode} onClick={() => setEditMode((value) => !value)}><MousePointer2 size={16} />{editMode ? '편집 종료' : '배치 편집'}</button>}
            {canManage && <button type="button" onClick={() => void addBlock('벽')}><BrickWall size={16} />벽 추가</button>}
            {canManage && <button type="button" onClick={() => void addBlock('문')}><DoorOpen size={16} />출입구 추가</button>}
            {canManage && <button type="button" className="is-primary" onClick={() => void addBlock()}><Plus size={16} />블록 추가</button>}
          </div>
        </div>

        <div className="factory-workspace">
          <div className="factory-map-column">
            <div className="factory-map-frame">
              <LayoutEditor factory={factory} blocks={factoryBlocks} selectedId={selectedBlockId} editable={canManage && editMode} drawing={drawing} showBackground={showBackground} onSelect={selectBlock} onChange={updateBlock} />
            </div>
            <div className="factory-legend" aria-label="배치도 범례">
              <strong><Palette size={14} /> 블록 색·이름은 아래 속성 패널에서 변경</strong>
              <span><BrickWall size={14} /> 벽·출입구 추가로 공간 구획 표시</span>
              <span><Move size={14} /> 블록·배경 드래그 이동</span>
              <span><Layers3 size={14} /> 모서리·Alt+방향키 크기 조정</span>
              <span><ZoomIn size={14} /> 휠·+/− 확대/축소</span>
              <span><CheckCircle2 size={14} /> 회사 계정에 공유 저장</span>
            </div>
          </div>

          <aside className="factory-zone-detail factory-layout-sidebar" aria-live="polite" aria-label="선택 블록 속성과 위치 상세">
            <div className={`factory-zone-detail__head factory-zone-detail__head--${selectedZone.id}`}>
              <span><ZoneIcon kind={selectedZone.id} size={22} /></span>
              <div><small>선택 블록</small><h2>{selectedBlock?.name ?? '선택 없음'}</h2></div>
              {selectedBlock && <span className="factory-layout-purpose">{selectedBlock.purpose === '문' ? '출입구' : selectedBlock.purpose}</span>}
            </div>
            <LayoutInspector block={selectedBlock} canManage={canManage} onChange={(patch) => selectedBlock && updateBlock(selectedBlock.id, patch)} onDelete={deleteSelectedBlock} />

            <div className="factory-location-head">
              <div><h3>상세 위치 목록</h3><span>{selectedLocations.length}곳</span></div>
              {canManage && <button type="button" onClick={() => setModalState({ mode: 'create' })}><Plus size={16} />위치 등록</button>}
            </div>
            <div className="factory-location-list">
              {selectedLocations.length ? selectedLocations.map((location) => {
                const percent = Math.min(100, Math.round((location.current / Math.max(location.capacity, 1)) * 100))
                return (
                  <article className="factory-location-card" key={location.id}>
                    <div className="factory-location-card__head">
                      <span className={`factory-location-card__kind factory-location-card__kind--${location.kind === '재고' ? 'stock' : 'work'}`}>{location.kind === '재고' ? <Boxes size={16} /> : <FactoryIcon size={16} />}</span>
                      <div><strong>{location.name}</strong><span>{location.code} · {location.kind} 위치</span></div>
                      {canManage && <div className="factory-location-card__actions"><button type="button" aria-label={`${location.name} 수정`} onClick={() => setModalState({ mode: 'edit', location })}><Edit3 size={16} /></button><button type="button" className="is-danger" aria-label={`${location.name} 삭제`} onClick={() => void deleteLocation(location)}><Trash2 size={16} /></button></div>}
                    </div>
                    <div className="factory-location-card__item"><span>{location.item}</span><FactoryStatusBadge state={location.status} /></div>
                    <div className="factory-location-card__quantity"><strong>{location.current.toLocaleString()} {location.unit}</strong><span>/ {location.capacity.toLocaleString()} {location.unit}</span></div>
                    <div
                      className="factory-location-card__bar"
                      role="progressbar"
                      aria-label={`${location.name} 수용량 사용률`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <i style={{ width: `${percent}%` }} />
                    </div>
                    {location.note && <p>{location.note}</p>}
                  </article>
                )
              }) : (
                <div className="factory-location-empty"><Warehouse size={26} /><strong>등록된 위치가 없습니다</strong><span>실제 재고 또는 생산 위치를 등록해 주세요.</span></div>
              )}
            </div>
          </aside>
        </div>
      </section>

      {canManage && modalState && (
        <LocationModal
          factory={factory}
          zones={factory.zones}
          selectedZoneId={selectedZone.id}
          state={modalState}
          onClose={() => setModalState(null)}
          onSave={saveLocation}
        />
      )}
    </div>
  )
}
