import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  FileCheck2,
  FileUp,
  ExternalLink,
  ImagePlus,
  Package,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Store,
  Tags,
  Trash2,
  Truck,
  Printer,
  Warehouse,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { ChannelMetric, SeaProduct } from '../domainData'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateTime } from '../utils/dateTime'
import { daysUntil } from '../utils/expiryStatus'
import { checkLabelFields, collectLabelIssues, openLabelMemo, storedLabelStatus, summarizeLabel } from '../utils/foodLabelCheck'
import { SALES_PERIODS, summarizeShipments, type SalesPeriod } from '../utils/salesPeriod'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './BusinessPagesEnhancements.css'
import { Button, IconButton, buttonClassName } from './ui/Button'

type BusinessPageProps = {
  onToast: (message: string) => void
}

type TenantBusinessPageProps = BusinessPageProps & {
  workspaceScope?: string
  companyName?: string
}

type ProductDetailTab = 'basic' | 'label' | 'channels' | 'inventory'
type ChannelSetupStatus = 'setup-required' | 'credentials-entered' | 'test-pending'

/**
 * 판매채널 목록의 한 줄. 아직 어느 판매자센터와도 직접 연결하지 않는다 —
 * 주문 수·판매수량은 출고 주문(sales-shipments)에서 세고, orders·revenue 같은 합계 칸은 채우는 곳이 없다.
 * 아래 선택 칸들은 예전 '연결 설정'이 남긴 흔적이다(키 끝 4자리·판매자 ID·점검 결과). 새로 쓰지 않고, 쓸 때 걷어 낸다.
 */
type ManagedChannel = ChannelMetric & {
  connectionStatus?: ChannelSetupStatus
  sellerAccount?: string
  credentialHint?: string
  credentialFields?: Record<string, string>
  checkedAt?: string
  health?: unknown
}

type ChannelDefinition = {
  id: string
  name: string
  short: string
  color: string
  sellerUrl: string
}

type ShipmentStatus = '출고대기' | '송장등록' | '출고완료'

type SalesShipment = {
  id: string
  orderNo: string
  channelId: string
  channelName: string
  recipient: string
  phone: string
  address: string
  productName: string
  quantity: number
  courier: string
  trackingNo: string
  status: ShipmentStatus
  orderedAt: string
  shippedAt?: string
}

const couriers = ['CJ대한통운', '한진택배', '롯데택배', '로젠택배', '우체국택배']

function isSalesShipmentList(value: unknown): value is SalesShipment[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false
    const shipment = item as Partial<SalesShipment>
    return typeof shipment.id === 'string'
      && typeof shipment.orderNo === 'string'
      && typeof shipment.channelId === 'string'
      && typeof shipment.recipient === 'string'
      && typeof shipment.quantity === 'number'
      && ['출고대기', '송장등록', '출고완료'].includes(shipment.status ?? '')
  })
}

function parseCsvRow(line: string) {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"' && quoted && line[index + 1] === '"') {
      current += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      cells.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  cells.push(current.trim())
  return cells
}

function useModalFocus(active: boolean) {
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!active) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(selector))
    window.setTimeout(() => focusables[0]?.focus(), 0)

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const current = Array.from(dialog.querySelectorAll<HTMLElement>(selector))
      if (current.length === 0) return
      const first = current[0]
      const last = current[current.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', trapFocus)
    return () => {
      dialog.removeEventListener('keydown', trapFocus)
      previousFocus?.focus()
    }
  }, [active])

  return dialogRef
}

/**
 * 고를 수 있는 판매채널과 각 판매자센터 주소.
 *
 * 전에는 채널마다 API 키 입력칸(Access Key·Secret 등)과 준비 체크리스트를 두고 '연결 설정'을 받았지만,
 * 받은 키는 버리고 끝 4자리만 남겼으며 서버에는 채널 커넥터가 없어 아무 연결도 일어나지 않았다.
 * 커넥터가 생기기 전까지는 판매자센터 바로가기와 출고 주문 CSV만 둔다.
 */
const channelDefinitions: ChannelDefinition[] = [
  { id: 'coupang', name: '쿠팡', short: 'C', color: 'var(--color-danger)', sellerUrl: 'https://wing.coupang.com/' },
  { id: 'naver', name: '네이버 스마트스토어', short: 'N', color: 'var(--color-success)', sellerUrl: 'https://sell.smartstore.naver.com/' },
  { id: 'gmarket', name: 'G마켓 · 옥션', short: 'G', color: 'var(--color-blue)', sellerUrl: 'https://www.esmplus.com/' },
  { id: '11st', name: '11번가', short: '11', color: 'var(--color-danger)', sellerUrl: 'https://soffice.11st.co.kr/' },
  { id: 'ssg', name: 'SSG.COM', short: 'S', color: 'var(--color-danger)', sellerUrl: 'https://partners.ssgadm.com/' },
  { id: 'kakao', name: '카카오 톡스토어 · 선물하기', short: 'K', color: 'var(--color-warning)', sellerUrl: 'https://shopping-sell.kakao.com/hub' },
  { id: 'own', name: '카페24 자사몰', short: '24', color: 'var(--color-blue-deep)', sellerUrl: 'https://eclogin.cafe24.com/Shop/' },
]

/** 모든 채널에 같은 말이다 — 아직 어느 판매자센터와도 직접 연결하지 않는다. */
const CHANNEL_NOT_CONNECTED = '판매자센터와 직접 연결 전'

function channelDefinition(channelId: string) {
  return channelDefinitions.find((definition) => definition.id === channelId)
}

function channelTokenColor(channelId: string) {
  return channelDefinition(channelId)?.color ?? 'var(--color-blue)'
}

function normalizeManagedChannel(channel: ManagedChannel): ManagedChannel {
  return {
    ...channel,
    status: channel.status ?? '설정중',
    connectionStatus: channel.connectionStatus ?? 'setup-required',
  }
}

function emptyManagedChannel(definition: ChannelDefinition): ManagedChannel {
  return {
    id: definition.id,
    name: definition.name,
    short: definition.short,
    color: definition.color,
    orders: 0,
    units: 0,
    revenue: 0,
    delta: 0,
    sync: CHANNEL_NOT_CONNECTED,
    status: '설정중',
    connectionStatus: 'setup-required',
  }
}

/**
 * 예전 '연결 설정'이 남긴 흔적(비밀키 끝 4자리·판매자 ID·점검 결과)을 걷어 낸다.
 * 그 입력으로는 아무 연결도 일어나지 않았으므로 남겨 둘 이유가 없다 — 채널 목록을 저장할 때마다 적용한다.
 */
function withoutCredentialTraces(channel: ManagedChannel): ManagedChannel {
  const next: ManagedChannel = { ...channel, connectionStatus: 'setup-required', sync: CHANNEL_NOT_CONNECTED }
  delete next.credentialHint
  delete next.credentialFields
  delete next.sellerAccount
  delete next.checkedAt
  delete next.health
  return next
}

function isManagedChannelList(value: unknown): value is ManagedChannel[] {
  return Array.isArray(value) && value.every((item) => Boolean(
    item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string',
  ))
}

type ProductFact = {
  manufacturer: string
  manufacturingType: string
  foodType: string
  barcode: string
  shelfLife: string
  origin: string
  ingredients: string
  /** 예전 규칙 공식(100 − 문제 수 × 11, 최저 45)의 결과. 더 쓰지도 보여 주지도 않는다 — 옛 기록 호환용. */
  labelScore?: number
  labelOwner: string
  /** 예전 검증 문장. 화면은 칸 점검(summarizeLabel)에서 그때그때 만든다 — 옛 기록 호환용. */
  labelSummary?: string
  /** 표시 검토 담당자의 메모. 사람이 쓴 말이다 — 검증이 덮어쓰지 않는다. */
  labelIssue: string
  lotNo: string
  warehouse: string
  location: string
  manufacturedAt: string
  expiresAt: string
  daysToExpire: number
  inspection: string
  reserved: number
}

type ProductValidation = {
  checkedAt: string
  issues: string[]
}

type ManagedProduct = SeaProduct & {
  fact: ProductFact
  validation?: ProductValidation
  imageDataUrl?: string
  imageFileName?: string
}

type ProductEditorState = {
  productId?: string
}

const defaultProductFact: ProductFact = {
  manufacturer: '',
  manufacturingType: '자체생산',
  foodType: '',
  barcode: '',
  shelfLife: '',
  origin: '',
  ingredients: '',
  labelOwner: '품질관리 담당자 미지정',
  labelIssue: '',
  lotNo: 'LOT 미등록',
  warehouse: '창고 미지정',
  location: '-',
  manufacturedAt: '-',
  expiresAt: '-',
  daysToExpire: 0,
  inspection: '대기',
  reserved: 0,
}

const PRODUCT_IMAGE_MAX_SOURCE_BYTES = 5 * 1024 * 1024
const PRODUCT_IMAGE_MAX_DATA_URL_LENGTH = 180_000
const PRODUCT_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function isStoredProductImage(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string'
    && value.length <= PRODUCT_IMAGE_MAX_DATA_URL_LENGTH
    && /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(value))
}

function isManagedProductList(value: unknown): value is ManagedProduct[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as Partial<ManagedProduct>
    return typeof candidate.id === 'string'
      && typeof candidate.code === 'string'
      && typeof candidate.name === 'string'
      && Boolean(candidate.fact && typeof candidate.fact === 'object')
      && isStoredProductImage(candidate.imageDataUrl)
  })
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.'))
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('이미지 파일 형식이 올바르지 않습니다.'))
    reader.readAsDataURL(file)
  })
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('이미지를 해석하지 못했습니다.'))
    image.src = source
  })
}

