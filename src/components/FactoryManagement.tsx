import {
  AlertTriangle,
  Archive,
  Boxes,
  CheckCircle2,
  ChevronDown,
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

type FactoryManagementProps = {
  onToast: (message: string) => void
  canManage: boolean
  companyName?: string
  workspaceScope?: string
  seedDemoData?: boolean
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

type LayoutPurpose = '원료·자재' | '냉장·냉동' | '생산' | '포장' | '출하' | '통로' | '기타'

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

type LocationDraft = Omit<FactoryLocation, 'id' | 'factoryId' | 'current' | 'capacity'> & {
  current: string
  capacity: string
}

type LocationModalState =
  | { mode: 'create'; location?: undefined }
  | { mode: 'edit'; location: FactoryLocation }

const factories: FactoryDefinition[] = [
  {
    id: 'FAC-POH-01',
    name: '햇살바다 포항 제1공장',
    code: 'POH-01',
    address: '경북 포항시 남구 구룡포읍',
    area: '연면적 4,280㎡',
    zones: [
      {
        id: 'raw',
        name: '원료창고',
        shortName: '원료',
        state: '정상',
        utilization: 71,
        primaryLabel: '보관 재고',
        primaryValue: '18,420 kg',
        secondaryLabel: '오늘 입고',
        secondaryValue: '3건 · 1,240kg',
        condition: '18.4℃ · 습도 46%',
        manager: '이동현 주임',
        note: '붉은대게 분말은 8.2일분 재고가 남아 있습니다.',
        nextAction: '내일 10:30 멍게 원물 180kg 입고 예정',
      },
      {
        id: 'frozen',
        name: '냉동창고',
        shortName: '냉동',
        state: '주의',
        utilization: 88,
        primaryLabel: '보관 재고',
        primaryValue: '6,280 kg',
        secondaryLabel: '가용 공간',
        secondaryValue: '12% · 8 PLT',
        condition: '-19.2℃ · 정상',
        manager: '서동현 담당',
        note: 'A-03 랙 사용률이 92%입니다. 금일 출고 후 재배치가 필요합니다.',
        nextAction: '16:00 이전 A-03 랙 3팔레트 우선 출고',
      },
      {
        id: 'production',
        name: '생산구역',
        shortName: '생산',
        state: '가동중',
        utilization: 67,
        primaryLabel: '가동 라인',
        primaryValue: '2 / 3 라인',
        secondaryLabel: '오늘 생산',
        secondaryValue: '4,820 ea',
        condition: '라인 효율 91.4%',
        manager: '오태식 반장',
        note: '1라인은 붉은대게라면 스프 배합, 2라인은 육수다시 충진 중입니다.',
        nextAction: '17:00 붉은대게라면 생산량 확정',
      },
      {
        id: 'packing',
        name: '포장구역',
        shortName: '포장',
        state: '가동중',
        utilization: 54,
        primaryLabel: '가동 라인',
        primaryValue: '1 / 2 라인',
        secondaryLabel: '포장 대기',
        secondaryValue: '1,260 ea',
        condition: '불량률 0.42%',
        manager: '김하늘 주임',
        note: '육수다시 20포 선물세트를 포장하고 있습니다.',
        nextAction: '15:40 라벨 시안 교체 후 초도검사',
      },
      {
        id: 'shipping',
        name: '출하구역',
        shortName: '출하',
        state: '출하중',
        utilization: 62,
        primaryLabel: '출하 대기',
        primaryValue: '14 PLT',
        secondaryLabel: '오늘 주문',
        secondaryValue: '293건',
        condition: '상차 도크 2 / 3 사용',
        manager: '윤서진 담당',
        note: '쿠팡 142건, 네이버 86건을 우선 피킹하고 있습니다.',
        nextAction: '16:30 CJ대한통운 1차 상차 마감',
      },
    ],
  },
  {
    id: 'FAC-GRP-02',
    name: '구룡포 냉동·가공공장',
    code: 'GRP-02',
    address: '경북 포항시 남구 동해안로',
    area: '연면적 2,940㎡',
    zones: [
      {
        id: 'raw',
        name: '원료창고',
        shortName: '원료',
        state: '정상',
        utilization: 64,
        primaryLabel: '보관 재고',
        primaryValue: '12,870 kg',
        secondaryLabel: '오늘 입고',
        secondaryValue: '2건 · 680kg',
        condition: '17.8℃ · 습도 43%',
        manager: '정민석 담당',
        note: '입고 검수 대기 원료는 없습니다.',
        nextAction: '내일 붉은대게 원물 600kg 입고 예정',
      },
      {
        id: 'frozen',
        name: '냉동창고',
        shortName: '냉동',
        state: '정상',
        utilization: 73,
        primaryLabel: '보관 재고',
        primaryValue: '9,410 kg',
        secondaryLabel: '가용 공간',
        secondaryValue: '27% · 21 PLT',
        condition: '-20.1℃ · 정상',
        manager: '박정호 담당',
        note: '모든 온도 센서가 정상 범위입니다.',
        nextAction: '18:00 일일 온도기록 승인',
      },
      {
        id: 'production',
        name: '생산구역',
        shortName: '생산',
        state: '가동중',
        utilization: 82,
        primaryLabel: '가동 라인',
        primaryValue: '2 / 2 라인',
        secondaryLabel: '오늘 생산',
        secondaryValue: '3,160 ea',
        condition: '라인 효율 88.7%',
        manager: '최진호 반장',
        note: '냉동볶음밥과 붉은대게 소스 생산이 진행 중입니다.',
        nextAction: '19:20 생산 종료 후 CIP 세척',
      },
      {
        id: 'packing',
        name: '포장구역',
        shortName: '포장',
        state: '대기',
        utilization: 18,
        primaryLabel: '가동 라인',
        primaryValue: '0 / 1 라인',
        secondaryLabel: '포장 대기',
        secondaryValue: '420 ea',
        condition: '세척 완료 · 대기',
        manager: '문소라 주임',
        note: '17:30 냉동볶음밥 포장을 시작할 예정입니다.',
        nextAction: '작업 전 금속검출기 감도 확인',
      },
      {
        id: 'shipping',
        name: '출하구역',
        shortName: '출하',
        state: '정상',
        utilization: 39,
        primaryLabel: '출하 대기',
        primaryValue: '6 PLT',
        secondaryLabel: '오늘 주문',
        secondaryValue: '84건',
        condition: '상차 도크 1 / 2 사용',
        manager: '이수현 담당',
        note: '냉동 택배 84건의 송장 발행이 완료되었습니다.',
        nextAction: '17:10 냉동 탑차 상차',
      },
    ],
  },
]

function createCustomerFactory(companyName?: string): FactoryDefinition {
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
    id: 'FAC-MAIN-01',
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

const initialLocations: FactoryLocation[] = [
  { id: 'LOC-RM-A01', factoryId: 'FAC-POH-01', zoneId: 'raw', kind: '재고', name: '원료 A동 1열', code: 'RM-A01', item: '붉은대게 분말', current: 4380, capacity: 6000, unit: 'kg', status: '정상', note: 'FEFO 순서로 출고' },
  { id: 'LOC-RM-B02', factoryId: 'FAC-POH-01', zoneId: 'raw', kind: '재고', name: '원료 B동 2열', code: 'RM-B02', item: '건조 다시마·멸치', current: 2680, capacity: 4000, unit: 'kg', status: '정상', note: '상온·건조 보관' },
  { id: 'LOC-FZ-A03', factoryId: 'FAC-POH-01', zoneId: 'frozen', kind: '재고', name: '냉동 A-03 랙', code: 'FZ-A03', item: '붉은대게살', current: 1840, capacity: 2000, unit: 'kg', status: '주의', note: '금일 3팔레트 우선 출고' },
  { id: 'LOC-PR-L01', factoryId: 'FAC-POH-01', zoneId: 'production', kind: '생산', name: '생산 1라인', code: 'PR-L01', item: '붉은대게라면 스프', current: 2460, capacity: 3200, unit: 'ea', status: '정상', note: '배합·건조 공정' },
  { id: 'LOC-PR-L02', factoryId: 'FAC-POH-01', zoneId: 'production', kind: '생산', name: '생산 2라인', code: 'PR-L02', item: '육수다시', current: 2360, capacity: 3000, unit: 'ea', status: '정상', note: '충진 공정' },
  { id: 'LOC-PK-L01', factoryId: 'FAC-POH-01', zoneId: 'packing', kind: '생산', name: '포장 1라인', code: 'PK-L01', item: '육수다시 선물세트', current: 760, capacity: 1400, unit: 'ea', status: '정상', note: '중량·라벨 검사 포함' },
  { id: 'LOC-SH-D02', factoryId: 'FAC-POH-01', zoneId: 'shipping', kind: '재고', name: '출하 도크 2', code: 'SH-D02', item: '온라인 주문 출하품', current: 14, capacity: 24, unit: 'PLT', status: '정상', note: '16:30 1차 상차' },
  { id: 'LOC-GR-F01', factoryId: 'FAC-GRP-02', zoneId: 'frozen', kind: '재고', name: '냉동 1창고', code: 'GR-F01', item: '냉동 수산 원물', current: 6710, capacity: 9200, unit: 'kg', status: '정상', note: '자동 온도기록 중' },
  { id: 'LOC-GR-P01', factoryId: 'FAC-GRP-02', zoneId: 'production', kind: '생산', name: '냉동식품 1라인', code: 'GR-P01', item: '붉은대게살 볶음밥', current: 1780, capacity: 2200, unit: 'ea', status: '정상', note: '급속동결 포함' },
  { id: 'LOC-GR-P02', factoryId: 'FAC-GRP-02', zoneId: 'production', kind: '생산', name: '소스 2라인', code: 'GR-P02', item: '붉은대게 어간장', current: 1380, capacity: 1800, unit: 'ea', status: '점검', note: '충진 노즐 점검 예정' },
]

const initialFactoryLayouts: FactoryLayouts = {
  'FAC-POH-01': [
    { id: 'BLOCK-POH-RAW', factoryId: 'FAC-POH-01', zoneId: 'raw', name: '원료·자재 창고', purpose: '원료·자재', kind: '재고', x: 3, y: 5, width: 28, height: 33, color: '#d9efe1', item: '붉은대게 분말 외 원료', current: 7060, capacity: 10000, unit: 'kg', note: '입고 검수 후 FEFO 배치' },
    { id: 'BLOCK-POH-FROZEN', factoryId: 'FAC-POH-01', zoneId: 'frozen', name: '냉동 A동', purpose: '냉장·냉동', kind: '재고', x: 3, y: 51, width: 28, height: 41, color: '#d5eaf5', item: '붉은대게살', current: 1840, capacity: 2000, unit: 'kg', note: '-19℃ 유지 · A-03 우선 출고' },
    { id: 'BLOCK-POH-PROD', factoryId: 'FAC-POH-01', zoneId: 'production', name: '생산 1·2라인', purpose: '생산', kind: '생산', x: 36, y: 5, width: 36, height: 40, color: '#fae4c7', item: '라면 스프 · 육수다시', current: 4820, capacity: 6200, unit: 'ea', note: '1라인 배합 · 2라인 충진' },
    { id: 'BLOCK-POH-PACK', factoryId: 'FAC-POH-01', zoneId: 'packing', name: '포장구역', purpose: '포장', kind: '생산', x: 36, y: 59, width: 36, height: 33, color: '#e8dcf2', item: '선물세트', current: 760, capacity: 1400, unit: 'ea', note: '중량·라벨 검사 포함' },
    { id: 'BLOCK-POH-SHIP', factoryId: 'FAC-POH-01', zoneId: 'shipping', name: '출하 도크', purpose: '출하', kind: '재고', x: 77, y: 5, width: 20, height: 87, color: '#d8eee9', item: '온라인 주문 출하품', current: 14, capacity: 24, unit: 'PLT', note: '16:30 1차 상차' },
  ],
  'FAC-GRP-02': [
    { id: 'BLOCK-GRP-RAW', factoryId: 'FAC-GRP-02', zoneId: 'raw', name: '원료창고', purpose: '원료·자재', kind: '재고', x: 4, y: 6, width: 29, height: 35, color: '#d9efe1', item: '수산 원물', current: 12870, capacity: 20000, unit: 'kg', note: '입고 검수 대기 없음' },
    { id: 'BLOCK-GRP-FROZEN', factoryId: 'FAC-GRP-02', zoneId: 'frozen', name: '냉동 1창고', purpose: '냉장·냉동', kind: '재고', x: 4, y: 51, width: 29, height: 42, color: '#d5eaf5', item: '냉동 수산 원물', current: 6710, capacity: 9200, unit: 'kg', note: '자동 온도기록 중' },
    { id: 'BLOCK-GRP-PROD', factoryId: 'FAC-GRP-02', zoneId: 'production', name: '냉동식품 생산라인', purpose: '생산', kind: '생산', x: 38, y: 6, width: 36, height: 49, color: '#fae4c7', item: '볶음밥 · 어간장', current: 3160, capacity: 4000, unit: 'ea', note: '2개 라인 가동 중' },
    { id: 'BLOCK-GRP-PACK', factoryId: 'FAC-GRP-02', zoneId: 'packing', name: '포장·검사', purpose: '포장', kind: '생산', x: 38, y: 65, width: 36, height: 28, color: '#e8dcf2', item: '냉동볶음밥', current: 420, capacity: 1200, unit: 'ea', note: '금속검출기 감도 확인' },
    { id: 'BLOCK-GRP-SHIP', factoryId: 'FAC-GRP-02', zoneId: 'shipping', name: '냉동 출하장', purpose: '출하', kind: '재고', x: 79, y: 6, width: 17, height: 87, color: '#d8eee9', item: '냉동 택배', current: 6, capacity: 18, unit: 'PLT', note: '17:10 냉동 탑차 상차' },
  ],
}

const emptyFactoryLayouts: FactoryLayouts = {}
const emptyFactoryLocations: FactoryLocation[] = []

function isLayoutBlock(value: unknown): value is LayoutBlock {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<LayoutBlock>
  return typeof item.id === 'string' && typeof item.factoryId === 'string' && typeof item.name === 'string'
    && ['raw', 'frozen', 'production', 'packing', 'shipping'].includes(item.zoneId ?? '')
    && ['원료·자재', '냉장·냉동', '생산', '포장', '출하', '통로', '기타'].includes(item.purpose ?? '')
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

const statusTone = (state: ZoneState | LocationState) => {
  if (state === '주의' || state === '점검') return 'warning'
  if (state === '대기' || state === '비가동') return 'idle'
  return 'good'
}

const formatFileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function StatusBadge({ state }: { state: ZoneState | LocationState }) {
  return <span className={`factory-status factory-status--${statusTone(state)}`}><i />{state}</span>
}

function ZoneIcon({ kind, size = 20 }: { kind: ZoneKind; size?: number }) {
  const Icon = zonePresentation[kind].icon
  return <Icon size={size} aria-hidden="true" />
}

const MIN_BLOCK_SIZE = 8
const BLOCK_GAP = .6

function blocksOverlap(left: LayoutBlock, right: LayoutBlock, gap = BLOCK_GAP) {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y
}

function normalizeBlockGeometry(block: LayoutBlock): LayoutBlock {
  const round = (value: number) => Math.round(value * 10) / 10
  const width = round(Math.min(100, Math.max(MIN_BLOCK_SIZE, block.width)))
  const height = round(Math.min(100, Math.max(MIN_BLOCK_SIZE, block.height)))
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
  const gestureRef = useRef<BlockGesture | null>(null)
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [interactionMessage, setInteractionMessage] = useState('배경을 드래그해 이동하고 마우스 휠로 확대·축소할 수 있습니다.')

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
  }

  const stopPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.kind !== 'move' || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
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
    let x = original.x
    let y = original.y
    let width = original.width
    let height = original.height
    if (gesture.corner.includes('e')) width = clamp(original.width + dx, MIN_BLOCK_SIZE, 100 - original.x)
    if (gesture.corner.includes('s')) height = clamp(original.height + dy, MIN_BLOCK_SIZE, 100 - original.y)
    if (gesture.corner.includes('w')) {
      x = clamp(original.x + dx, 0, original.x + original.width - MIN_BLOCK_SIZE)
      width = original.width + original.x - x
    }
    if (gesture.corner.includes('n')) {
      y = clamp(original.y + dy, 0, original.y + original.height - MIN_BLOCK_SIZE)
      height = original.height + original.y - y
    }
    onChange(block.id, { x, y, width, height }, false)
  }

  const stopResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.kind !== 'resize' || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
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
        width: clamp(block.width + horizontal, 8, 100 - block.x),
        height: clamp(block.height + vertical, 8, 100 - block.y),
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
      return <button
        type="button"
        className={`factory-layout-block${selectedId === block.id ? ' is-selected' : ''}`}
        style={{ left: `${block.x}%`, top: `${block.y}%`, width: `${block.width}%`, height: `${block.height}%`, backgroundColor: block.color }}
        aria-pressed={selectedId === block.id}
        aria-label={`${block.name}, ${block.purpose}, ${block.item || '품목 미등록'}, 위치 ${Math.round(block.x)} ${Math.round(block.y)}, 크기 ${Math.round(block.width)} ${Math.round(block.height)}`}
        onClick={() => onSelect(block)}
        onPointerDown={(event) => onPointerDown(event, block)}
        onPointerMove={(event) => onPointerMove(event, block)}
        onPointerUp={stopPointer}
        onPointerCancel={stopPointer}
        onKeyDown={(event) => onKeyDown(event, block)}
        key={block.id}
      >
        <span className="factory-layout-block__head"><ZoneIcon kind={block.zoneId} /><span><strong>{block.name}</strong><small>{block.purpose} · {block.kind}</small></span>{editable && <Move size={16} />}</span>
        <span className="factory-layout-block__item">{block.item || '품목·설비 미등록'}</span>
        <span className="factory-layout-block__quantity"><strong>{block.current.toLocaleString()} {block.unit}</strong><small>/ {block.capacity.toLocaleString()} {block.unit}</small></span>
        <span className="factory-layout-block__meter"><i style={{ width: `${percent}%` }} /></span>
        {editable && selectedId === block.id && (['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((corner) => <span
          className={`factory-resize-handle factory-resize-handle--${corner}`}
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, block, corner)}
          onPointerMove={(event) => resizeBlock(event, block)}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
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
        {field('공간 용도', <select value={block.purpose} disabled={!canManage} onChange={(event) => onChange({ purpose: event.target.value as LayoutPurpose })}><option>원료·자재</option><option>냉장·냉동</option><option>생산</option><option>포장</option><option>출하</option><option>통로</option><option>기타</option></select>)}
        {field('위치 유형', <select value={block.kind} disabled={!canManage} onChange={(event) => onChange({ kind: event.target.value as LocationKind })}><option>재고</option><option>생산</option></select>)}
      </div>
      <div className="factory-layout-form__row">
        {field('연결 구역', <select value={block.zoneId} disabled={!canManage} onChange={(event) => onChange({ zoneId: event.target.value as ZoneKind })}><option value="raw">원료</option><option value="frozen">냉장·냉동</option><option value="production">생산</option><option value="packing">포장</option><option value="shipping">출하</option></select>)}
        {field('블록 색상', <span className="factory-color-input"><input type="color" value={block.color} disabled={!canManage} onChange={(event) => onChange({ color: event.target.value })} /><code>{block.color}</code></span>)}
      </div>
      <div className="factory-layout-size-grid" aria-label="블록 위치와 크기">
        {field('X', <input type="number" min="0" max={100 - block.width} step="1" value={Math.round(block.x)} disabled={!canManage} onChange={(event) => onChange({ x: Math.min(100 - block.width, Math.max(0, number(event.target.value, block.x))) })} />)}
        {field('Y', <input type="number" min="0" max={100 - block.height} step="1" value={Math.round(block.y)} disabled={!canManage} onChange={(event) => onChange({ y: Math.min(100 - block.height, Math.max(0, number(event.target.value, block.y))) })} />)}
        {field('너비 %', <input type="number" min="8" max={100 - block.x} step="1" value={Math.round(block.width)} disabled={!canManage} onChange={(event) => onChange({ width: Math.min(100 - block.x, Math.max(8, number(event.target.value, block.width))) })} />)}
        {field('높이 %', <input type="number" min="8" max={100 - block.y} step="1" value={Math.round(block.height)} disabled={!canManage} onChange={(event) => onChange({ height: Math.min(100 - block.y, Math.max(8, number(event.target.value, block.height))) })} />)}
      </div>
      {field(block.kind === '생산' ? '생산 품목·설비' : '보관 품목', <input value={block.item} disabled={!canManage} placeholder="품목 또는 설비명" onChange={(event) => onChange({ item: event.target.value })} />)}
      <div className="factory-layout-form__row three">
        {field('현재량', <input type="number" min="0" value={block.current} disabled={!canManage} onChange={(event) => onChange({ current: Math.max(0, number(event.target.value, block.current)) })} />)}
        {field('수용량', <input type="number" min="1" value={block.capacity} disabled={!canManage} onChange={(event) => onChange({ capacity: Math.max(1, number(event.target.value, block.capacity)) })} />)}
        {field('단위', <select value={block.unit} disabled={!canManage} onChange={(event) => onChange({ unit: event.target.value })}><option>kg</option><option>ea</option><option>BOX</option><option>PLT</option><option>라인</option></select>)}
      </div>
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

export function FactoryManagement({ onToast, canManage, companyName, workspaceScope, seedDemoData = true }: FactoryManagementProps) {
  const availableFactories = useMemo(
    () => seedDemoData ? factories : [createCustomerFactory(companyName)],
    [companyName, seedDemoData],
  )
  const [selectedFactoryId, setSelectedFactoryId] = useState(availableFactories[0].id)
  const [selectedZoneId, setSelectedZoneId] = useState<ZoneKind>('raw')
  const [locations, setLocations] = useWorkspaceState<FactoryLocation[]>('factory-locations', seedDemoData ? initialLocations : emptyFactoryLocations, { scope: workspaceScope, seedWhenEmpty: canManage, validate: isFactoryLocationList })
  const [layouts, setLayouts] = useWorkspaceState<FactoryLayouts>('factory-layouts', seedDemoData ? initialFactoryLayouts : emptyFactoryLayouts, { scope: workspaceScope, seedWhenEmpty: canManage, validate: isFactoryLayouts })
  const [drawings, setDrawings] = useState<Record<string, DrawingMeta>>({})
  const [drawingsLoading, setDrawingsLoading] = useState(true)
  const [drawingBusy, setDrawingBusy] = useState(false)
  const [showBackground, setShowBackground] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [overviewExpanded, setOverviewExpanded] = useState(false)
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(initialFactoryLayouts[availableFactories[0].id]?.[0]?.id ?? null)
  const [dragActive, setDragActive] = useState(false)
  const [modalState, setModalState] = useState<LocationModalState | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const objectUrlsRef = useRef(new Set<string>())

  const factory = availableFactories.find((item) => item.id === selectedFactoryId) ?? availableFactories[0]
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
    if (!result.ok) return
    setSelectedZoneId(location.zoneId)
    setModalState(null)
    onToast(`${location.name} 위치를 ${editing ? '수정' : '등록'}했습니다.`)
  }

  const selectBlock = (block: LayoutBlock) => {
    setSelectedBlockId(block.id)
    setSelectedZoneId(block.zoneId)
  }

  const updateBlock = (id: string, patch: Partial<LayoutBlock>, persist = true) => {
    const currentBlock = factoryBlocks.find((block) => block.id === id)
    if (!currentBlock) return
    const candidate = normalizeBlockGeometry({ ...currentBlock, ...patch })
    const hasCollision = factoryBlocks.some((block) => block.id !== id && blocksOverlap(candidate, block))
    if (hasCollision) {
      if (persist && Object.keys(patch).length > 0) onToast('다른 블록과 겹칠 수 없습니다. 빈 공간으로 이동하거나 크기를 줄여 주세요.')
      return
    }
    void setLayouts((current) => ({
      ...current,
      [factory.id]: (current[factory.id] ?? []).map((block) => block.id === id ? candidate : block),
    }), { persist }).then((result) => {
      if (persist && !result.ok && result.message) onToast(result.message)
    })
  }

  const addBlock = async () => {
    if (!canManage) return
    const freePosition = findFreeBlockPosition(factoryBlocks, 24, 22)
    if (!freePosition) {
      onToast('새 블록을 놓을 빈 공간이 없습니다. 기존 블록을 이동하거나 크기를 줄여 주세요.')
      return
    }
    const next: LayoutBlock = {
      id: `BLOCK-${Date.now()}`,
      factoryId: factory.id,
      zoneId: 'production',
      name: '새 공간 블록',
      purpose: '기타',
      kind: '생산',
      x: freePosition.x,
      y: freePosition.y,
      width: 24,
      height: 22,
      color: '#e8eee9',
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
    onToast('새 배치 블록을 추가했습니다. 위치와 크기를 조정해 주세요.')
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

  return (
    <div className="factory-page">
      <header className="factory-page__head">
        <div>
          <span className="factory-page__kicker">FACTORY CONTROL</span>
          <h1>공장관리</h1>
          <p>공장 배치도 위에서 재고, 생산, 포장과 출하 흐름을 확인하고 실제 위치를 관리합니다.</p>
        </div>
        <label className="factory-selector">
          <span>관리 공장</span>
          <select value={factory.id} onChange={selectFactory} aria-label="관리할 공장 선택">
            {availableFactories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </label>
      </header>

      <section className={`factory-overview${overviewExpanded ? ' is-expanded' : ''}`} aria-label="선택 공장 운영 요약">
        <div className="factory-overview__main">
          <div className="factory-identity factory-identity--compact">
            <span className="factory-identity__mark"><FactoryIcon size={20} aria-hidden="true" /></span>
            <div><strong>{factory.name}</strong><span>{factory.code} · {factory.address} · {factory.area}</span></div>
            <span className="factory-identity__live"><i />{seedDemoData ? '운영 중' : '초기 설정'}</span>
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
          <div><span>SHARED FLOOR EDITOR</span><h2 id="factory-layout-title">공장 블록 배치 편집기</h2><p id="factory-layout-help">블록 드래그 이동 · 모서리 크기 조절 · 배경 드래그 이동 · 휠 확대/축소. 키보드는 방향키, Alt+방향키, +/−/0을 지원합니다.</p></div>
          <div className="factory-layout-actions" role="group" aria-label="배치 편집 도구">
            {drawing?.kind === 'image' && <button type="button" className={showBackground ? 'is-active' : ''} aria-pressed={showBackground} onClick={() => setShowBackground((value) => !value)}><FileImage size={16} />배경 도면</button>}
            {canManage && <button type="button" className={editMode ? 'is-active' : ''} aria-pressed={editMode} onClick={() => setEditMode((value) => !value)}><MousePointer2 size={16} />{editMode ? '편집 종료' : '배치 편집'}</button>}
            {canManage && <button type="button" className="is-primary" onClick={addBlock}><Plus size={16} />블록 추가</button>}
          </div>
        </div>

        <div className="factory-workspace">
          <div className="factory-map-column">
            <div className="factory-map-frame">
              <LayoutEditor factory={factory} blocks={factoryBlocks} selectedId={selectedBlockId} editable={canManage && editMode} drawing={drawing} showBackground={showBackground} onSelect={selectBlock} onChange={updateBlock} />
            </div>
            <div className="factory-legend" aria-label="배치도 범례">
              <strong><Palette size={14} /> 블록 색은 우측 속성에서 변경</strong>
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
              {selectedBlock && <span className="factory-layout-purpose">{selectedBlock.purpose}</span>}
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
                       {canManage && <button type="button" aria-label={`${location.name} 수정`} onClick={() => setModalState({ mode: 'edit', location })}><Edit3 size={16} /></button>}
                    </div>
                    <div className="factory-location-card__item"><span>{location.item}</span><StatusBadge state={location.status} /></div>
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
