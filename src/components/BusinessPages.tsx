import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  FileUp,
  ExternalLink,
  ImagePlus,
  KeyRound,
  Link2,
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
  TrendingDown,
  TrendingUp,
  Warehouse,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { ChannelMetric, SeaProduct } from '../domainData'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateTime } from '../utils/dateTime'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './BusinessPagesEnhancements.css'

type BusinessPageProps = {
  onToast: (message: string) => void
}

type TenantBusinessPageProps = BusinessPageProps & {
  workspaceScope?: string
  companyName?: string
}

type ProductDetailTab = 'basic' | 'label' | 'channels' | 'inventory'
type SalesPeriod = 'today' | 'week' | 'month'
type ChannelSetupStatus = 'setup-required' | 'credentials-entered' | 'test-pending'
type ChannelHealthResult = {
  credential: 'missing' | 'ready'
  response: 'not-tested' | 'ok' | 'unavailable'
  responseLabel: string
  mapping: 'none' | 'ready' | 'attention'
  mappingLabel: string
  checkedAt: string
}

type ManagedChannel = ChannelMetric & {
  connectionStatus?: ChannelSetupStatus
  sellerAccount?: string
  credentialHint?: string
  credentialFields?: Record<string, string>
  checkedAt?: string
  health?: ChannelHealthResult
}

type CredentialField = {
  id: string
  label: string
  placeholder: string
  secret?: boolean
}

type ChannelDefinition = {
  id: string
  name: string
  short: string
  color: string
  authMode: string
  sellerUrl: string
  docsUrl: string
  fields: CredentialField[]
  checklist: string[]
  accessNote: string
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

const channelDefinitions: ChannelDefinition[] = [
  {
    id: 'coupang', name: '쿠팡', short: 'C', color: 'var(--color-danger)', authMode: 'HMAC Access Key',
    sellerUrl: 'https://wing.coupang.com/', docsUrl: 'https://developers.coupangcorp.com/',
    fields: [
      { id: 'vendorId', label: 'Vendor ID', placeholder: 'A00012345' },
      { id: 'accessKey', label: 'Access Key', placeholder: 'WING에서 발급한 Access Key', secret: true },
      { id: 'secretKey', label: 'Secret Key', placeholder: 'WING에서 발급한 Secret Key', secret: true },
    ],
    checklist: ['WING 사업자 판매자 계정 승인', '판매자정보에서 Open API Key 발급', '연동 서버의 고정 IP 등록'],
    accessNote: '쿠팡은 WING에서 발급한 Vendor ID·Access Key·Secret Key와 HMAC 서명이 필요합니다.',
  },
  {
    id: 'naver', name: '네이버 스마트스토어', short: 'N', color: 'var(--color-success)', authMode: 'Commerce API 애플리케이션',
    sellerUrl: 'https://sell.smartstore.naver.com/', docsUrl: 'https://apicenter.commerce.naver.com/docs/commerce-api/current',
    fields: [
      { id: 'sellerId', label: '커머스 판매자 ID', placeholder: '통합 매니저 계정' },
      { id: 'clientId', label: '애플리케이션 ID', placeholder: '커머스API센터 애플리케이션 ID' },
      { id: 'clientSecret', label: '애플리케이션 Secret', placeholder: '커머스API센터 Secret', secret: true },
    ],
    checklist: ['스마트스토어 통합 매니저 권한 확인', '커머스API센터 계정 생성', '애플리케이션 등록 및 API 권한 확인'],
    accessNote: '스마트스토어 통합 매니저가 커머스API센터에서 애플리케이션을 등록해야 합니다.',
  },
  {
    id: 'gmarket', name: 'G마켓 · 옥션', short: 'G', color: 'var(--color-blue)', authMode: 'ESM Trading API',
    sellerUrl: 'https://www.esmplus.com/', docsUrl: 'https://etapi.gmarket.com/',
    fields: [
      { id: 'esmId', label: 'ESM 마스터 ID', placeholder: 'ESM PLUS 마스터 ID' },
      { id: 'apiKey', label: 'Trading API Key', placeholder: 'ESM API에서 발급한 키', secret: true },
    ],
    checklist: ['ESM PLUS 마스터 ID 생성', 'G마켓/옥션 판매자 ID 연결', 'ESM Trading API 사용 신청 및 키 발급'],
    accessNote: 'ESM PLUS 판매자 계정과 ESM Trading API 사용 권한이 모두 필요합니다.',
  },
  {
    id: '11st', name: '11번가', short: '11', color: 'var(--color-danger)', authMode: 'Open API Key',
    sellerUrl: 'https://soffice.11st.co.kr/', docsUrl: 'https://openapi.11st.co.kr/',
    fields: [
      { id: 'sellerId', label: '셀러 ID', placeholder: '11번가 셀러오피스 ID' },
      { id: 'apiKey', label: 'Open API Key', placeholder: 'Open API Center 발급 키', secret: true },
    ],
    checklist: ['셀러오피스 판매회원 승인', 'Open API Center 서비스 등록', 'API Key 발급 및 사용 권한 확인'],
    accessNote: '11번가 Open API Center에서 서비스 등록 후 API Key를 발급해야 합니다.',
  },
  {
    id: 'ssg', name: 'SSG.COM', short: 'S', color: 'var(--color-danger)', authMode: 'SSG eAPI 인증키',
    sellerUrl: 'https://partners.ssgadm.com/', docsUrl: 'https://eapi.ssgadm.com/info/main.ssg',
    fields: [
      { id: 'sellerId', label: '파트너사 ID', placeholder: 'SSG 파트너오피스 ID' },
      { id: 'apiKey', label: 'eAPI 인증키', placeholder: 'SSG eAPI에서 발급한 인증키', secret: true },
    ],
    checklist: ['SSG.COM 입점 및 파트너오피스 승인', 'eAPI 사이트에서 신규(New) API 연동 신청', '상품·주문·배송 권한과 인증키 확인'],
    accessNote: 'SSG.COM 파트너오피스 입점 승인 후 eAPI 신규(New) API 기준으로 인증키와 사용할 권한을 확인해야 합니다.',
  },
  {
    id: 'kakao', name: '카카오 톡스토어 · 선물하기', short: 'K', color: 'var(--color-warning)', authMode: 'REST API KEY + ADMIN KEY',
    sellerUrl: 'https://shopping-sell.kakao.com/hub', docsUrl: 'https://shopping-developers.kakao.com/hc/ko/articles/4681097907087',
    fields: [
      { id: 'sellerId', label: '판매자 ID', placeholder: '카카오쇼핑 판매자 ID' },
      { id: 'restApiKey', label: 'REST API KEY', placeholder: '판매자 연동 설정에서 발급한 REST API KEY', secret: true },
      { id: 'adminKey', label: 'ADMIN KEY', placeholder: '판매자 연동 설정에서 발급한 ADMIN KEY', secret: true },
    ],
    checklist: ['카카오쇼핑 판매채널 입점 승인', 'Open API 별도 이용 신청 및 판매자 연동 설정', '운영용 REST API KEY·ADMIN KEY와 서비스별 권한 확인'],
    accessNote: '카카오쇼핑 Open API는 별도 이용 신청과 판매자 연동 설정이 필요하며, 제공되는 운영 환경의 REST API KEY·ADMIN KEY로 인증합니다.',
  },
  {
    id: 'own', name: '카페24 자사몰', short: '24', color: 'var(--color-blue-deep)', authMode: 'OAuth 2.0',
    sellerUrl: 'https://eclogin.cafe24.com/Shop/', docsUrl: 'https://developers.cafe24.com/',
    fields: [
      { id: 'mallId', label: 'Mall ID', placeholder: '카페24 쇼핑몰 ID' },
      { id: 'clientId', label: 'Client ID', placeholder: '개발자센터 App Client ID' },
      { id: 'clientSecret', label: 'Client Secret', placeholder: '개발자센터 App Secret', secret: true },
    ],
    checklist: ['카페24 개발자센터 앱 생성', '주문·상품·재고 Scope 설정', 'OAuth Redirect URI 등록'],
    accessNote: '카페24 Admin API는 OAuth 2.0 승인 코드와 Access Token 발급이 필요합니다.',
  },
]

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
    sync: '실 API 미연결',
    status: '설정중',
    connectionStatus: 'setup-required',
  }
}