async function prepareProductImage(file: File) {
  if (!PRODUCT_IMAGE_MIME_TYPES.has(file.type)) throw new Error('JPG, PNG 또는 WEBP 이미지만 등록할 수 있습니다.')
  if (file.size > PRODUCT_IMAGE_MAX_SOURCE_BYTES) throw new Error('원본 이미지는 5MB 이하여야 합니다.')

  const source = await readFileAsDataUrl(file)
  const image = await loadImage(source)
  const maxEdge = 900
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('브라우저에서 이미지 변환을 시작하지 못했습니다.')
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim()
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  let quality = 0.86
  let dataUrl = canvas.toDataURL('image/jpeg', quality)
  while (dataUrl.length > PRODUCT_IMAGE_MAX_DATA_URL_LENGTH && quality > 0.42) {
    quality -= 0.08
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  }
  if (!isStoredProductImage(dataUrl)) throw new Error('이미지 용량을 줄이지 못했습니다. 더 작은 이미지를 선택해 주세요.')
  return dataUrl
}

/**
 * '필수항목 다시 확인'을 누른 기록을 남긴다(언제·무엇이 빠졌는지). 점수는 매기지 않는다.
 * 사람의 메모 칸(labelIssue)은 건드리지 않는다 — 전에는 첫 번째 문제 문장으로 덮어써서, 칸을 채운 뒤에도
 * 그 문장이 '열린 메모'로 남아 문제가 영영 사라지지 않았다.
 */
function validateLabelRecord(product: ManagedProduct): ManagedProduct {
  const issues = collectLabelIssues(product)
  return {
    ...product,
    labelStatus: storedLabelStatus(product),
    validation: { checkedAt: new Date().toISOString(), issues },
  }
}

/** 편집 칸에 다시 채울 메모. 예전 검증이 덮어써 둔 자기 문장은 사람의 메모가 아니므로 비운다. */
function openLabelMemoFor(fact: ProductFact) {
  return openLabelMemo({ name: '', storage: '', fact })
}

/** 가용재고가 안전재고 이하인가. 요약 칸과 재고 탭 경고가 같은 규칙을 쓴다. */
function isBelowSafetyStock(product: Pick<SeaProduct, 'available' | 'safetyStock'>) {
  return product.available <= product.safetyStock
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('ko-KR').format(Math.round(value))
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(Math.round(value))
}

function toneForStatus(status: string): StatusBadgeTone {
  if (['정상', '승인', '적합', '판매중', '출고완료'].includes(status)) return 'success'
  if (['주의', '검토중', '재검사', '매핑 확인', '출고대기', '송장등록'].includes(status)) return 'warning'
  if (['수정필요', '품절', '판매중지'].includes(status)) return 'danger'
  return 'neutral'
}

function BusinessStatusBadge({ status }: { status: string }) {
  return <StatusBadge tone={toneForStatus(status)}>{status}</StatusBadge>
}

/** 표시 필수항목 상태. 저장값('승인' 등)이 아니라 지금 칸이 채워졌는지에서 그때그때 만든다. */
function LabelStatusBadge({ product, prefix = '' }: { product: ManagedProduct; prefix?: string }) {
  const summary = summarizeLabel(product)
  return <StatusBadge tone={summary.complete ? 'success' : 'warning'}>{prefix}{summary.label}</StatusBadge>
}

function ProductVisual({ product, compact = false }: { product: SeaProduct & { imageDataUrl?: string }; compact?: boolean }) {
  const customImage = isStoredProductImage(product.imageDataUrl) ? product.imageDataUrl : undefined
  return (
    <div
      className={`product-crop crop-${product.visual}${customImage ? ' custom-image' : ''}${compact ? ' compact' : ''}`}
      role="img"
      aria-label={`${product.shortName} 제품 사진`}
    >
      {customImage ? <img src={customImage} alt="" /> : <Package size={compact ? 28 : 42} aria-hidden="true" />}
    </div>
  )
}

function BusinessSummaryStrip({ items, label }: {
  label: string
  items: Array<{ icon: typeof Package; label: string; value: string; helper: string; tone?: string }>
}) {
  return (
    <section className={`business-summary-strip${items.length === 3 ? ' is-three' : ''}`} aria-label={label}>
      {items.map((item) => {
        const Icon = item.icon
        return (
          <div className={item.tone ?? ''} key={item.label}>
            <span className="business-summary-strip-icon"><Icon size={18} aria-hidden="true" /></span>
            <span><small>{item.label}</small><strong>{item.value}</strong></span>
            <em>{item.helper}</em>
          </div>
        )
      })}
    </section>
  )
}

export function ProductManagement({ onToast, canManage = true, workspaceScope, companyName = '고객사' }: TenantBusinessPageProps & { canManage?: boolean }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('전체')
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<ProductDetailTab>('basic')
  const [editor, setEditor] = useState<ProductEditorState | null>(null)
  const [productSaveError, setProductSaveError] = useState('')
  const [storedProducts, setProducts] = useWorkspaceState<ManagedProduct[]>(
    'product-catalog',
    [],
    { scope: workspaceScope, seedWhenEmpty: false, validate: isManagedProductList },
  )
  const [storedSalesChannels] = useWorkspaceState<ManagedChannel[]>(
    'sales-channels',
    [],
    { scope: workspaceScope, enabled: canManage, seedWhenEmpty: false, validate: isManagedChannelList },
  )

  const products = storedProducts
  const productSalesChannels = useMemo(() => storedSalesChannels.map(normalizeManagedChannel), [storedSalesChannels])
  const selectedProduct = products.find((product) => product.id === selectedProductId) ?? null
  const editingProduct = editor?.productId ? products.find((product) => product.id === editor.productId) ?? null : null
  const categories = useMemo(
    () => ['전체', ...Array.from(new Set(products.map((product) => product.category)))],
    [products],
  )

  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return products.filter((product) => {
      const matchesCategory = category === '전체' || product.category === category
      const matchesQuery = !normalizedQuery
        || `${product.name} ${product.code} ${product.category}`.toLowerCase().includes(normalizedQuery)
      return matchesCategory && matchesQuery
    })
  }, [category, products, query])

  const openProduct = (product: SeaProduct) => {
    setDetailTab('basic')
    setSelectedProductId(product.id)
  }

  const openEditor = (productId?: string) => {
    setProductSaveError('')
    setSelectedProductId(null)
    setEditor({ productId })
  }

  const commitProductChange = async (action: (current: ManagedProduct[]) => ManagedProduct[]) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await setProducts(action)
      if (result.ok || !result.message?.includes('불러오는 중')) return result
      await new Promise((resolve) => window.setTimeout(resolve, 150))
    }
    return { ok: false, persisted: false, message: '공유 데이터 준비가 지연되고 있습니다. 잠시 후 다시 저장해 주세요.' }
  }

  const saveProduct = async (next: ManagedProduct, isNew: boolean) => {
    setProductSaveError('')
    const result = await commitProductChange((current) => isNew
      ? [next, ...current]
      : current.map((product) => product.id === next.id ? next : product))
    if (!result.ok) {
      const message = result.message ?? '제품 정보를 저장하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'
      setProductSaveError(message)
      onToast(message)
      return { ok: false, message }
    }
    setEditor(null)
    setSelectedProductId(next.id)
    setDetailTab('basic')
    onToast(isNew ? `${next.shortName} 제품을 등록했습니다.` : `${next.shortName} 제품 정보를 저장했습니다.`)
    return { ok: true }
  }

  const validateProduct = async (productId: string) => {
    const source = products.find((product) => product.id === productId)
    if (!source) return
    const validated = validateLabelRecord(source)
    const result = await commitProductChange((current) => current.map((product) => product.id === productId ? validated : product))
    if (!result.ok) {
      onToast(result.message ?? '표시정보 검증 결과를 저장하지 못했습니다.')
      return
    }
    setDetailTab('label')
    onToast(validated.validation?.issues.length
      ? `${validated.shortName} 표시 필수항목에서 확인할 것 ${validated.validation.issues.length}건을 기록했습니다.`
      : `${validated.shortName} 표시 필수항목이 모두 채워져 있습니다. 확인 시각을 기록했습니다.`)
  }

  const deleteProduct = async (product: ManagedProduct) => {
    if (!window.confirm(`‘${product.shortName}’ 제품을 삭제할까요? 기존 출고·재고 이력의 제품명 기록은 유지됩니다.`)) return false
    const result = await commitProductChange((current) => current.filter((item) => item.id !== product.id))
    if (!result.ok) {
      const message = result.message ?? '제품을 삭제하지 못했습니다.'
      onToast(message)
      return false
    }
    setSelectedProductId(null)
    setEditor(null)
    onToast(`${product.shortName} 제품을 삭제했습니다.`)
    return true
  }

  // 요약 칸은 이름과 같은 것을 센다. 전에는 '재고 확인 — 안전재고 이하'가 실제로는 운영상태가 '정상'이 아닌 제품 수였고,
  // '상품 채널'은 만들 때 0으로 박힌 뒤 바뀌지 않는 칸(channels)의 합, 직원 화면 '재고 연결'은 제품 수 그대로였다.
  const belowSafetyCount = products.filter(isBelowSafetyStock).length
  const labelAttentionCount = products.filter((product) => !summarizeLabel(product).complete).length

  return (
    <div className="page-enter business-page product-management-page">
      <header className="page-heading business-page-head">
        <div>
          <div className="page-kicker">Product control</div>
          <h1>제품관리</h1>
          <p>{canManage ? `${companyName}의 제품 기준정보와 표시 필수항목, 재고를 제품별로 관리합니다.` : '제품 기준정보, 표시 필수항목과 재고를 업무에 필요한 범위에서 조회합니다.'}</p>
        </div>
        {canManage && <div className="heading-actions">
          <Button tone="primary" type="button" onClick={() => openEditor()}>
            <Package size={17} aria-hidden="true" /> 제품 등록
          </Button>
        </div>}
      </header>

      <BusinessSummaryStrip label="제품 주요 현황" items={[
        { icon: Boxes, label: '운영 제품', value: `${products.length}개`, helper: '등록한 제품' },
        { icon: AlertTriangle, label: '재고 확인', value: `${belowSafetyCount}개`, helper: products.length ? '가용재고가 안전재고 이하' : '등록 대기', tone: 'warning' },
        { icon: FileCheck2, label: '표시 확인', value: `${labelAttentionCount}개`, helper: '필수항목 빠짐·담당자 메모', tone: 'blue' },
      ]} />

      <section className="business-panel product-catalog-panel" aria-labelledby="product-catalog-title">
        <div className="business-panel-head catalog-head">
          <div>
            <h2 id="product-catalog-title">제품 카탈로그</h2>
            <p>제품을 선택하면 연결된 정보를 한 화면에서 확인할 수 있습니다.</p>
          </div>
          <label className="business-search">
            <Search size={19} aria-hidden="true" />
            <span className="sr-only">제품 검색</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="제품명 또는 품목코드 검색"
            />
          </label>
        </div>

        <div className="business-filter-row" role="group" aria-label="제품 분류">
          {categories.map((item) => (
            <button
              className={category === item ? 'active' : ''}
              type="button"
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
              key={item}
            >
              {item}
            </button>
          ))}
          <span className="filter-result-count">{filteredProducts.length}개 제품</span>
        </div>

        {filteredProducts.length > 0 ? (
          <div className="product-management-grid">
            {filteredProducts.map((product) => {
              const stockPercent = Math.min(100, Math.round((product.available / Math.max(product.safetyStock, 1)) * 100))
              return (
                <article
                  className="sea-product-card"
                  role="button"
                  tabIndex={0}
                  aria-label={`${product.shortName} 통합정보 열기`}
                  onClick={() => openProduct(product)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    openProduct(product)
                  }}
                  key={product.id}
                >
                  <ProductVisual product={product} />
                  <div className="sea-product-card-body">
                    <div className="product-card-flags">
                      <span className="product-category-tag">{product.category}</span>
                      <BusinessStatusBadge status={product.status} />
                    </div>
                    <div className="product-card-title">
                      <h3>{product.shortName}</h3>
                      <span>{product.code}</span>
                    </div>
                    <p>{product.specification}</p>
                    {canManage && <strong className="product-card-price">{formatMoney(product.price)}</strong>}
                    <div className="product-card-stock">
                      <div>
                        <span>가용재고</span>
                        <strong>{formatNumber(product.available)}개</strong>
                      </div>
                      <div className="stock-progress" aria-label={`안전재고 대비 ${stockPercent}%`}>
                        <span style={{ width: `${stockPercent}%` }} />
                      </div>
                      <small>안전재고 {formatNumber(product.safetyStock)}개</small>
                    </div>
                    <div className="product-card-footer">
                      <span><Tags size={15} aria-hidden="true" /> 표시 {summarizeLabel(product).label}</span>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        ) : products.length === 0 ? (
          <div className="business-empty-state">
            <Package size={32} aria-hidden="true" />
            <h3>{companyName}에 등록된 제품이 없습니다</h3>
            <p>첫 제품의 품목코드와 표시정보를 등록하면 재고와 표시 필수항목을 함께 관리할 수 있습니다.</p>
            {canManage && <Button tone="primary" type="button" onClick={() => openEditor()}><Plus size={17} /> 첫 제품 등록</Button>}
          </div>
        ) : (
          <div className="business-empty-state">
            <Search size={30} aria-hidden="true" />
            <h3>검색 결과가 없습니다</h3>
            <p>검색어나 제품 분류를 다시 확인해 주세요.</p>
            <Button tone="ghost" type="button" onClick={() => { setQuery(''); setCategory('전체') }}>
              검색 초기화
            </Button>
          </div>
        )}
      </section>

      {selectedProduct && (
        <ProductDetailDialog
          product={selectedProduct}
          channels={productSalesChannels}
          detail={selectedProduct.fact}
          validation={selectedProduct.validation}
          activeTab={detailTab}
          onTabChange={setDetailTab}
          onClose={() => setSelectedProductId(null)}
          onEdit={() => openEditor(selectedProduct.id)}
          onDelete={() => void deleteProduct(selectedProduct)}
          onValidate={() => void validateProduct(selectedProduct.id)}
          canViewCommercial={canManage}
        />
      )}
      {editor && (
        <ProductEditorDialog
          product={editingProduct}
          existingProducts={products}
          onClose={() => setEditor(null)}
          onSave={saveProduct}
          saveError={productSaveError}
        />
      )}
    </div>
  )
}

function ProductEditorDialog({
  product,
  existingProducts,
  onClose,
  onSave,
  saveError,
}: {
  product: ManagedProduct | null
  existingProducts: ManagedProduct[]
  onClose: () => void
  onSave: (product: ManagedProduct, isNew: boolean) => Promise<{ ok: boolean; message?: string }>
  saveError: string
}) {
  const dialogRef = useModalFocus(true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [imageDataUrl, setImageDataUrl] = useState(product?.imageDataUrl ?? '')
  const [imageFileName, setImageFileName] = useState(product?.imageFileName ?? '')
  const [imageError, setImageError] = useState('')
  const [imageBusy, setImageBusy] = useState(false)
  const fact = product?.fact ?? defaultProductFact

  useEffect(() => {
    document.body.classList.add('no-scroll')
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.classList.remove('no-scroll')
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose, saving])

  const selectImage = async (file?: File) => {
    if (!file) return
    setImageBusy(true)
    setImageError('')
    try {
      const prepared = await prepareProductImage(file)
      setImageDataUrl(prepared)
      setImageFileName(file.name.slice(0, 120))
    } catch (error) {
      setImageError(error instanceof Error ? error.message : '이미지를 준비하지 못했습니다.')
    } finally {
      setImageBusy(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    const number = (name: string) => Number(form.get(name))
    const name = text('name')
    const rawCode = text('code').toUpperCase()
    const code = rawCode || `PRD-${Date.now().toString().slice(-6)}`
    const stock = number('stock')
    const available = number('available')
    const safetyStock = number('safetyStock')
    const price = number('price')
    const barcode = text('barcode')
    const nextErrors: Record<string, string> = {}

    // 등록 장벽 최소화: 필수는 제품명 하나. 나머지는 형식이 틀린 경우에만 막고,
    // 표시 의무값 누락은 저장 후 ‘표시사항 검증’ 단계에서 잡는다.
    if (!name) nextErrors.name = '제품명을 입력해 주세요.'
    if (rawCode && existingProducts.some((item) => item.id !== product?.id && item.code.toUpperCase() === rawCode)) nextErrors.code = '이미 사용 중인 품목코드입니다.'
    if (!Number.isFinite(price) || price < 0) nextErrors.price = '판매가는 0원 이상이어야 합니다.'
    if (!Number.isInteger(stock) || stock < 0) nextErrors.stock = '실재고는 0 이상의 정수로 입력해 주세요.'
    if (!Number.isInteger(available) || available < 0) nextErrors.available = '가용재고는 0 이상의 정수로 입력해 주세요.'
    else if (available > stock) nextErrors.available = '가용재고는 실재고보다 많을 수 없습니다.'
    if (!Number.isInteger(safetyStock) || safetyStock < 0) nextErrors.safetyStock = '안전재고는 0 이상의 정수로 입력해 주세요.'
    if (barcode && !/^\d{13}$/.test(barcode)) nextErrors.barcode = '바코드는 숫자 13자리로 입력해 주세요.'

    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const isNew = !product
    const id = product?.id ?? `PRD-${Date.now().toString().slice(-8)}`
    const next: ManagedProduct = {
      ...(product ?? {
        id,
        channels: 0,
        visual: ((existingProducts.length % 4) + 1) as SeaProduct['visual'],
      }),
      id,
      code,
      name,
      shortName: text('shortName') || name.slice(0, 20),
      category: text('category') || '미분류',
      specification: text('specification'),
      price,
      stock,
      available,
      safetyStock,
      storage: text('storage'),
      status: text('status') as SeaProduct['status'],
      labelStatus: '수정필요',
      fact: {
        ...fact,
        manufacturer: text('manufacturer'),
        manufacturingType: text('manufacturingType'),
        foodType: text('foodType'),
        barcode,
        shelfLife: text('shelfLife'),
        origin: text('origin'),
        ingredients: text('ingredients'),
        labelOwner: text('labelOwner') || '품질관리 담당자 미지정',
        labelIssue: text('labelIssue'),
      },
      validation: undefined,
      imageDataUrl: imageDataUrl || undefined,
      imageFileName: imageDataUrl ? imageFileName : undefined,
    }
    // 저장값은 지금 칸이 채워졌는지에서 바로 만든다(홈 화면 점검 목록이 이 값을 읽는다). 사람의 승인이 아니다.
    next.labelStatus = storedLabelStatus(next)

    setSaving(true)
    const saved = await onSave(next, isNew)
    if (!saved.ok) setSaving(false)
  }

  const error = (name: string) => errors[name] ? <small className="field-error">{errors[name]}</small> : null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section ref={dialogRef} className="modal-card product-editor-modal" role="dialog" aria-modal="true" aria-labelledby="product-editor-title">
        <header>
          <div><span className="page-kicker">PRODUCT MASTER</span><h2 id="product-editor-title">{product ? '제품 정보 편집' : '신규 제품 등록'}</h2><p>제품명만 입력하면 바로 등록됩니다. 나머지 항목은 나중에 채우고 표시 검증으로 확인하세요.</p></div>
          <IconButton tone="ghost" type="button" aria-label="닫기" disabled={saving} onClick={onClose}><X size={21} /></IconButton>
        </header>
        <form noValidate onSubmit={submit}>
          {Object.keys(errors).length > 0 && <div className="form-error-summary" role="alert"><AlertTriangle size={18} /><span>입력값 {Object.keys(errors).length}곳을 확인해 주세요.</span></div>}
          {saveError && <div className="form-error-summary" role="alert"><AlertTriangle size={18} /><span>{saveError}</span></div>}
          <div className="product-editor-scroll">
            <section className="product-editor-section product-image-editor" aria-labelledby="product-image-fields">
              <div><h3 id="product-image-fields">제품 이미지</h3><p>목록과 통합 상세에 표시됩니다. 서버 공유 데이터에 저장할 수 있도록 자동으로 축소합니다.</p></div>
              <div className="product-image-control">
                <div className={`product-image-preview${imageDataUrl ? ' has-image' : ''}`}>
                  {imageDataUrl ? <img src={imageDataUrl} alt="선택한 제품 이미지 미리보기" /> : <><ImagePlus size={28} /><span>등록된 이미지 없음</span></>}
                </div>
                <div className="product-image-actions">
                  <label className={buttonClassName({ tone: 'ghost', className: `file-picker-button${imageBusy ? ' disabled' : ''}` })}>
                    <ImagePlus size={17} aria-hidden="true" /> {imageBusy ? '이미지 처리 중…' : imageDataUrl ? '이미지 변경' : '이미지 선택'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={imageBusy || saving}
                      onClick={(event) => { event.currentTarget.value = '' }}
                      onChange={(event) => void selectImage(event.target.files?.[0])}
                    />
                  </label>
                  {imageDataUrl && <Button tone="danger" size="sm" type="button" disabled={imageBusy || saving} onClick={() => { setImageDataUrl(''); setImageFileName(''); setImageError('') }}><Trash2 size={16} /> 이미지 삭제</Button>}
                  <small>{imageFileName || 'JPG·PNG·WEBP, 원본 5MB 이하'}</small>
                </div>
                {imageError && <div className="field-error product-image-error" role="alert">{imageError}</div>}
              </div>
            </section>
            <section className="product-editor-section" aria-labelledby="product-basic-fields">
              <div><h3 id="product-basic-fields">기본정보</h3><p>제품을 식별하고 판매·재고에 공통으로 쓰는 값입니다.</p></div>
              <div className="product-editor-grid">
                <label className="form-field full"><span>제품명 <em className="field-required">필수</em></span><input name="name" autoFocus data-autofocus defaultValue={product?.name ?? ''} aria-invalid={Boolean(errors.name)} placeholder="판매·표시에 사용할 정식 제품명" />{error('name')}</label>
                <label className="form-field"><span>품목코드 <small>비우면 자동 생성</small></span><input name="code" defaultValue={product?.code ?? ''} aria-invalid={Boolean(errors.code)} placeholder="예: FG-NEW-001" />{error('code')}</label>
                <label className="form-field"><span>제품 분류</span><input name="category" defaultValue={product?.category ?? ''} placeholder="예: 조미식품" /></label>
                <label className="form-field"><span>목록 표시명 <small>비우면 제품명 사용</small></span><input name="shortName" defaultValue={product?.shortName ?? ''} placeholder="짧은 제품명" /></label>
                <label className="form-field"><span>규격</span><input name="specification" defaultValue={product?.specification ?? ''} placeholder="예: 300g × 12병 / BOX" /></label>
                <label className="form-field"><span>판매가</span><input name="price" type="number" min="0" defaultValue={product?.price ?? 0} aria-invalid={Boolean(errors.price)} />{error('price')}</label>
                <label className="form-field"><span>운영상태</span><select name="status" defaultValue={product?.status ?? '정상'}><option>정상</option><option>주의</option><option>품절</option></select></label>
                <label className="form-field full"><span>보관방법</span><input name="storage" defaultValue={product?.storage ?? ''} placeholder="예: 냉장 0~10℃" /></label>
              </div>
            </section>
            <section className="product-editor-section" aria-labelledby="product-label-fields">
              <div><h3 id="product-label-fields">표시 · 제조정보 <small>선택</small></h3><p>지금 비워 두어도 등록되며, 판매 전 표시사항 검증에서 누락 항목을 알려드립니다.</p></div>
              <div className="product-editor-grid">
                <label className="form-field"><span>제조원</span><input name="manufacturer" defaultValue={fact.manufacturer} /></label>
                <label className="form-field"><span>제조형태</span><select name="manufacturingType" defaultValue={fact.manufacturingType}><option>자체생산</option><option>OEM</option><option>ODM</option></select></label>
                <label className="form-field"><span>식품유형</span><input name="foodType" defaultValue={fact.foodType} /></label>
                <label className="form-field"><span>바코드 13자리</span><input name="barcode" inputMode="numeric" maxLength={13} defaultValue={fact.barcode} aria-invalid={Boolean(errors.barcode)} />{error('barcode')}</label>
                <label className="form-field full"><span>소비기한 표시</span><input name="shelfLife" defaultValue={fact.shelfLife} placeholder="예: 제조일로부터 12개월" /></label>
                <label className="form-field full"><span>원산지 표시</span><textarea name="origin" rows={2} defaultValue={fact.origin} /></label>
                <label className="form-field full"><span>원재료명·함량</span><textarea name="ingredients" rows={3} defaultValue={fact.ingredients} /></label>
                <label className="form-field"><span>표시 검토 담당</span><input name="labelOwner" defaultValue={fact.labelOwner} /></label>
                <label className="form-field"><span>표시 검토 메모</span><input name="labelIssue" defaultValue={openLabelMemoFor(fact)} placeholder="고칠 것이 있을 때만 적어 주세요" /></label>
              </div>
            </section>
            <section className="product-editor-section compact" aria-labelledby="product-stock-fields">
              <div><h3 id="product-stock-fields">초기 재고</h3><p>가용재고는 실재고를 넘을 수 없습니다.</p></div>
              <div className="product-editor-grid three">
                <label className="form-field"><span>실재고</span><input name="stock" type="number" min="0" step="1" defaultValue={product?.stock ?? 0} aria-invalid={Boolean(errors.stock)} />{error('stock')}</label>
                <label className="form-field"><span>가용재고</span><input name="available" type="number" min="0" step="1" defaultValue={product?.available ?? 0} aria-invalid={Boolean(errors.available)} />{error('available')}</label>
                <label className="form-field"><span>안전재고</span><input name="safetyStock" type="number" min="0" step="1" defaultValue={product?.safetyStock ?? 0} aria-invalid={Boolean(errors.safetyStock)} />{error('safetyStock')}</label>
              </div>
            </section>
          </div>
          <footer><span>저장하면 표시 필수항목 7개가 채워졌는지 바로 다시 셉니다.</span><div><Button tone="ghost" type="button" disabled={saving || imageBusy} onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={saving || imageBusy}>{saving ? '저장 중…' : product ? '변경사항 저장' : '제품 등록'}</Button></div></footer>
        </form>
      </section>
    </div>
  )
}

function ProductDetailDialog({
  product,
  channels,
  detail,
  validation,
  activeTab,
  onTabChange,
  onClose,
  onEdit,
  onDelete,
  onValidate,
  canViewCommercial,
}: {
  product: ManagedProduct
  channels: ManagedChannel[]
  detail: ProductFact
  validation?: ProductValidation
  activeTab: ProductDetailTab
  onTabChange: (tab: ProductDetailTab) => void
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onValidate: () => void
  canViewCommercial: boolean
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const [showValidationHistory, setShowValidationHistory] = useState(false)
  const [showLotHistory, setShowLotHistory] = useState(false)
  const productChannels = channels
  const labelSummary = summarizeLabel(product)
  const labelChecks = checkLabelFields(product)
  // 이 제품에 LOT를 적어 넣는 곳은 아직 없다. 기본 자리표시('LOT 미등록'·'-'·D-0·검사 '대기')를 기록처럼 보여 주지 않는다.
  const hasLotRecord = Boolean(detail.lotNo?.trim()) && detail.lotNo !== defaultProductFact.lotNo
  const lotDaysLeft = hasLotRecord ? daysUntil(detail.expiresAt) : null

  onCloseRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const layer = dialogRef.current?.parentElement
    const page = layer?.parentElement
    const backgroundElements = [
      ...(page ? Array.from(page.children).filter((element) => element !== layer) : []),
      document.querySelector('.sidebar'),
      document.querySelector('.topbar'),
    ].filter((element): element is HTMLElement => element instanceof HTMLElement)
    const previousInert = backgroundElements.map((element) => ({ element, inert: element.inert }))
    document.body.style.overflow = 'hidden'
    backgroundElements.forEach((element) => { element.inert = true })
    closeButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
      if (focusables.length === 0) return
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
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previousInert.forEach(({ element, inert }) => { element.inert = inert })
      previouslyFocused?.focus()
    }
  }, [])

  const tabs: Array<{ id: ProductDetailTab; label: string; icon: typeof Package }> = [
    { id: 'basic', label: '기본정보', icon: Package },
    { id: 'label', label: '표시사항', icon: FileCheck2 },
    ...(canViewCommercial ? [{ id: 'channels' as const, label: '판매채널', icon: Store }] : []),
    { id: 'inventory', label: '재고 LOT', icon: Warehouse },
  ]

  return (
    <div className="product-detail-layer">
      <button className="scrim product-detail-scrim" type="button" aria-label="제품 상세 닫기" onClick={onClose} />
      <section
        ref={dialogRef}
        className="modal product-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-detail-title"
      >
        <header className="product-detail-head">
          <ProductVisual product={product} compact />
          <div className="product-detail-heading-copy">
            <div className="product-detail-badges">
              <span className="product-category-tag">{product.category}</span>
              <BusinessStatusBadge status={product.status} />
              <LabelStatusBadge product={product} prefix="표시 " />
            </div>
            <h2 id="product-detail-title">{product.name}</h2>
            <p>{product.code} · {product.specification}</p>
          </div>
          <IconButton tone="ghost" ref={closeButtonRef} type="button" aria-label="닫기" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </IconButton>
        </header>

        <div className="product-detail-tabs" role="tablist" aria-label="제품 상세 정보">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                id={`product-tab-${tab.id}`}
                className={activeTab === tab.id ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`product-panel-${tab.id}`}
                onClick={() => onTabChange(tab.id)}
                key={tab.id}
              >
                <Icon size={17} aria-hidden="true" /> {tab.label}
              </button>
            )
          })}
        </div>

        <div className="product-detail-body">
          {activeTab === 'basic' && (
            <div id="product-panel-basic" role="tabpanel" aria-labelledby="product-tab-basic">
              <div className="product-detail-lead">
                {canViewCommercial && <div>
                  <span>소비자가</span>
                  <strong>{formatMoney(product.price)}</strong>
                </div>}
                <div>
                  <span>보관방법</span>
                  <strong>{product.storage}</strong>
                </div>
                <div>
                  <span>제조형태</span>
                  <strong>{detail.manufacturingType}</strong>
                </div>
              </div>
              <dl className="product-fact-grid">
                <div><dt>품목코드</dt><dd>{product.code}</dd></div>
                <div><dt>식품유형</dt><dd>{detail.foodType}</dd></div>
                <div><dt>제조원</dt><dd>{detail.manufacturer}</dd></div>
                <div><dt>바코드</dt><dd>{detail.barcode}</dd></div>
                <div><dt>소비기한</dt><dd>{detail.shelfLife}</dd></div>
                <div><dt>원산지</dt><dd>{detail.origin}</dd></div>
                <div className="wide"><dt>주요 원재료</dt><dd>{detail.ingredients}</dd></div>
              </dl>
            </div>
          )}

          {activeTab === 'label' && (
            <div id="product-panel-label" role="tabpanel" aria-labelledby="product-tab-label" className="label-detail-panel">
              <div className={`label-score-card ${labelSummary.complete ? 'approved' : ''}`}>
                <div className="label-score-ring" role="img" style={{ '--score': Math.round((labelSummary.filled / labelSummary.total) * 100) } as React.CSSProperties} aria-label={`표시 필수항목 ${labelSummary.total}개 중 ${labelSummary.filled}개 입력`}>
                  <strong>{labelSummary.filled}/{labelSummary.total}</strong>
                  <span>필수항목</span>
                </div>
                <div>
                  <div className="label-score-title"><LabelStatusBadge product={product} /><span>담당 {detail.labelOwner}</span></div>
                  <h3>{labelSummary.headline}</h3>
                  <p>{labelSummary.memo
                    ? `담당자 메모: ${labelSummary.memo}`
                    : '이 점검은 칸이 채워졌는지만 봅니다. 문구가 법 기준에 맞는지, 알레르기 유발물질 표시는 담당자가 직접 확인해 주세요.'}</p>
                </div>
              </div>
              <div className="label-check-grid">
                {labelChecks.map((item) => (
                  <div className={item.ok ? 'label-check-item' : 'label-check-item warning'} key={item.id}>
                    {item.ok ? <CheckCircle2 size={19} aria-hidden="true" /> : <AlertTriangle size={19} aria-hidden="true" />}
                    <div><strong>{item.label}</strong><span>{item.note}</span></div>
                  </div>
                ))}
              </div>
              {showValidationHistory && <div className="label-validation-history" role="status">
                <div><strong>마지막 필수항목 확인</strong><span>{validation?.checkedAt ? formatDateTime(validation.checkedAt) : '아직 기록 없음'}</span></div>
                {validation?.issues.length
                  ? <ul>{validation.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
                  : <p>{validation ? '그때 빠진 필수항목이 없었습니다.' : '‘필수항목 다시 확인’을 누르면 시각과 결과가 이곳에 남습니다.'}</p>}
              </div>}
              <Button tone="ghost" type="button" aria-expanded={showValidationHistory} onClick={() => setShowValidationHistory((current) => !current)}>
                <FileCheck2 size={16} aria-hidden="true" /> {showValidationHistory ? '확인 기록 닫기' : '확인 기록 보기'}
              </Button>
            </div>
          )}

          {canViewCommercial && activeTab === 'channels' && (
            <div id="product-panel-channels" role="tabpanel" aria-labelledby="product-tab-channels" className="product-channel-detail-list">
              <p className="channel-demo-note">회사 판매채널 목록입니다. 판매자센터와 직접 연결하지 않아, 채널별 상품 등록 여부와 주문은 여기서 가져오지 않습니다.</p>
              {productChannels.length === 0 && <div className="business-empty-state"><Store size={28} /><h3>등록된 판매채널이 없습니다</h3><p>판매채널 화면에서 쓰는 채널을 목록에 추가해 주세요.</p></div>}
              {productChannels.map((channel) => (
                  <article className="product-channel-detail" key={channel.id}>
                    <span className="channel-mark" style={{ backgroundColor: channelTokenColor(channel.id) }}>{channel.short}</span>
                    <div className="product-channel-name">
                      <strong>{channel.name}</strong>
                      <span>{CHANNEL_NOT_CONNECTED}</span>
                    </div>
                    {channelDefinition(channel.id) && <a className="product-channel-external" href={channelDefinition(channel.id)!.sellerUrl} target="_blank" rel="noreferrer" aria-label={`${channel.name} 판매자센터 열기`}><ExternalLink size={18} aria-hidden="true" /></a>}
                  </article>
              ))}
            </div>
          )}

          {activeTab === 'inventory' && (
            <div id="product-panel-inventory" role="tabpanel" aria-labelledby="product-tab-inventory" className="inventory-detail-panel">
              <div className="inventory-summary-cards">
                <div><span>실재고</span><strong>{formatNumber(product.stock)}개</strong></div>
                <div className={isBelowSafetyStock(product) ? 'warning' : ''}><span>가용재고</span><strong>{formatNumber(product.available)}개</strong></div>
                <div><span>안전재고</span><strong>{formatNumber(product.safetyStock)}개</strong></div>
              </div>
              {isBelowSafetyStock(product) && (
                <div className="inventory-warning-banner">
                  <AlertTriangle size={20} aria-hidden="true" />
                  <div>
                    <strong>{product.available === 0 ? '현재 판매 가능한 재고가 없습니다.' : '안전재고 이하로 내려갔습니다.'}</strong>
                    <span>생산 또는 발주를 검토해 주세요.</span>
                  </div>
                </div>
              )}
              {hasLotRecord ? <>
                <div className="lot-detail-card">
                  <div className="lot-detail-head">
                    <div><span>대표 LOT</span><h3>{detail.lotNo}</h3></div>
                  </div>
                  <dl className="product-fact-grid">
                    <div><dt>창고</dt><dd>{detail.warehouse}</dd></div>
                    <div><dt>로케이션</dt><dd>{detail.location}</dd></div>
                    <div><dt>제조일</dt><dd>{detail.manufacturedAt}</dd></div>
                    <div><dt>소비기한</dt><dd>{detail.expiresAt}</dd></div>
                    <div><dt>남은 날</dt><dd>{lotDaysLeft === null ? '날짜 없음' : lotDaysLeft < 0 ? `${Math.abs(lotDaysLeft)}일 지남` : `D-${lotDaysLeft}`}</dd></div>
                  </dl>
                </div>
                {showLotHistory && <div className="lot-history-list"><div><strong>{detail.lotNo}</strong><span>{detail.manufacturedAt} 제조 · {detail.warehouse} {detail.location}</span></div><p>현재 제품에 연결된 추가 LOT는 없습니다.</p></div>}
                <Button tone="ghost" type="button" aria-expanded={showLotHistory} onClick={() => setShowLotHistory((current) => !current)}>
                  <Warehouse size={16} aria-hidden="true" /> {showLotHistory ? 'LOT 이력 닫기' : '전체 LOT 이력'}
                </Button>
              </> : <div className="business-empty-state compact">
                <Warehouse size={28} aria-hidden="true" />
                <h3>연결된 LOT 기록이 아직 없습니다</h3>
                <p>입출고와 LOT는 재고·LOT 화면에서 기록합니다. 이 제품의 LOT·소비기한은 아직 여기로 이어지지 않습니다.</p>
              </div>}
            </div>
          )}
        </div>

        <footer className="product-detail-actions">
          <span>필수항목 확인 · {validation?.checkedAt ? formatDateTime(validation.checkedAt) : '기록 없음'}</span>
          {canViewCommercial ? <div>
            <Button tone="danger" size="sm" type="button" onClick={onDelete}>
              <Trash2 size={16} aria-hidden="true" /> 제품 삭제
            </Button>
            <Button tone="ghost" type="button" onClick={onValidate}>
              <RefreshCw size={16} aria-hidden="true" /> 필수항목 다시 확인
            </Button>
            <Button tone="primary" type="button" onClick={onEdit}>
              제품 정보 편집 <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div> : <strong>조회 전용 · 변경은 관리자에게 요청하세요.</strong>}
        </footer>
      </section>
    </div>
  )
}