function connectionLabel(channel: ManagedChannel) {
  if (channel.connectionStatus === 'test-pending') return '실 API 테스트 대기'
  if (channel.connectionStatus === 'credentials-entered') return '자격정보 입력됨'
  return '설정 필요'
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
  labelScore: number
  labelOwner: string
  labelSummary: string
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
  labelScore: 0,
  labelOwner: '품질관리 담당자 미지정',
  labelSummary: '표시 필수항목 검증 전입니다.',
  labelIssue: '표시정보를 입력한 뒤 검증을 실행해 주세요.',
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

function collectLabelIssues(product: ManagedProduct) {
  const issues: string[] = []
  const { fact } = product
  if (!product.name.trim()) issues.push('제품명이 비어 있습니다.')
  if (!fact.foodType.trim()) issues.push('식품유형을 입력해 주세요.')
  if (!fact.ingredients.trim()) issues.push('원재료명과 함량을 입력해 주세요.')
  if (!fact.origin.trim()) issues.push('원산지 표시를 입력해 주세요.')
  if (!fact.shelfLife.trim()) issues.push('소비기한 표시 기준을 입력해 주세요.')
  if (!product.storage.trim()) issues.push('보관방법을 입력해 주세요.')
  if (!/^\d{13}$/.test(fact.barcode)) issues.push('바코드는 숫자 13자리로 입력해 주세요.')
  if (fact.labelIssue.trim() && !/(없습니다|이상 없음|해당 없음)/.test(fact.labelIssue)) issues.push(fact.labelIssue.trim())
  return Array.from(new Set(issues))
}

function validateLabelRecord(product: ManagedProduct): ManagedProduct {
  const issues = collectLabelIssues(product)
  const score = Math.max(45, 100 - issues.length * 11)
  const labelStatus: SeaProduct['labelStatus'] = issues.length === 0 ? '승인' : issues.length <= 2 ? '검토중' : '수정필요'
  return {
    ...product,
    labelStatus,
    fact: {
      ...product.fact,
      labelScore: score,
      labelSummary: issues.length === 0
        ? '법정 의무표시 필수 입력값이 모두 확인되었습니다.'
        : `표시 필수항목 ${issues.length}건을 담당자가 확인해야 합니다.`,
      labelIssue: issues[0] ?? '현재 확인된 수정 항목이 없습니다.',
    },
    validation: { checkedAt: new Date().toISOString(), issues },
  }
}

const salesPeriods: Array<{ id: SalesPeriod; label: string; factor: number }> = [
  { id: 'today', label: '오늘', factor: 0.16 },
  { id: 'week', label: '최근 7일', factor: 1 },
  { id: 'month', label: '최근 30일', factor: 4.18 },
]

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
    <section className="business-summary-strip" aria-label={label}>
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
      ? `${validated.shortName} 표시정보에서 ${validated.validation.issues.length}건을 확인했습니다.`
      : `${validated.shortName} 표시 필수항목 검증을 통과했습니다.`)
  }

  const attentionCount = products.filter((product) => product.status !== '정상').length
  const labelReviewCount = products.filter((product) => product.labelStatus !== '승인').length
  const linkedChannelCount = products.reduce((sum, product) => sum + product.channels, 0)

  return (
    <div className="page-enter business-page product-management-page">
      <header className="page-heading business-page-head">
        <div>
          <div className="page-kicker">Product control</div>
          <h1>제품 통합관리</h1>
          <p>{canManage ? `${companyName}의 제품 기준정보부터 표시·법규, 판매채널과 재고 LOT까지 제품 중심으로 연결합니다.` : '제품 기준정보, 표시·법규와 재고 LOT를 업무에 필요한 범위에서 조회합니다.'}</p>
        </div>
        {canManage && <div className="heading-actions">
          <button className="primary-button" type="button" onClick={() => openEditor()}>
            <Package size={17} aria-hidden="true" /> 제품 등록
          </button>
        </div>}
      </header>

      <BusinessSummaryStrip label="제품 주요 현황" items={[
        { icon: Boxes, label: '운영 제품', value: `${products.length}개`, helper: '완제품 기준' },
        { icon: AlertTriangle, label: '재고 확인', value: `${attentionCount}개`, helper: products.length ? '안전재고 이하' : '등록 대기', tone: 'warning' },
        { icon: FileCheck2, label: '표시 검토', value: `${labelReviewCount}개`, helper: '규칙 검증 기준', tone: 'blue' },
        canManage
          ? { icon: Link2, label: '상품 채널', value: `${linkedChannelCount}건`, helper: '제품별 등록값', tone: 'green' }
          : { icon: Warehouse, label: '재고 연결', value: `${products.length}개`, helper: 'LOT 위치 확인', tone: 'green' },
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
                      {canManage && <span><Store size={15} aria-hidden="true" /> {product.channels}개 채널</span>}
                      <span><Tags size={15} aria-hidden="true" /> 표시 {product.labelStatus}</span>
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
            <p>첫 제품의 품목코드와 표시정보를 등록하면 재고·판매채널을 함께 연결할 수 있습니다.</p>
            {canManage && <button className="primary-button" type="button" onClick={() => openEditor()}><Plus size={17} /> 첫 제품 등록</button>}
          </div>
        ) : (
          <div className="business-empty-state">
            <Search size={30} aria-hidden="true" />
            <h3>검색 결과가 없습니다</h3>
            <p>검색어나 제품 분류를 다시 확인해 주세요.</p>
            <button className="secondary-button" type="button" onClick={() => { setQuery(''); setCategory('전체') }}>
              검색 초기화
            </button>
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
    const code = text('code').toUpperCase()
    const stock = number('stock')
    const available = number('available')
    const safetyStock = number('safetyStock')
    const price = number('price')
    const barcode = text('barcode')
    const nextErrors: Record<string, string> = {}

    if (!code) nextErrors.code = '품목코드를 입력해 주세요.'
    else if (existingProducts.some((item) => item.id !== product?.id && item.code.toUpperCase() === code)) nextErrors.code = '이미 사용 중인 품목코드입니다.'
    if (!text('name')) nextErrors.name = '제품명을 입력해 주세요.'
    if (!text('shortName')) nextErrors.shortName = '목록에 표시할 짧은 이름을 입력해 주세요.'
    if (!text('category')) nextErrors.category = '제품 분류를 입력해 주세요.'
    if (!text('specification')) nextErrors.specification = '규격을 입력해 주세요.'
    if (!Number.isFinite(price) || price < 0) nextErrors.price = '판매가는 0원 이상이어야 합니다.'
    if (!Number.isInteger(stock) || stock < 0) nextErrors.stock = '실재고는 0 이상의 정수로 입력해 주세요.'
    if (!Number.isInteger(available) || available < 0) nextErrors.available = '가용재고는 0 이상의 정수로 입력해 주세요.'
    else if (available > stock) nextErrors.available = '가용재고는 실재고보다 많을 수 없습니다.'
    if (!Number.isInteger(safetyStock) || safetyStock < 0) nextErrors.safetyStock = '안전재고는 0 이상의 정수로 입력해 주세요.'
    if (!text('storage')) nextErrors.storage = '보관방법을 입력해 주세요.'
    if (!text('manufacturer')) nextErrors.manufacturer = '제조원을 입력해 주세요.'
    if (!text('foodType')) nextErrors.foodType = '식품유형을 입력해 주세요.'
    if (!/^\d{13}$/.test(barcode)) nextErrors.barcode = '바코드는 숫자 13자리로 입력해 주세요.'
    if (!text('shelfLife')) nextErrors.shelfLife = '소비기한 표시 기준을 입력해 주세요.'
    if (!text('origin')) nextErrors.origin = '원산지 표시를 입력해 주세요.'
    if (!text('ingredients')) nextErrors.ingredients = '원재료명과 함량을 입력해 주세요.'

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
      name: text('name'),
      shortName: text('shortName'),
      category: text('category'),
      specification: text('specification'),
      price,
      stock,
      available,
      safetyStock,
      storage: text('storage'),
      status: text('status') as SeaProduct['status'],
      labelStatus: '검토중',
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
        labelScore: Math.min(fact.labelScore, 80),
        labelSummary: '제품 정보가 변경되어 표시 필수항목 재검증이 필요합니다.',
        labelIssue: text('labelIssue') || '현재 확인된 수정 항목이 없습니다.',
      },
      validation: undefined,
      imageDataUrl: imageDataUrl || undefined,
      imageFileName: imageDataUrl ? imageFileName : undefined,
    }

    setSaving(true)
    const saved = await onSave(next, isNew)
    if (!saved.ok) setSaving(false)
  }

  const error = (name: string) => errors[name] ? <small className="field-error">{errors[name]}</small> : null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section ref={dialogRef} className="modal-card product-editor-modal" role="dialog" aria-modal="true" aria-labelledby="product-editor-title">
        <header>
          <div><span className="page-kicker">PRODUCT MASTER</span><h2 id="product-editor-title">{product ? '제품 정보 편집' : '신규 제품 등록'}</h2><p>기준정보와 식품 표시 필수값을 입력합니다. 저장 후 표시 검증을 실행해 주세요.</p></div>
          <button className="icon-button" type="button" aria-label="닫기" disabled={saving} onClick={onClose}><X size={21} /></button>
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
                  <label className={`secondary-button file-picker-button${imageBusy ? ' disabled' : ''}`}>
                    <ImagePlus size={17} aria-hidden="true" /> {imageBusy ? '이미지 처리 중…' : imageDataUrl ? '이미지 변경' : '이미지 선택'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={imageBusy || saving}
                      onClick={(event) => { event.currentTarget.value = '' }}
                      onChange={(event) => void selectImage(event.target.files?.[0])}
                    />
                  </label>
                  {imageDataUrl && <button className="danger-text-button" type="button" disabled={imageBusy || saving} onClick={() => { setImageDataUrl(''); setImageFileName(''); setImageError('') }}><Trash2 size={16} /> 이미지 삭제</button>}
                  <small>{imageFileName || 'JPG·PNG·WEBP, 원본 5MB 이하'}</small>
                </div>
                {imageError && <div className="field-error product-image-error" role="alert">{imageError}</div>}
              </div>
            </section>
            <section className="product-editor-section" aria-labelledby="product-basic-fields">
              <div><h3 id="product-basic-fields">기본정보</h3><p>제품을 식별하고 판매·재고에 공통으로 쓰는 값입니다.</p></div>
              <div className="product-editor-grid">
                <label className="form-field"><span>품목코드 *</span><input name="code" defaultValue={product?.code ?? ''} aria-invalid={Boolean(errors.code)} placeholder="FG-NEW-001" />{error('code')}</label>
                <label className="form-field"><span>제품 분류 *</span><input name="category" defaultValue={product?.category ?? ''} aria-invalid={Boolean(errors.category)} placeholder="예: 조미식품" />{error('category')}</label>
                <label className="form-field full"><span>제품명 *</span><input name="name" defaultValue={product?.name ?? ''} aria-invalid={Boolean(errors.name)} placeholder="판매·표시에 사용할 정식 제품명" />{error('name')}</label>
                <label className="form-field"><span>목록 표시명 *</span><input name="shortName" defaultValue={product?.shortName ?? ''} aria-invalid={Boolean(errors.shortName)} placeholder="짧은 제품명" />{error('shortName')}</label>
                <label className="form-field"><span>규격 *</span><input name="specification" defaultValue={product?.specification ?? ''} aria-invalid={Boolean(errors.specification)} placeholder="예: 300g × 12병 / BOX" />{error('specification')}</label>
                <label className="form-field"><span>판매가 *</span><input name="price" type="number" min="0" defaultValue={product?.price ?? 0} aria-invalid={Boolean(errors.price)} />{error('price')}</label>
                <label className="form-field"><span>운영상태</span><select name="status" defaultValue={product?.status ?? '정상'}><option>정상</option><option>주의</option><option>품절</option></select></label>
                <label className="form-field full"><span>보관방법 *</span><input name="storage" defaultValue={product?.storage ?? ''} aria-invalid={Boolean(errors.storage)} placeholder="예: 냉장 0~10℃" />{error('storage')}</label>
              </div>
            </section>
            <section className="product-editor-section" aria-labelledby="product-label-fields">
              <div><h3 id="product-label-fields">표시 · 제조정보</h3><p>필수 입력값과 품질 담당자의 확인 메모를 함께 관리합니다.</p></div>
              <div className="product-editor-grid">
                <label className="form-field"><span>제조원 *</span><input name="manufacturer" defaultValue={fact.manufacturer} aria-invalid={Boolean(errors.manufacturer)} />{error('manufacturer')}</label>
                <label className="form-field"><span>제조형태</span><select name="manufacturingType" defaultValue={fact.manufacturingType}><option>자체생산</option><option>OEM</option><option>ODM</option></select></label>
                <label className="form-field"><span>식품유형 *</span><input name="foodType" defaultValue={fact.foodType} aria-invalid={Boolean(errors.foodType)} />{error('foodType')}</label>
                <label className="form-field"><span>바코드 13자리 *</span><input name="barcode" inputMode="numeric" maxLength={13} defaultValue={fact.barcode} aria-invalid={Boolean(errors.barcode)} />{error('barcode')}</label>
                <label className="form-field full"><span>소비기한 표시 *</span><input name="shelfLife" defaultValue={fact.shelfLife} aria-invalid={Boolean(errors.shelfLife)} placeholder="예: 제조일로부터 12개월" />{error('shelfLife')}</label>
                <label className="form-field full"><span>원산지 표시 *</span><textarea name="origin" rows={2} defaultValue={fact.origin} aria-invalid={Boolean(errors.origin)} />{error('origin')}</label>
                <label className="form-field full"><span>원재료명·함량 *</span><textarea name="ingredients" rows={3} defaultValue={fact.ingredients} aria-invalid={Boolean(errors.ingredients)} />{error('ingredients')}</label>
                <label className="form-field"><span>표시 검토 담당</span><input name="labelOwner" defaultValue={fact.labelOwner} /></label>
                <label className="form-field"><span>표시 검토 메모</span><input name="labelIssue" defaultValue={fact.labelIssue} placeholder="이상 없으면 ‘수정 항목 없음’ 입력" /></label>
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
          <footer><span>저장 후 표시 상태는 자동으로 ‘검토중’으로 변경됩니다.</span><div><button className="secondary-button" type="button" disabled={saving || imageBusy} onClick={onClose}>취소</button><button className="primary-button" type="submit" disabled={saving || imageBusy}>{saving ? '저장 중…' : product ? '변경사항 저장' : '제품 등록'}</button></div></footer>
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
  onValidate: () => void
  canViewCommercial: boolean
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const [showValidationHistory, setShowValidationHistory] = useState(false)
  const [showLotHistory, setShowLotHistory] = useState(false)
  const productChannels = channels
  const heldStock = Math.max(0, product.stock - product.available - detail.reserved)

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
    { id: 'label', label: '표시 · 법규', icon: FileCheck2 },
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
              <BusinessStatusBadge status={`표시 ${product.labelStatus}`} />
            </div>
            <h2 id="product-detail-title">{product.name}</h2>
            <p>{product.code} · {product.specification}</p>
          </div>
          <button ref={closeButtonRef} className="close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
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
              <div className={`label-score-card ${product.labelStatus === '승인' ? 'approved' : ''}`}>
                <div className="label-score-ring" style={{ '--score': detail.labelScore } as React.CSSProperties}>
                  <strong>{detail.labelScore}</strong>
                  <span>AI 점수</span>
                </div>
                <div>
                  <div className="label-score-title"><BusinessStatusBadge status={product.labelStatus} /><span>담당 {detail.labelOwner}</span></div>
                  <h3>{detail.labelSummary}</h3>
                  <p>{detail.labelIssue}</p>
                </div>
              </div>
              <div className="label-check-grid">
                {['원재료명·함량', '알레르기 유발물질', '원산지', '영양정보·보관방법'].map((item, index) => {
                  const warning = product.labelStatus !== '승인' && index === 1
                  return (
                    <div className={warning ? 'label-check-item warning' : 'label-check-item'} key={item}>
                      {warning ? <AlertTriangle size={19} aria-hidden="true" /> : <CheckCircle2 size={19} aria-hidden="true" />}
                      <div><strong>{item}</strong><span>{warning ? '담당자 확인 필요' : '내부 기준과 일치'}</span></div>
                    </div>
                  )
                })}
              </div>
              {showValidationHistory && <div className="label-validation-history" role="status">
                <div><strong>최근 규칙 검증</strong><span>{validation?.checkedAt ? formatDateTime(validation.checkedAt) : '아직 실행하지 않음'}</span></div>
                {validation?.issues.length
                  ? <ul>{validation.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
                  : <p>{validation ? '현재 필수 입력값 기준 확인 항목이 없습니다.' : '표시사항 다시 검증을 실행하면 결과가 이곳에 기록됩니다.'}</p>}
              </div>}
              <button className="secondary-button" type="button" aria-expanded={showValidationHistory} onClick={() => setShowValidationHistory((current) => !current)}>
                <FileCheck2 size={16} aria-hidden="true" /> {showValidationHistory ? '검토 이력 닫기' : '검토 이력 보기'}
              </button>
            </div>
          )}

          {canViewCommercial && activeTab === 'channels' && (
            <div id="product-panel-channels" role="tabpanel" aria-labelledby="product-tab-channels" className="product-channel-detail-list">
              <p className="channel-demo-note">회사에 등록된 판매채널 설정입니다. 상품별 매핑 상태는 판매자센터 API가 연결되면 확인할 수 있습니다.</p>
              {productChannels.length === 0 && <div className="business-empty-state"><Store size={28} /><h3>등록된 상품 채널이 없습니다</h3><p>판매채널 페이지에서 API 설정을 완료한 뒤 상품 매핑을 진행하세요.</p></div>}
              {productChannels.map((channel) => (
                  <article className="product-channel-detail" key={channel.id}>
                    <span className="channel-mark" style={{ backgroundColor: channelTokenColor(channel.id) }}>{channel.short}</span>
                    <div className="product-channel-name">
                      <strong>{channel.name}</strong>
                      <span>{channel.short}-{product.code} · {product.specification}</span>
                    </div>
                    <div><span>기준 판매가</span><strong>{formatMoney(product.price)}</strong></div>
                    <div><span>채널 주문</span><strong>{formatNumber(channel.orders)}건</strong></div>
                    <div><span>동기화</span><strong>{channel.sync}</strong></div>
                    <BusinessStatusBadge status={connectionLabel(channel)} />
                    {channelDefinition(channel.id) && <a className="product-channel-external" href={channelDefinition(channel.id)!.sellerUrl} target="_blank" rel="noreferrer" aria-label={`${channel.name} 판매자센터 열기`}><ExternalLink size={18} aria-hidden="true" /></a>}
                  </article>
              ))}
            </div>
          )}

          {activeTab === 'inventory' && (
            <div id="product-panel-inventory" role="tabpanel" aria-labelledby="product-tab-inventory" className="inventory-detail-panel">
              <div className="inventory-summary-cards">
                <div><span>실재고</span><strong>{formatNumber(product.stock)}개</strong></div>
                <div><span>예약재고</span><strong>{formatNumber(detail.reserved)}개</strong></div>
                <div className={product.available <= product.safetyStock ? 'warning' : ''}><span>가용재고</span><strong>{formatNumber(product.available)}개</strong></div>
              </div>
              {product.available <= product.safetyStock && (
                <div className="inventory-warning-banner">
                  <AlertTriangle size={20} aria-hidden="true" />
                  <div>
                    <strong>{product.available === 0 ? '현재 판매 가능한 재고가 없습니다.' : '안전재고 이하로 내려갔습니다.'}</strong>
                    <span>{heldStock > 0 ? `${formatNumber(heldStock)}개가 품질검사로 보류 중입니다.` : '판매 추세를 반영한 생산 또는 발주 검토가 필요합니다.'}</span>
                  </div>
                </div>
              )}
              <div className="lot-detail-card">
                <div className="lot-detail-head">
                  <div><span>대표 LOT</span><h3>{detail.lotNo}</h3></div>
                  <BusinessStatusBadge status={detail.inspection} />
                </div>
                <dl className="product-fact-grid">
                  <div><dt>창고</dt><dd>{detail.warehouse}</dd></div>
                  <div><dt>로케이션</dt><dd>{detail.location}</dd></div>
                  <div><dt>제조일</dt><dd>{detail.manufacturedAt}</dd></div>
                  <div><dt>소비기한</dt><dd>{detail.expiresAt}</dd></div>
                  <div><dt>잔여일</dt><dd>D-{detail.daysToExpire}</dd></div>
                  <div><dt>검사상태</dt><dd>{detail.inspection}</dd></div>
                </dl>
              </div>
              {showLotHistory && <div className="lot-history-list"><div><strong>{detail.lotNo}</strong><span>{detail.manufacturedAt} 제조 · {detail.warehouse} {detail.location}</span><BusinessStatusBadge status={detail.inspection} /></div><p>현재 제품에 연결된 추가 LOT는 없습니다.</p></div>}
              <button className="secondary-button" type="button" aria-expanded={showLotHistory} onClick={() => setShowLotHistory((current) => !current)}>
                <Warehouse size={16} aria-hidden="true" /> {showLotHistory ? 'LOT 이력 닫기' : '전체 LOT 이력'}
              </button>
            </div>
          )}
        </div>

        <footer className="product-detail-actions">
          <span>표시 검증 · {validation?.checkedAt ? formatDateTime(validation.checkedAt) : '실행 전'}</span>
          {canViewCommercial ? <div>
            <button className="secondary-button" type="button" onClick={onValidate}>
              <RefreshCw size={16} aria-hidden="true" /> 표시 다시 검증
            </button>
            <button className="primary-button" type="button" onClick={onEdit}>
              제품 정보 편집 <ArrowRight size={16} aria-hidden="true" />
            </button>
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
      <header><div><span className="page-kicker">FULFILLMENT</span><h2 id="shipment-editor-title">{shipment ? '배송·송장 수정' : '배송 주문 등록'}</h2><p>출고에 필요한 수취 정보와 송장번호를 관리합니다.</p></div><button className="icon-button" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={20} /></button></header>
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
        <footer><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>취소</button><button className="primary-button" type="submit" disabled={busy}>{busy ? '저장 중…' : '배송정보 저장'}</button></footer>
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
  const [credentialDraft, setCredentialDraft] = useState<Record<string, string>>({})
  const [credentialError, setCredentialError] = useState('')
  const [savingChannel, setSavingChannel] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [healthPanelOpen, setHealthPanelOpen] = useState(false)
  const [checkingChannelId, setCheckingChannelId] = useState<string | null>(null)
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

  useEffect(() => {
    if (channels.some((channel) => Boolean(channel.health))) setHealthPanelOpen(true)
  }, [channels])

  const periodConfig = salesPeriods.find((item) => item.id === period) ?? salesPeriods[1]
  const factor = periodConfig.factor
  const totalOrders = channels.reduce((sum, channel) => sum + channel.orders, 0) * factor
  const totalUnits = channels.reduce((sum, channel) => sum + channel.units, 0) * factor
  const totalRevenue = channels.reduce((sum, channel) => sum + channel.revenue, 0) * factor
  const averageOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0
  const maxChannelRevenue = Math.max(1, ...channels.map((channel) => channel.revenue))

  const openChannelSetup = (channelId: string) => {
    const definition = channelDefinition(channelId)
    if (!definition) return
    const existing = channels.find((channel) => channel.id === channelId)
    const draft = Object.fromEntries(definition.fields.map((field) => [field.id, field.secret ? '' : existing?.credentialFields?.[field.id] ?? '']))
    setCredentialDraft(draft)
    setCredentialError('')
    setConfirmDisconnect(false)
    setChannelDialog(channelId)
  }

  const commitChannelChange = async (action: (current: ManagedChannel[]) => ManagedChannel[]) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await setChannels(action)
      if (result.ok || !result.message?.includes('불러오는 중')) return result
      await new Promise((resolve) => window.setTimeout(resolve, 150))
    }
    return { ok: false, persisted: false, message: '판매채널 공유 데이터 준비가 지연되고 있습니다. 잠시 후 다시 시도해 주세요.' }
  }

  const inspectChannelHealth = async (channel: ManagedChannel): Promise<ChannelHealthResult> => {
    const checkedAt = new Date().toISOString()
    const hasCredentials = channel.connectionStatus !== 'setup-required' && Boolean(channel.credentialHint)
    const localMapping = channel.orders > 0 || channel.units > 0
        ? { mapping: 'ready' as const, mappingLabel: '수집 데이터 매핑 있음' }
        : { mapping: 'none' as const, mappingLabel: '상품 매핑 없음' }
    if (!hasCredentials) {
      return { credential: 'missing', response: 'not-tested', responseLabel: '자격정보가 없어 호출하지 않음', ...localMapping, checkedAt }
    }
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (workspaceScope) headers['x-workspace-identity'] = workspaceScope
      const response = await fetch(`/api/sales-channels/${encodeURIComponent(channel.id)}/health`, { headers, cache: 'no-store' })
      let payload: { message?: string; mappedProducts?: number; mappingIssues?: number; checkedAt?: string } = {}
      try { payload = await response.json() as typeof payload } catch { /* HTTP status remains authoritative */ }
      const mappedProducts = Number(payload.mappedProducts)
      const mappingIssues = Number(payload.mappingIssues)
      const apiMapping = Number.isFinite(mappedProducts)
        ? mappingIssues > 0
          ? { mapping: 'attention' as const, mappingLabel: `${mappedProducts}개 매핑 · ${mappingIssues}개 확인` }
          : mappedProducts > 0
            ? { mapping: 'ready' as const, mappingLabel: `${mappedProducts}개 상품 매핑` }
            : { mapping: 'none' as const, mappingLabel: '상품 매핑 없음' }
        : localMapping
      if (response.ok) {
        return { credential: 'ready', response: 'ok', responseLabel: payload.message || `정상 응답 (HTTP ${response.status})`, ...apiMapping, checkedAt: payload.checkedAt || checkedAt }
      }
      return {
        credential: 'ready', response: 'unavailable',
        responseLabel: response.status === 404 ? '채널 검증 API 미구성 (HTTP 404)' : payload.message || `응답 오류 (HTTP ${response.status})`,
        ...apiMapping, checkedAt,
      }
    } catch {
      return { credential: 'ready', response: 'unavailable', responseLabel: '검증 서버에 연결할 수 없음', ...localMapping, checkedAt }
    }
  }

  const runChannelHealthCheck = async (channel?: ManagedChannel) => {
    if (checkingChannelId) return
    setHealthPanelOpen(true)
    const targets = channel ? [channel] : channels
    if (!targets.length) {
      onToast('점검할 채널이 없습니다. 채널 연결에서 사용할 판매채널을 먼저 추가해 주세요.')
      return
    }
    setCheckingChannelId(channel?.id ?? 'all')
    const results = await Promise.all(targets.map(async (item) => [item.id, await inspectChannelHealth(item)] as const))
    const byId = new Map(results)
    const result = await commitChannelChange((current) => current.map((item) => byId.has(item.id) ? { ...item, health: byId.get(item.id) } : item))
    setCheckingChannelId(null)
    if (!result.ok) {
      onToast(result.message ?? '채널 상태 점검 결과를 저장하지 못했습니다.')
      return
    }
    const missing = results.filter(([, health]) => health.credential === 'missing').length
    const responding = results.filter(([, health]) => health.response === 'ok').length
    onToast(channel
      ? `${channel.name} 상태 점검을 완료했습니다. 연결 설정 화면은 열지 않았습니다.`
      : `${results.length}개 채널 점검 완료 · API 응답 ${responding}개 · 자격정보 없음 ${missing}개`)
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
    onToast(`${definition.name}을 판매채널 목록에 추가했습니다. 자격정보는 준비되는 대로 입력할 수 있습니다.`)
    return true
  }

  const saveChannelCredentials = async (definition: ChannelDefinition, testRequested: boolean) => {
    const missing = definition.fields.find((field) => !credentialDraft[field.id]?.trim())
    if (missing) {
      setCredentialError(`${missing.label} 값을 입력해 주세요.`)
      return
    }
    const existing = channels.find((channel) => channel.id === definition.id)
    const credentialFields = Object.fromEntries(definition.fields
      .filter((field) => !field.secret)
      .map((field) => [field.id, credentialDraft[field.id].trim()]))
    const lastSecret = [...definition.fields].reverse().find((field) => field.secret)
    const secretValue = lastSecret ? credentialDraft[lastSecret.id].trim() : ''
    const next: ManagedChannel = {
      ...(existing ?? emptyManagedChannel(definition)),
      name: definition.name,
      short: definition.short,
      color: definition.color,
      status: '설정중',
      connectionStatus: testRequested ? 'test-pending' : 'credentials-entered',
      credentialFields,
      sellerAccount: Object.values(credentialFields)[0] ?? '',
      credentialHint: secretValue ? `•••• ${secretValue.slice(-4)}` : existing?.credentialHint,
      checkedAt: new Date().toISOString(),
      sync: testRequested ? '서버 API 테스트 대기' : '자격정보 입력됨',
      health: undefined,
    }
    setSavingChannel(true)
    const result = await commitChannelChange((current) => current.some((channel) => channel.id === definition.id)
      ? current.map((channel) => channel.id === definition.id ? next : channel)
      : [...current, next])
    setSavingChannel(false)
    if (!result.ok) return
    setCredentialError('')
    onToast(testRequested
      ? `${definition.name} 입력 형식을 확인했습니다. 실제 API 호출은 서버 커넥터와 Secret Vault 구성 후 실행해야 합니다.`
      : `${definition.name} 자격정보 입력 상태를 저장했습니다. 키 원문은 저장하지 않았습니다.`)
  }

  const disconnectChannel = async (channel: ManagedChannel) => {
    setSavingChannel(true)
    const result = await commitChannelChange((current) => current.filter((item) => item.id !== channel.id))
    setSavingChannel(false)
    if (!result.ok) return
    setChannelDialog('catalog')
    setCredentialDraft({})
    setConfirmDisconnect(false)
    onToast(`${channel.name} 설정을 해제했습니다. 언제든 다시 설정할 수 있습니다.`)
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
  const checkedChannelCount = channels.filter((channel) => Boolean(channel.health)).length
  const respondingChannelCount = channels.filter((channel) => channel.health?.response === 'ok').length

  const visibleShipments = shipments.filter((shipment) => shipmentFilter === 'all' || shipment.status === shipmentFilter)

  return (
    <div className="page-enter business-page sales-channels-page">
      <header className="page-heading business-page-head">
        <div>
          <div className="page-kicker">Commerce hub</div>
          <h1>판매채널 통합</h1>
          <p>{companyName}의 판매자센터·API 자격정보와 연결 준비 상태를 관리합니다. 표시 수치는 연결된 API 또는 업로드 데이터 기준입니다.</p>
        </div>
        <div className="heading-actions">
          <div className="sales-period-switch" role="group" aria-label="판매 조회 기간">
            {salesPeriods.map((item) => (
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
          {canManage && <button className="secondary-button" type="button" onClick={() => setChannelDialog('catalog')}><Plus size={17} aria-hidden="true" /> 채널 연결</button>}
          {canManage && <button className="primary-button" type="button" disabled={Boolean(checkingChannelId)} onClick={() => void runChannelHealthCheck()}>
            <RefreshCw className={checkingChannelId ? 'spin' : ''} size={17} aria-hidden="true" /> {checkingChannelId ? '점검 중…' : '연결 상태 점검'}
          </button>}
        </div>
      </header>

      <BusinessSummaryStrip label={`${periodConfig.label} 판매 요약`} items={[
        { icon: ShoppingBag, label: '주문', value: `${formatNumber(totalOrders)}건`, helper: `${formatNumber(totalUnits)}개 판매` },
        { icon: CircleDollarSign, label: '총매출', value: formatMoney(totalRevenue), helper: channels.length ? '수집 합계' : '수집 대기', tone: 'green' },
        { icon: BarChart3, label: '객단가', value: formatMoney(averageOrder), helper: totalOrders > 0 ? '수집 주문 기준' : '주문 없음', tone: 'blue' },
        { icon: Clock3, label: '상태 점검', value: `${checkedChannelCount} / ${channels.length}`, helper: `API 응답 ${respondingChannelCount}개`, tone: checkedChannelCount === channels.length && channels.length > 0 ? 'green' : 'warning' },
      ]} />

      {healthPanelOpen && <section className="channel-health-panel" aria-labelledby="channel-health-title">
        <header><div><span className="channel-health-icon"><RefreshCw size={18} /></span><div><h2 id="channel-health-title">판매채널 연결 상태</h2><p>저장된 설정만 점검하며 자격정보가 없는 채널은 외부 API를 호출하지 않습니다.</p></div></div><button className="icon-button" type="button" aria-label="상태 점검 결과 닫기" onClick={() => setHealthPanelOpen(false)}><X size={18} /></button></header>
        <div className="channel-health-table" role="table" aria-label="판매채널 상태 점검 결과">
          <div className="channel-health-row header" role="row"><span>채널</span><span>자격정보</span><span>API 응답</span><span>상품 매핑</span><span>마지막 점검</span><span /></div>
          {channels.map((channel) => {
            const health = channel.health
            const credentialLabel = health ? (health.credential === 'ready' ? '입력됨' : '자격정보 없음') : channel.credentialHint ? '입력됨 · 미점검' : '자격정보 없음'
            const mappingLabel = health?.mappingLabel ?? (channel.orders || channel.units ? '수집 데이터 매핑 있음' : '상품 매핑 없음')
            return <div className="channel-health-row" role="row" key={channel.id}>
              <span className="channel-health-name"><i className="channel-mark" style={{ backgroundColor: channelTokenColor(channel.id) }}>{channel.short}</i><strong>{channel.name}</strong></span>
              <span><i className={`health-dot ${health?.credential === 'ready' ? 'ok' : 'muted'}`} />{credentialLabel}</span>
              <span><i className={`health-dot ${health?.response === 'ok' ? 'ok' : health?.response === 'unavailable' ? 'danger' : 'muted'}`} />{health?.responseLabel ?? '아직 점검하지 않음'}</span>
              <span><i className={`health-dot ${health?.mapping === 'ready' ? 'ok' : health?.mapping === 'attention' ? 'warning' : 'muted'}`} />{mappingLabel}</span>
              <span>{health?.checkedAt ? formatDateTime(health.checkedAt) : '—'}</span>
              {canManage ? <button className="channel-health-check" type="button" disabled={Boolean(checkingChannelId)} onClick={() => void runChannelHealthCheck(channel)}>{checkingChannelId === channel.id ? '점검 중' : '점검'}</button> : <span />}
            </div>
          })}
          {channels.length === 0 && <div className="channel-health-empty">점검할 채널이 없습니다. ‘채널 연결’에서 판매채널을 먼저 추가하세요.</div>}
        </div>
      </section>}

      <section className="sales-channel-section" aria-labelledby="channel-status-title">
        <div className="business-section-heading">
          <div><h2 id="channel-status-title">채널 설정과 판매 현황</h2><p>{periodConfig.label} 기준 · 등록된 채널의 수집 데이터를 표시합니다.</p></div>
          <span className="section-live-status setup"><span /> 채널별 연결 상태</span>
        </div>
        <div className="sales-channel-grid">
          {channels.length === 0 && <div className="business-empty-state"><Store size={32} /><h3>{canManage ? '설정한 판매채널이 없습니다' : '판매채널 운영 권한이 필요합니다'}</h3><p>{canManage ? '공식 판매자센터에서 API 권한을 준비한 뒤 자격정보를 등록하세요.' : '자격정보와 주문·배송 데이터는 회사 관리자만 관리할 수 있습니다.'}</p>{canManage && <button className="primary-button" type="button" onClick={() => setChannelDialog('catalog')}><Plus size={17} /> 첫 채널 설정</button>}</div>}
          {channels.map((channel) => {
            const definition = channelDefinition(channel.id)
            const scaledRevenue = channel.revenue * factor
            const performanceWidth = Math.max(8, Math.round((channel.revenue / maxChannelRevenue) * 100))
            return (
              <article className={`sales-channel-card ${channel.status === '주의' ? 'warning' : ''}`} key={channel.id}>
                <div className="sales-channel-card-head">
                  <span className="channel-mark large" style={{ backgroundColor: channelTokenColor(channel.id) }}>{channel.short}</span>
                  <div><h3>{channel.name}</h3><p>{channel.orders || channel.units ? '판매 데이터 수집됨' : '판매 데이터 수집 전'}</p></div>
                  <span className={`connection-status ${channel.connectionStatus ?? 'setup-required'}`}>{connectionLabel(channel)}</span>
                </div>
                <div className="channel-revenue">
                  <span>결제 매출</span>
                  <strong>{formatMoney(scaledRevenue)}</strong>
                  <em className={channel.delta >= 0 ? 'up' : 'down'}>
                    {channel.delta >= 0 ? <TrendingUp size={15} aria-hidden="true" /> : <TrendingDown size={15} aria-hidden="true" />}
                    {channel.delta >= 0 ? '+' : ''}{channel.delta}%
                  </em>
                </div>
                <div className="channel-performance-bar" aria-label={`최고 채널 대비 매출 ${performanceWidth}%`}>
                  <span style={{ width: `${performanceWidth}%`, backgroundColor: channelTokenColor(channel.id) }} />
                </div>
                <div className="channel-card-metrics">
                  <div><span>주문</span><strong>{formatNumber(channel.orders * factor)}건</strong></div>
                  <div><span>판매수량</span><strong>{formatNumber(channel.units * factor)}개</strong></div>
                </div>
                <div className="channel-card-actions">
                  {definition && <a href={definition.sellerUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /> 판매자센터</a>}
                  {canManage && <button className="channel-sync-button" type="button" onClick={() => openChannelSetup(channel.id)}>
                    <KeyRound size={16} aria-hidden="true" /> {channel.connectionStatus === 'setup-required' ? '연결 설정' : '재연결 설정'}
                  </button>}
                  {canManage && <button className="channel-health-card-button" type="button" disabled={Boolean(checkingChannelId)} onClick={() => void runChannelHealthCheck(channel)}><RefreshCw size={15} /> 상태 점검</button>}
                  {canManage && definition && <button className="channel-remove-button" type="button" aria-label={`${channel.name} 채널 해제`} onClick={() => { openChannelSetup(channel.id); setConfirmDisconnect(true) }}><Trash2 size={15} /> 해제</button>}
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
            <button className="text-action-button" type="button" onClick={downloadShipmentTemplate}>CSV 양식</button>
            <input ref={shipmentFileRef} className="sr-only" type="file" accept=".csv,text/csv" onChange={(event) => void importShipmentCsv(event.target.files?.[0])} />
            <button className="secondary-button" type="button" onClick={() => shipmentFileRef.current?.click()}><FileUp size={17} /> 주문 CSV 가져오기</button>
            <button className="primary-button" type="button" onClick={() => setShipmentDialog('new')}><Plus size={17} /> 배송 주문 등록</button>
          </div>}
        </div>
        <div className="shipment-integration-note">
          <Truck size={19} aria-hidden="true" />
          <div><strong>현재는 수기·CSV 출고가 즉시 동작합니다.</strong><span>채널 주문 자동수집, 택배사 규격 바코드와 집하 접수는 각 사업자 계약·API 키·서버 커넥터가 준비된 뒤 활성화됩니다.</span></div>
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
                <button className="secondary-button" type="button" onClick={() => setShipmentDialog(shipment.id)}>{shipment.trackingNo ? '송장 수정' : '송장 등록'}</button>
                <button className="icon-button" type="button" aria-label={`${shipment.orderNo} 송장 인쇄`} disabled={!shipment.trackingNo} onClick={() => printShippingLabel(shipment)}><Printer size={17} /></button>
                {shipment.status !== '출고완료' && <button className="icon-button" type="button" aria-label={`${shipment.orderNo} 출고 완료`} disabled={!shipment.trackingNo} onClick={() => void completeShipment(shipment)}><CheckCircle2 size={17} /></button>}
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
          <header><div><span className="page-kicker">CHANNEL CONNECT</span><h2 id="channel-connect-title">{selectedDefinition ? `${selectedDefinition.name} 연결 설정` : '판매채널 선택'}</h2><p>{selectedDefinition ? selectedDefinition.accessNote : '공식 판매자센터와 API 문서를 확인한 뒤 자격정보를 준비하세요.'}</p></div><button className="icon-button" type="button" aria-label="닫기" disabled={savingChannel} onClick={() => setChannelDialog(null)}><X size={21} /></button></header>
          {channelDialog === 'catalog' && <>
            <div className="integration-truth-banner"><ShieldCheck size={20} /><div><strong>실 API 자격정보가 없으면 연결 완료로 표시하지 않습니다.</strong><p>연결되지 않은 채널은 주문·매출 수치를 0으로 표시하며 운영 데이터로 추정하지 않습니다.</p></div></div>
            <div className="channel-catalog">{channelDefinitions.map((definition) => {
              const existing = channels.find((channel) => channel.id === definition.id)
              return <button className={existing ? 'configured' : ''} type="button" key={definition.id} onClick={() => openChannelSetup(definition.id)}>
                <span className="channel-mark large" style={{ backgroundColor: definition.color }}>{definition.short}</span>
                <div><strong>{definition.name}</strong><small>{existing ? `목록에 추가됨 · ${connectionLabel(existing)}` : `${definition.authMode} · 추가 가능`}</small></div>
                {existing ? <CheckCircle2 size={19} /> : <ChevronRight size={19} />}
              </button>
            })}</div>
            <footer><span><ExternalLink size={17} /> 외부 링크는 각 플랫폼의 공식 센터로 열립니다.</span><button className="secondary-button" type="button" onClick={() => setChannelDialog(null)}>닫기</button></footer>
          </>}
          {selectedDefinition && <>
            <div className="channel-connect-steps"><span className="done">1. 채널 선택</span><i /><span className="active">2. 자격정보</span><i /><span>3. 서버 테스트</span></div>
            <div className="channel-setup-scroll">
              <div className="channel-resource-links">
                <a href={selectedDefinition.sellerUrl} target="_blank" rel="noreferrer"><Store size={18} /><span><strong>판매자센터 열기</strong><small>계정·API 권한 준비</small></span><ExternalLink size={16} /></a>
                <a href={selectedDefinition.docsUrl} target="_blank" rel="noreferrer"><FileCheck2 size={18} /><span><strong>공식 API 문서</strong><small>{selectedDefinition.authMode}</small></span><ExternalLink size={16} /></a>
              </div>
              <section className="channel-checklist" aria-labelledby="channel-checklist-title">
                <div><h3 id="channel-checklist-title">연결 전 체크리스트</h3><span>{selectedDefinition.checklist.length}단계</span></div>
                <ol>{selectedDefinition.checklist.map((item) => <li key={item}><CheckCircle2 size={17} /> {item}</li>)}</ol>
              </section>
              <section className="channel-credential-panel" aria-labelledby="channel-credentials-title">
                <div><h3 id="channel-credentials-title">OAuth / API 자격정보</h3><span className={`connection-status ${selectedChannel?.connectionStatus ?? 'setup-required'}`}>{selectedChannel ? connectionLabel(selectedChannel) : '설정 필요'}</span></div>
                <div className="channel-credential-grid">
                  {selectedDefinition.fields.map((field) => <label className="form-field" key={field.id}><span>{field.label} *</span><input type={field.secret ? 'password' : 'text'} value={credentialDraft[field.id] ?? ''} placeholder={field.placeholder} autoComplete="off" onChange={(event) => { setCredentialDraft((current) => ({ ...current, [field.id]: event.target.value })); setCredentialError('') }} />{field.secret && selectedChannel?.credentialHint && <small>저장된 키 식별값 {selectedChannel.credentialHint} · 원문은 다시 입력해야 합니다.</small>}</label>)}
                </div>
                {credentialError && <div className="channel-credential-error" role="alert"><AlertTriangle size={17} /> {credentialError}</div>}
                <div className="credential-security-note"><KeyRound size={18} /><p><strong>이 로컬 버전은 Secret 원문을 저장하지 않습니다.</strong><span>실제 연결에는 서버 커넥터, 암호화 Secret Vault와 OAuth Redirect 설정이 필요합니다.</span></p></div>
                {selectedChannel?.checkedAt && <div className="connection-test-status"><Clock3 size={17} /><span>최근 입력 점검 {formatDateTime(selectedChannel.checkedAt)}</span><strong>{connectionLabel(selectedChannel)}</strong></div>}
              </section>
            </div>
            <footer className="channel-setup-footer">
              <div>{selectedChannel && <button className="danger-text-button" type="button" disabled={savingChannel} onClick={() => confirmDisconnect ? void disconnectChannel(selectedChannel) : setConfirmDisconnect(true)}><Trash2 size={16} /> {confirmDisconnect ? '한 번 더 눌러 해제' : '연결 설정 해제'}</button>}</div>
              <div><button className="secondary-button" type="button" disabled={savingChannel} onClick={() => setChannelDialog('catalog')}>채널 목록</button>{!selectedChannel && <button className="secondary-button" type="button" disabled={savingChannel} onClick={() => void addChannelToList(selectedDefinition)}>목록에 추가</button>}<button className="secondary-button" type="button" disabled={savingChannel} onClick={() => void saveChannelCredentials(selectedDefinition, false)}>자격정보 저장</button><button className="primary-button" type="button" disabled={savingChannel} onClick={() => void saveChannelCredentials(selectedDefinition, true)}>{savingChannel ? '확인 중…' : '입력 형식 점검'}</button></div>
            </footer>
          </>}
        </section>
      </div>}
    </div>
  )
}