function ShipmentEditorDialog({ shipment, channels, busy, onClose, onSave }: {
  shipment: SalesShipment | null
  channels: ManagedChannel[]
  busy: boolean
  onClose: () => void
  onSave: (shipment: SalesShipment) => Promise<boolean>
}) {
  const dialogRef = useModalFocus(true)
  const [error, setError] = useState('')

  useEffect(() => {
    document.body.classList.add('no-scroll')
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.classList.remove('no-scroll')
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [busy, onClose])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    const channelId = text('channelId')
    const definition = channelDefinition(channelId)
    const managed = channels.find((channel) => channel.id === channelId)
    const quantity = Number(text('quantity'))
    const courier = text('courier')
    const trackingNo = text('trackingNo').replaceAll(' ', '')
    if (!text('orderNo') || !channelId || !text('recipient') || !text('address') || !text('productName')) {
      setError('주문번호, 판매채널, 수취인, 주소와 상품명을 모두 입력해 주세요.')
      return
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      setError('상품 수량은 1개 이상의 정수로 입력해 주세요.')
      return
    }
    if ((courier && !trackingNo) || (!courier && trackingNo)) {
      setError('택배사와 송장번호는 함께 입력해 주세요.')
      return
    }
    if (trackingNo && !/^[A-Za-z0-9-]{8,30}$/.test(trackingNo)) {
      setError('송장번호는 공백 없이 영문·숫자·하이픈 8~30자로 입력해 주세요.')
      return
    }
    const now = new Date().toISOString()
    await onSave({
      id: shipment?.id ?? `SHIP-${Date.now()}`,
      orderNo: text('orderNo'),
      channelId,
      channelName: managed?.name ?? definition?.name ?? '기타 채널',
      recipient: text('recipient'),
      phone: text('phone'),
      address: text('address'),
      productName: text('productName'),
      quantity,
      courier,
      trackingNo,
      status: shipment?.status === '출고완료' ? '출고완료' : trackingNo ? '송장등록' : '출고대기',
      orderedAt: shipment?.orderedAt ?? now,
      shippedAt: shipment?.shippedAt,
    })
  }

  const defaultChannelId = shipment?.channelId ?? channels[0]?.id ?? channelDefinitions[0].id

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <section ref={dialogRef} className="modal-card shipment-editor-modal" role="dialog" aria-modal="true" aria-labelledby="shipment-editor-title">
      <header><div><span className="page-kicker">FULFILLMENT</span><h2 id="shipment-editor-title">{shipment ? '배송·송장 수정' : '배송 주문 등록'}</h2><p>출고에 필요한 수취 정보와 송장번호를 관리합니다.</p></div><IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={20} /></IconButton></header>
      <form onSubmit={submit}>
        <div className="shipment-editor-grid">
          <label className="form-field"><span>주문번호 *</span><input name="orderNo" defaultValue={shipment?.orderNo ?? ''} placeholder="채널 주문번호" /></label>
          <label className="form-field"><span>판매채널 *</span><select name="channelId" defaultValue={defaultChannelId}>{channelDefinitions.map((definition) => <option value={definition.id} key={definition.id}>{definition.name}</option>)}</select></label>
          <label className="form-field"><span>수취인 *</span><input name="recipient" defaultValue={shipment?.recipient ?? ''} /></label>
          <label className="form-field"><span>연락처</span><input name="phone" defaultValue={shipment?.phone ?? ''} placeholder="010-0000-0000" /></label>
          <label className="form-field full"><span>배송지 *</span><input name="address" defaultValue={shipment?.address ?? ''} /></label>
          <label className="form-field"><span>상품명 *</span><input name="productName" defaultValue={shipment?.productName ?? ''} /></label>
          <label className="form-field"><span>수량 *</span><input name="quantity" type="number" min="1" step="1" defaultValue={shipment?.quantity ?? 1} /></label>
          <label className="form-field"><span>택배사</span><select name="courier" defaultValue={shipment?.courier ?? ''}><option value="">송장 등록 전</option>{couriers.map((courier) => <option key={courier}>{courier}</option>)}</select></label>
          <label className="form-field"><span>송장번호</span><input name="trackingNo" defaultValue={shipment?.trackingNo ?? ''} inputMode="numeric" placeholder="공백 없이 입력" /></label>
        </div>
        {error && <div className="channel-credential-error" role="alert"><AlertTriangle size={17} /> {error}</div>}
        <div className="shipment-editor-help"><Truck size={18} /><span>송장번호를 입력하면 ‘송장등록’ 상태가 되고 인쇄 버튼이 활성화됩니다.</span></div>
        <footer><Button tone="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={busy}>{busy ? '저장 중…' : '배송정보 저장'}</Button></footer>
      </form>
    </section>
  </div>
}

export function SalesChannels({ onToast, workspaceScope, companyName = '고객사', canManage = true }: TenantBusinessPageProps & { canManage?: boolean }) {
  const [period, setPeriod] = useState<SalesPeriod>('week')
  const [storedChannels, setChannels] = useWorkspaceState<ManagedChannel[]>(
    'sales-channels',
    [],
    { scope: workspaceScope, enabled: canManage, seedWhenEmpty: false, validate: isManagedChannelList },
  )
  const [shipments, setShipments] = useWorkspaceState<SalesShipment[]>(
    'sales-shipments',
    [],
    { scope: workspaceScope, enabled: canManage, seedWhenEmpty: false, validate: isSalesShipmentList },
  )
  const normalizedChannels = useMemo(() => storedChannels.map(normalizeManagedChannel), [storedChannels])
  const channels = normalizedChannels
  const [channelDialog, setChannelDialog] = useState<'catalog' | string | null>(null)
  const [savingChannel, setSavingChannel] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [shipmentDialog, setShipmentDialog] = useState<'new' | string | null>(null)
  const [shipmentFilter, setShipmentFilter] = useState<'all' | ShipmentStatus>('all')
  const [shipmentBusy, setShipmentBusy] = useState(false)
  const [confirmShipmentDeleteId, setConfirmShipmentDeleteId] = useState<string | null>(null)
  const shipmentFileRef = useRef<HTMLInputElement>(null)
  const channelDialogRef = useModalFocus(Boolean(channelDialog))

  useEffect(() => {
    if (!channelDialog) return
    document.body.classList.add('no-scroll')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingChannel) setChannelDialog(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('no-scroll')
    }
  }, [channelDialog, savingChannel])

  // 기간별 숫자는 출고 주문에서 센다(고정 배수 없음). 매출은 결제 금액을 받는 길이 없어 만들지 않는다.
  const periodConfig = SALES_PERIODS.find((item) => item.id === period) ?? SALES_PERIODS[1]
  const periodSummary = useMemo(() => summarizeShipments(shipments, period), [period, shipments])
  const hasShipments = shipments.length > 0
  const pendingShipmentCount = shipments.filter((shipment) => shipment.status !== '출고완료').length

  const openChannelSetup = (channelId: string) => {
    if (!channelDefinition(channelId)) return
    setConfirmDisconnect(false)
    setChannelDialog(channelId)
  }

  const commitChannelChange = async (action: (current: ManagedChannel[]) => ManagedChannel[]) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await setChannels((current) => action(current).map(withoutCredentialTraces))
      if (result.ok || !result.message?.includes('불러오는 중')) return result
      await new Promise((resolve) => window.setTimeout(resolve, 150))
    }
    return { ok: false, persisted: false, message: '판매채널 공유 데이터 준비가 지연되고 있습니다. 잠시 후 다시 시도해 주세요.' }
  }

  const addChannelToList = async (definition: ChannelDefinition) => {
    if (channels.some((channel) => channel.id === definition.id)) return true
    setSavingChannel(true)
    const result = await commitChannelChange((current) => current.some((channel) => channel.id === definition.id)
      ? current
      : [...current, emptyManagedChannel(definition)])
    setSavingChannel(false)
    if (!result.ok) {
      onToast(result.message ?? `${definition.name} 채널을 추가하지 못했습니다.`)
      return false
    }
    setChannelDialog(null)
    onToast(`${definition.name}을 판매채널 목록에 추가했습니다. 주문은 판매자센터에서 내려받아 ‘주문 CSV 가져오기’로 올려 주세요.`)
    return true
  }

  const disconnectChannel = async (channel: ManagedChannel) => {
    setSavingChannel(true)
    const result = await commitChannelChange((current) => current.filter((item) => item.id !== channel.id))
    setSavingChannel(false)
    if (!result.ok) {
      onToast(result.message ?? `${channel.name}을 목록에서 빼지 못했습니다.`)
      return
    }
    setChannelDialog('catalog')
    setConfirmDisconnect(false)
    onToast(`${channel.name}을 판매채널 목록에서 뺐습니다. 이미 등록한 출고 주문은 그대로 남습니다.`)
  }

  const commitShipmentChange = async (action: (current: SalesShipment[]) => SalesShipment[]) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await setShipments(action)
      if (result.ok || !result.message?.includes('불러오는 중')) return result
      await new Promise((resolve) => window.setTimeout(resolve, 150))
    }
    return { ok: false, persisted: false, message: '배송 공유 데이터 준비가 지연되고 있습니다. 잠시 후 다시 시도해 주세요.' }
  }

  const saveShipment = async (shipment: SalesShipment) => {
    setShipmentBusy(true)
    const result = await commitShipmentChange((current) => current.some((item) => item.id === shipment.id)
      ? current.map((item) => item.id === shipment.id ? shipment : item)
      : [shipment, ...current])
    setShipmentBusy(false)
    if (!result.ok) {
      onToast(result.message ?? '배송 정보를 저장하지 못했습니다.')
      return false
    }
    setShipmentDialog(null)
    onToast(shipment.trackingNo ? `${shipment.orderNo} 송장정보를 저장했습니다.` : `${shipment.orderNo} 출고대기 주문을 등록했습니다.`)
    return true
  }

  const completeShipment = async (shipment: SalesShipment) => {
    if (!shipment.trackingNo) {
      setShipmentDialog(shipment.id)
      onToast('출고 완료 전에 택배사와 송장번호를 등록해 주세요.')
      return
    }
    const result = await commitShipmentChange((current) => current.map((item) => item.id === shipment.id
      ? { ...item, status: '출고완료', shippedAt: new Date().toISOString() }
      : item))
    onToast(result.ok ? `${shipment.orderNo} 주문을 출고완료로 변경했습니다.` : result.message ?? '출고 상태를 저장하지 못했습니다.')
  }

  const deleteShipment = async (shipment: SalesShipment) => {
    const result = await commitShipmentChange((current) => current.filter((item) => item.id !== shipment.id))
    setConfirmShipmentDeleteId(null)
    onToast(result.ok ? `${shipment.orderNo} 배송 행을 삭제했습니다.` : result.message ?? '배송 행을 삭제하지 못했습니다.')
  }

  const printShippingLabel = (shipment: SalesShipment) => {
    if (!shipment.trackingNo || !shipment.courier) {
      setShipmentDialog(shipment.id)
      onToast('택배사와 송장번호를 먼저 등록해 주세요.')
      return
    }
    const printWindow = window.open('', '_blank', 'width=720,height=820')
    if (!printWindow) {
      onToast('인쇄 창이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.')
      return
    }
    printWindow.document.title = `${shipment.orderNo} 송장`
    const style = printWindow.document.createElement('style')
    const appStyles = getComputedStyle(document.documentElement)
    const printInk = appStyles.getPropertyValue('--color-ink').trim() || 'currentColor'
    const printMuted = appStyles.getPropertyValue('--color-gray-600').trim() || 'currentColor'
    const printLine = appStyles.getPropertyValue('--color-gray-200').trim() || 'currentColor'
    const printFont22 = appStyles.getPropertyValue('--font-22').trim()
    const printFont15 = appStyles.getPropertyValue('--font-15').trim()
    const printFont13 = appStyles.getPropertyValue('--font-13').trim()
    const printFont11 = appStyles.getPropertyValue('--font-11').trim()
    const printWeight = appStyles.getPropertyValue('--weight-medium').trim()
    const printHairline = appStyles.getPropertyValue('--hairline').trim()
    style.textContent = `:root{--print-ink:${printInk};--print-muted:${printMuted};--print-line:${printLine};--print-font-22:${printFont22};--print-font-15:${printFont15};--print-font-13:${printFont13};--print-font-11:${printFont11};--print-weight:${printWeight};--print-hairline:${printHairline}}body{font-family:Arial,sans-serif;margin:0;padding:32px;color:var(--print-ink)}.label{width:560px;border:var(--print-hairline) solid var(--print-ink);padding:24px}.head{display:flex;justify-content:space-between;border-bottom:var(--print-hairline) solid var(--print-ink);padding-bottom:16px}.head strong{font-size:var(--print-font-22)}.tracking{font-size:var(--print-font-22);font-weight:var(--print-weight);letter-spacing:0;margin:24px 0}.row{display:grid;grid-template-columns:100px 1fr;gap:12px;padding:12px 0;border-top:var(--print-hairline) solid var(--print-line)}.row b{font-size:var(--print-font-13)}.row span{font-size:var(--print-font-15);line-height:1.45}.foot{margin-top:24px;font-size:var(--print-font-11);color:var(--print-muted)}@media print{body{padding:0}.label{width:auto;border:var(--print-hairline) solid var(--print-ink)}}`
    const label = printWindow.document.createElement('main')
    label.className = 'label'
    const rows: Array<[string, string]> = [
      ['받는 분', `${shipment.recipient} · ${shipment.phone}`],
      ['주소', shipment.address],
      ['상품', `${shipment.productName} · ${shipment.quantity}개`],
      ['주문번호', shipment.orderNo],
      ['판매채널', shipment.channelName],
    ]
    const head = printWindow.document.createElement('div')
    head.className = 'head'
    const courier = printWindow.document.createElement('strong')
    courier.textContent = shipment.courier
    const brand = printWindow.document.createElement('span')
    brand.textContent = companyName
    head.append(courier, brand)
    const tracking = printWindow.document.createElement('div')
    tracking.className = 'tracking'
    tracking.textContent = shipment.trackingNo
    label.append(head, tracking)
    for (const [key, value] of rows) {
      const row = printWindow.document.createElement('div')
      row.className = 'row'
      const keyElement = printWindow.document.createElement('b')
      keyElement.textContent = key
      const valueElement = printWindow.document.createElement('span')
      valueElement.textContent = value
      row.append(keyElement, valueElement)
      label.append(row)
    }
    const foot = printWindow.document.createElement('p')
    foot.className = 'foot'
    foot.textContent = '로컬 ERP에서 생성한 인쇄용 송장입니다. 실제 택배사 규격 라벨과 바코드는 택배사 API 계약 후 자동 생성됩니다.'
    label.append(foot)
    printWindow.document.head.append(style)
    printWindow.document.body.append(label)
    printWindow.focus()
    window.setTimeout(() => printWindow.print(), 250)
  }

  const downloadShipmentTemplate = () => {
    const content = '\uFEFF주문번호,채널ID,채널명,수취인,연락처,주소,상품명,수량\r\nORDER-001,naver,네이버 스마트스토어,홍길동,010-0000-0000,배송지 주소,상품명,1'
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = '배송주문-가져오기-양식.csv'
    link.click()
    URL.revokeObjectURL(url)
    onToast('배송주문 CSV 양식을 내려받았습니다.')
  }

  const importShipmentCsv = async (file?: File) => {
    if (!file) return
    if (shipmentFileRef.current) shipmentFileRef.current.value = ''
    if (file.size > 512 * 1024) {
      onToast('CSV 파일은 512KB 이하만 가져올 수 있습니다.')
      return
    }
    const text = await file.text()
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
    const rows = lines.slice(1).map(parseCsvRow)
    const imported = rows.flatMap((row, index): SalesShipment[] => {
      const [orderNo, channelId, channelName, recipient, phone, address, productName, rawQuantity] = row
      const quantity = Number(rawQuantity)
      if (!orderNo || !channelId || !channelName || !recipient || !address || !productName || !Number.isInteger(quantity) || quantity < 1) return []
      return [{ id: `SHIP-${Date.now()}-${index}`, orderNo, channelId, channelName, recipient, phone, address, productName, quantity, courier: '', trackingNo: '', status: '출고대기', orderedAt: new Date().toISOString() }]
    })
    if (imported.length === 0) {
      onToast('가져올 수 있는 배송 주문이 없습니다. CSV 양식과 필수값을 확인해 주세요.')
      return
    }
    let addedCount = 0
    const result = await commitShipmentChange((current) => {
      const known = new Set(current.map((item) => item.orderNo))
      const unique = imported.filter((item) => !known.has(item.orderNo))
      addedCount = unique.length
      return [...unique, ...current]
    })
    onToast(result.ok ? `${addedCount}건의 배송 주문을 가져왔습니다.${addedCount < imported.length ? ` 중복 ${imported.length - addedCount}건은 제외했습니다.` : ''}` : result.message ?? 'CSV 배송 주문을 저장하지 못했습니다.')
  }

  const selectedDefinition = channelDialog && channelDialog !== 'catalog' ? channelDefinition(channelDialog) : undefined
  const selectedChannel = selectedDefinition ? channels.find((channel) => channel.id === selectedDefinition.id) : undefined

  const visibleShipments = shipments.filter((shipment) => shipmentFilter === 'all' || shipment.status === shipmentFilter)

  return (
    <div className="page-enter business-page sales-channels-page">
      <header className="page-heading business-page-head">
        <div>
          <div className="page-kicker">Commerce hub</div>
          <h1>판매채널</h1>
          <p>{companyName}의 판매채널 목록과 출고 주문을 관리합니다. 주문 수와 판매수량은 이 화면에 등록하거나 CSV로 올린 출고 주문에서 셉니다.</p>
        </div>
        {canManage && <div className="heading-actions">
          <div className="sales-period-switch" role="group" aria-label="주문 집계 기간">
            {SALES_PERIODS.map((item) => (
              <button
                className={period === item.id ? 'active' : ''}
                type="button"
                aria-pressed={period === item.id}
                onClick={() => setPeriod(item.id)}
                key={item.id}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button tone="ghost" type="button" onClick={() => setChannelDialog('catalog')}><Plus size={17} aria-hidden="true" /> 채널 추가</Button>
        </div>}
      </header>

      {canManage && <BusinessSummaryStrip label={`${periodConfig.label} 출고 주문 요약`} items={[
        { icon: ShoppingBag, label: '주문', value: hasShipments ? `${formatNumber(periodSummary.orders)}건` : '아직 데이터 없음', helper: hasShipments ? '등록한 출고 주문' : '등록하면 셉니다' },
        { icon: Package, label: '판매수량', value: hasShipments ? `${formatNumber(periodSummary.units)}개` : '아직 데이터 없음', helper: '주문 수량 합계', tone: 'blue' },
        { icon: Truck, label: '출고 대기', value: `${formatNumber(pendingShipmentCount)}건`, helper: '출고 완료 전', tone: pendingShipmentCount > 0 ? 'warning' : undefined },
        { icon: CircleDollarSign, label: '매출', value: '아직 데이터 없음', helper: '채널 연결 전', tone: 'green' },
      ]} />}

      <section className="sales-channel-section" aria-labelledby="channel-status-title">
        <div className="business-section-heading">
          <div><h2 id="channel-status-title">채널별 출고 주문</h2><p>{periodConfig.label} · 등록한 출고 주문 기준. 주문은 판매자센터에서 내려받아 아래 ‘주문 CSV 가져오기’로 올려 주세요.</p></div>
          <span className="section-live-status setup"><span /> {CHANNEL_NOT_CONNECTED}</span>
        </div>
        <div className="sales-channel-grid">
          {channels.length === 0 && <div className="business-empty-state"><Store size={32} /><h3>{canManage ? '목록에 넣은 판매채널이 없습니다' : '판매채널 운영 권한이 필요합니다'}</h3><p>{canManage ? '쓰는 판매채널을 목록에 넣으면 판매자센터 바로가기와 채널별 주문 수가 생깁니다.' : '주문·배송 데이터는 회사 관리자만 관리할 수 있습니다.'}</p>{canManage && <Button tone="primary" type="button" onClick={() => setChannelDialog('catalog')}><Plus size={17} /> 첫 채널 추가</Button>}</div>}
          {channels.map((channel) => {
            const definition = channelDefinition(channel.id)
            const totals = periodSummary.byChannel[channel.id] ?? { orders: 0, units: 0 }
            const share = periodSummary.orders > 0 ? Math.round((totals.orders / periodSummary.orders) * 100) : 0
            return (
              <article className="sales-channel-card" key={channel.id}>
                <div className="sales-channel-card-head">
                  <span className="channel-mark large" style={{ backgroundColor: channelTokenColor(channel.id) }}>{channel.short}</span>
                  <div><h3>{channel.name}</h3><p>{CHANNEL_NOT_CONNECTED}</p></div>
                </div>
                <div className="channel-card-metrics">
                  <div><span>주문</span><strong>{formatNumber(totals.orders)}건</strong></div>
                  <div><span>판매수량</span><strong>{formatNumber(totals.units)}개</strong></div>
                </div>
                {periodSummary.orders > 0 && <div className="channel-performance-bar" role="img" aria-label={`${periodConfig.label} 전체 주문 중 ${share}%`}>
                  <span style={{ width: `${share}%`, backgroundColor: channelTokenColor(channel.id) }} />
                </div>}
                <div className="channel-card-actions">
                  {definition && <a href={definition.sellerUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /> 판매자센터</a>}
                  {canManage && definition && <Button tone="ghost" size="sm" type="button" aria-label={`${channel.name} 목록에서 빼기`} onClick={() => { openChannelSetup(channel.id); setConfirmDisconnect(true) }}><Trash2 size={15} /> 목록에서 빼기</Button>}
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section className="business-panel shipment-panel" aria-labelledby="shipment-title">
        <div className="business-panel-head shipment-panel-head">
          <div>
            <h2 id="shipment-title">주문 출고 · 송장</h2>
            <p>채널 주문 CSV 또는 수기 주문을 출고대기로 모으고, 택배사·송장번호 등록 후 바로 인쇄합니다.</p>
          </div>
          {canManage && <div className="shipment-heading-actions">
            <Button tone="quiet" type="button" onClick={downloadShipmentTemplate}>CSV 양식</Button>
            <input ref={shipmentFileRef} className="sr-only" type="file" accept=".csv,text/csv" onChange={(event) => void importShipmentCsv(event.target.files?.[0])} />
            <Button tone="ghost" type="button" onClick={() => shipmentFileRef.current?.click()}><FileUp size={17} /> 주문 CSV 가져오기</Button>
            <Button tone="primary" type="button" onClick={() => setShipmentDialog('new')}><Plus size={17} /> 배송 주문 등록</Button>
          </div>}
        </div>
        <div className="shipment-integration-note">
          <Truck size={19} aria-hidden="true" />
          <div><strong>지금은 직접 등록과 CSV 가져오기로 출고를 관리합니다.</strong><span>판매채널 주문 자동 수집과 택배사 규격 바코드·집하 접수는 아직 없습니다.</span></div>
        </div>
        <div className="shipment-filter-row" role="group" aria-label="배송 상태 필터">
          {([['all', '전체'], ['출고대기', '출고대기'], ['송장등록', '송장등록'], ['출고완료', '출고완료']] as const).map(([value, label]) => (
            <button className={shipmentFilter === value ? 'active' : ''} type="button" aria-pressed={shipmentFilter === value} onClick={() => setShipmentFilter(value)} key={value}>
              {label} <span>{value === 'all' ? shipments.length : shipments.filter((item) => item.status === value).length}</span>
            </button>
          ))}
        </div>
        {visibleShipments.length > 0 ? <div className="shipment-table-wrap">
          <table className="shipment-table">
            <thead><tr><th>주문·채널</th><th>수취인·배송지</th><th>상품</th><th>택배·송장</th><th>상태</th><th><span className="sr-only">작업</span></th></tr></thead>
            <tbody>{visibleShipments.map((shipment) => <tr key={shipment.id}>
              <td><strong>{shipment.orderNo}</strong><span>{shipment.channelName} · {formatDateTime(shipment.orderedAt)}</span></td>
              <td><strong>{shipment.recipient} · {shipment.phone}</strong><span>{shipment.address}</span></td>
              <td><strong>{shipment.productName}</strong><span>{shipment.quantity}개</span></td>
              <td>{shipment.trackingNo ? <><strong>{shipment.courier}</strong><span>{shipment.trackingNo}</span></> : <span>송장 미등록</span>}</td>
              <td><BusinessStatusBadge status={shipment.status} /></td>
              <td><div className="shipment-row-actions">
                <Button tone="ghost" type="button" size="sm" onClick={() => setShipmentDialog(shipment.id)}>{shipment.trackingNo ? '송장 수정' : '송장 등록'}</Button>
                <IconButton tone="ghost" type="button" aria-label={`${shipment.orderNo} 송장 인쇄`} disabled={!shipment.trackingNo} size="sm" onClick={() => printShippingLabel(shipment)}><Printer size={17} /></IconButton>
                {shipment.status !== '출고완료' && <IconButton tone="ghost" type="button" aria-label={`${shipment.orderNo} 출고 완료`} disabled={!shipment.trackingNo} size="sm" onClick={() => void completeShipment(shipment)}><CheckCircle2 size={17} /></IconButton>}
                <button className={`shipment-delete-button${confirmShipmentDeleteId === shipment.id ? ' confirming' : ''}`} type="button" aria-label={confirmShipmentDeleteId === shipment.id ? `${shipment.orderNo} 배송 행 삭제 확인` : `${shipment.orderNo} 배송 행 삭제`} onClick={() => confirmShipmentDeleteId === shipment.id ? void deleteShipment(shipment) : setConfirmShipmentDeleteId(shipment.id)}>{confirmShipmentDeleteId === shipment.id ? '삭제 확인' : <Trash2 size={17} />}</button>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div> : <div className="business-empty-state compact"><Truck size={30} /><h3>해당 상태의 배송 주문이 없습니다</h3><p>채널 주문 CSV를 가져오거나 배송 주문을 직접 등록하세요.</p></div>}
      </section>

      {canManage && shipmentDialog && <ShipmentEditorDialog
        shipment={shipmentDialog === 'new' ? null : shipments.find((item) => item.id === shipmentDialog) ?? null}
        channels={channels}
        busy={shipmentBusy}
        onClose={() => setShipmentDialog(null)}
        onSave={saveShipment}
      />}
      {canManage && channelDialog && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !savingChannel && setChannelDialog(null)}>
        <section ref={channelDialogRef} className="modal-card channel-connect-modal" role="dialog" aria-modal="true" aria-labelledby="channel-connect-title">
          <header><div><span className="page-kicker">SALES CHANNEL</span><h2 id="channel-connect-title">{selectedDefinition ? selectedDefinition.name : '판매채널 추가'}</h2><p>{selectedDefinition ? '판매자센터에서 주문을 내려받아 CSV로 올리면 이 화면에서 셉니다.' : '쓰는 판매채널을 목록에 넣어 두세요.'}</p></div><IconButton tone="ghost" type="button" aria-label="닫기" disabled={savingChannel} onClick={() => setChannelDialog(null)}><X size={21} /></IconButton></header>
          {channelDialog === 'catalog' && <>
            <div className="integration-truth-banner"><ShieldCheck size={20} /><div><strong>아직 판매채널과 직접 연결하지 않습니다.</strong><p>목록에 넣으면 판매자센터 바로가기와 채널별 주문 수가 생깁니다. 주문과 매출을 자동으로 가져오지는 않습니다.</p></div></div>
            <div className="channel-catalog">{channelDefinitions.map((definition) => {
              const existing = channels.find((channel) => channel.id === definition.id)
              return <button className={existing ? 'configured' : ''} type="button" key={definition.id} onClick={() => openChannelSetup(definition.id)}>
                <span className="channel-mark large" style={{ backgroundColor: definition.color }}>{definition.short}</span>
                <div><strong>{definition.name}</strong><small>{existing ? '목록에 있음' : '추가할 수 있음'}</small></div>
                {existing ? <CheckCircle2 size={19} /> : <ChevronRight size={19} />}
              </button>
            })}</div>
            <footer><span><ExternalLink size={17} /> 판매자센터 링크는 각 회사의 공식 사이트로 열립니다.</span><Button tone="ghost" type="button" onClick={() => setChannelDialog(null)}>닫기</Button></footer>
          </>}
          {selectedDefinition && <>
            <div className="channel-setup-scroll">
              <div className="channel-resource-links">
                <a href={selectedDefinition.sellerUrl} target="_blank" rel="noreferrer"><Store size={18} /><span><strong>판매자센터 열기</strong><small>주문 내려받기</small></span><ExternalLink size={16} /></a>
              </div>
              <section className="channel-checklist" aria-labelledby="channel-steps-title">
                <div><h3 id="channel-steps-title">주문을 이 화면으로 가져오는 방법</h3><span>3단계</span></div>
                <ol>
                  <li><CheckCircle2 size={17} /> 판매자센터에서 주문 목록을 내려받습니다.</li>
                  <li><CheckCircle2 size={17} /> ‘CSV 양식’에 맞춰 칸을 옮깁니다. 채널ID 칸에는 {selectedDefinition.id}를 적습니다.</li>
                  <li><CheckCircle2 size={17} /> ‘주문 CSV 가져오기’로 올리면 채널별 주문 수와 출고 목록에 들어갑니다.</li>
                </ol>
              </section>
            </div>
            <footer className="channel-setup-footer">
              <div>{selectedChannel && <Button tone="danger" size="sm" type="button" disabled={savingChannel} onClick={() => confirmDisconnect ? void disconnectChannel(selectedChannel) : setConfirmDisconnect(true)}><Trash2 size={16} /> {confirmDisconnect ? '한 번 더 눌러 빼기' : '목록에서 빼기'}</Button>}</div>
              <div><Button tone="ghost" type="button" disabled={savingChannel} onClick={() => setChannelDialog('catalog')}>채널 목록</Button>{selectedChannel
                ? <Button tone="primary" type="button" disabled={savingChannel} onClick={() => setChannelDialog(null)}>닫기</Button>
                : <Button tone="primary" type="button" disabled={savingChannel} onClick={() => void addChannelToList(selectedDefinition)}>{savingChannel ? '추가 중…' : '목록에 추가'}</Button>}</div>
            </footer>
          </>}
        </section>
      </div>}
    </div>
  )
}
