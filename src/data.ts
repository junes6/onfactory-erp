export type ProductCategory = '완제품' | '반제품' | '원재료' | '포장재'
export type ProductStatus = '정상' | '주의' | '품절' | '단종'

export interface Product {
  id: string
  code: string
  name: string
  category: ProductCategory
  specification: string
  unit: 'EA' | 'BOX' | 'kg' | 'L' | 'ROLL'
  supplier: string
  currentStock: number
  safetyStock: number
  unitPrice: number
  shelfLifeDays: number | null
  allergens: string[]
  storage: string
  status: ProductStatus
  lastUpdated: string
}

export type LabelReviewStatus = '검토대기' | 'AI 검토중' | '수정요청' | '승인완료'
export type RiskLevel = '높음' | '보통' | '낮음'

export interface LabelIssue {
  field: string
  message: string
  suggestion: string
}

export interface LabelReview {
  id: string
  productId: string
  productCode: string
  productName: string
  version: string
  packageType: string
  requestedBy: string
  requestedAt: string
  dueDate: string
  reviewer: string
  status: LabelReviewStatus
  riskLevel: RiskLevel
  issueCount: number
  aiScore: number
  summary: string
  issues: LabelIssue[]
}

export type PurchaseOrderStatus = '작성중' | '승인대기' | '발주완료' | '부분입고' | '입고완료' | '지연'

export interface PurchaseOrder {
  id: string
  orderNo: string
  supplier: string
  itemCode: string
  itemName: string
  quantity: number
  receivedQuantity: number
  unit: 'EA' | 'BOX' | 'kg' | 'L' | 'ROLL'
  unitPrice: number
  amount: number
  orderDate: string
  expectedDate: string
  manager: string
  status: PurchaseOrderStatus
  progress: number
  note: string
}

export type TaskStatus = '대기' | '진행중' | '검토중' | '완료' | '지연'
export type TaskPriority = '긴급' | '높음' | '보통' | '낮음'
export type TaskType = '생산' | '품질' | '구매' | '물류' | '표시사항' | '설비'

export interface WorkTask {
  id: string
  title: string
  type: TaskType
  process: string
  productName: string
  assignee: string
  team: string
  startAt: string
  dueAt: string
  priority: TaskPriority
  status: TaskStatus
  progress: number
  aiAssigned: boolean
  description: string
}

export type LotStatus = '정상' | '임박' | '보류' | '폐기대상'
export type InspectionStatus = '적합' | '검사대기' | '재검사' | '부적합'

export interface InventoryLot {
  id: string
  lotNo: string
  itemCode: string
  itemName: string
  category: ProductCategory
  warehouse: string
  location: string
  quantity: number
  availableQuantity: number
  unit: 'EA' | 'BOX' | 'kg' | 'L' | 'ROLL'
  manufacturedAt: string
  receivedAt: string
  expiresAt: string | null
  daysToExpire: number | null
  status: LotStatus
  inspectionStatus: InspectionStatus
}

export type SalesOrderStatus = '주문접수' | '출고준비' | '부분출고' | '배송중' | '납품완료' | '보류'
export type SalesChannel = 'B2B' | '온라인' | '대리점' | '급식'

export interface SalesOrderItem {
  productCode: string
  productName: string
  quantity: number
  unit: 'EA' | 'BOX'
  unitPrice: number
}

export interface SalesOrder {
  id: string
  orderNo: string
  customer: string
  channel: SalesChannel
  items: SalesOrderItem[]
  itemSummary: string
  totalQuantity: number
  orderAmount: number
  orderDate: string
  requestedDeliveryDate: string
  deliveryAddress: string
  salesManager: string
  status: SalesOrderStatus
  paymentStatus: '결제대기' | '일부결제' | '결제완료' | '후불'
}

export type EmployeeWorkStatus = '근무중' | '휴게중' | '외근' | '연차' | '퇴근' | '결근'

export interface Employee {
  id: string
  employeeNo: string
  name: string
  department: string
  position: string
  role: string
  shift: '주간' | '야간' | '일반'
  workStatus: EmployeeWorkStatus
  checkIn: string | null
  checkOut: string | null
  todayHours: number
  monthlyHours: number
  attendanceRate: number
  phone: string
  email: string
  joinedAt: string
  assignedTask: string
}

export type AIReviewCategory = '표시사항' | '재고' | '발주' | '생산' | '품질' | '인사' | '판매'
export type AIReviewStatus = '검토필요' | '담당자확인' | '처리중' | '해결'
export type AISeverity = '위험' | '주의' | '제안'

export interface AIReviewItem {
  id: string
  category: AIReviewCategory
  title: string
  targetId: string
  targetName: string
  description: string
  suggestion: string
  reason: string
  severity: AISeverity
  confidence: number
  status: AIReviewStatus
  assignee: string
  createdAt: string
  dueAt: string
}

export const products: Product[] = [
  {
    id: 'PRD-001',
    code: 'FG-BLG-500',
    name: '한결 소불고기 500g',
    category: '완제품',
    specification: '500g × 20팩 / BOX',
    unit: 'EA',
    supplier: '자체생산',
    currentStock: 2840,
    safetyStock: 1200,
    unitPrice: 8900,
    shelfLifeDays: 12,
    allergens: ['쇠고기', '대두', '밀'],
    storage: '냉장(0~10℃)',
    status: '정상',
    lastUpdated: '2026-08-18 14:32',
  },
  {
    id: 'PRD-002',
    code: 'FG-DCK-350',
    name: '매콤 닭갈비 350g',
    category: '완제품',
    specification: '350g × 24팩 / BOX',
    unit: 'EA',
    supplier: '자체생산',
    currentStock: 760,
    safetyStock: 900,
    unitPrice: 6900,
    shelfLifeDays: 10,
    allergens: ['닭고기', '대두', '밀'],
    storage: '냉장(0~10℃)',
    status: '주의',
    lastUpdated: '2026-08-18 14:26',
  },
  {
    id: 'PRD-003',
    code: 'FG-JEY-200',
    name: '직화 제육볶음 200g',
    category: '완제품',
    specification: '200g × 30팩 / BOX',
    unit: 'EA',
    supplier: '자체생산',
    currentStock: 1860,
    safetyStock: 1000,
    unitPrice: 4900,
    shelfLifeDays: 12,
    allergens: ['돼지고기', '대두', '밀'],
    storage: '냉장(0~10℃)',
    status: '정상',
    lastUpdated: '2026-08-18 13:54',
  },
  {
    id: 'PRD-004',
    code: 'SF-BLG-SAUCE',
    name: '불고기 양념 베이스',
    category: '반제품',
    specification: '10kg / PE통',
    unit: 'kg',
    supplier: '자체생산',
    currentStock: 168,
    safetyStock: 120,
    unitPrice: 5600,
    shelfLifeDays: 30,
    allergens: ['대두', '밀'],
    storage: '냉장(0~10℃)',
    status: '정상',
    lastUpdated: '2026-08-18 12:41',
  },
  {
    id: 'PRD-005',
    code: 'RM-BEEF-02',
    name: '호주산 소고기 앞다리',
    category: '원재료',
    specification: '냉장 / 진공포장',
    unit: 'kg',
    supplier: '대산축산유통',
    currentStock: 436,
    safetyStock: 300,
    unitPrice: 13800,
    shelfLifeDays: 20,
    allergens: ['쇠고기'],
    storage: '냉장(-2~5℃)',
    status: '정상',
    lastUpdated: '2026-08-18 10:18',
  },
  {
    id: 'PRD-006',
    code: 'RM-GCHJ-01',
    name: '태양초 고추장',
    category: '원재료',
    specification: '20kg / 말통',
    unit: 'kg',
    supplier: '우리장식품',
    currentStock: 74,
    safetyStock: 100,
    unitPrice: 4200,
    shelfLifeDays: 365,
    allergens: ['대두', '밀'],
    storage: '실온(1~35℃)',
    status: '주의',
    lastUpdated: '2026-08-18 09:45',
  },
  {
    id: 'PRD-007',
    code: 'PM-TRAY-500',
    name: 'PP 실링용기 500호',
    category: '포장재',
    specification: '500개 / BOX',
    unit: 'EA',
    supplier: '그린패키지',
    currentStock: 9200,
    safetyStock: 10000,
    unitPrice: 118,
    shelfLifeDays: null,
    allergens: [],
    storage: '포장재 창고 / 건조',
    status: '주의',
    lastUpdated: '2026-08-18 11:07',
  },
  {
    id: 'PRD-008',
    code: 'PM-FILM-BLG',
    name: '소불고기 상단필름',
    category: '포장재',
    specification: '폭 320mm × 500m',
    unit: 'ROLL',
    supplier: '세광인쇄',
    currentStock: 18,
    safetyStock: 12,
    unitPrice: 146000,
    shelfLifeDays: null,
    allergens: [],
    storage: '포장재 창고 / 차광',
    status: '정상',
    lastUpdated: '2026-08-18 11:02',
  },
]

export const labelReviews: LabelReview[] = [
  {
    id: 'LR-260818-01',
    productId: 'PRD-002',
    productCode: 'FG-DCK-350',
    productName: '매콤 닭갈비 350g',
    version: 'v3.2',
    packageType: '상단필름',
    requestedBy: '김다은',
    requestedAt: '2026-08-18 09:12',
    dueDate: '2026-08-19',
    reviewer: '박지현',
    status: '수정요청',
    riskLevel: '높음',
    issueCount: 2,
    aiScore: 68,
    summary: '원재료명 알레르기 유발물질과 나트륨 기준치 표기 확인이 필요합니다.',
    issues: [
      {
        field: '알레르기 표시',
        message: '복합원재료인 고추장에 포함된 밀 표기가 누락되었습니다.',
        suggestion: '알레르기 문구에 “대두, 밀, 닭고기 함유”를 반영하세요.',
      },
      {
        field: '영양정보',
        message: '나트륨 1일 영양성분 기준치 비율이 시험성적서와 다릅니다.',
        suggestion: '나트륨 780mg, 39%로 정정하세요.',
      },
    ],
  },
  {
    id: 'LR-260818-02',
    productId: 'PRD-001',
    productCode: 'FG-BLG-500',
    productName: '한결 소불고기 500g',
    version: 'v5.0',
    packageType: '띠지',
    requestedBy: '윤서진',
    requestedAt: '2026-08-18 10:05',
    dueDate: '2026-08-20',
    reviewer: '이정민',
    status: 'AI 검토중',
    riskLevel: '보통',
    issueCount: 1,
    aiScore: 84,
    summary: '온라인 전용 띠지 시안의 소비기한 표기 위치를 검토 중입니다.',
    issues: [
      {
        field: '소비기한',
        message: '별도 표기 위치에 대한 안내 문구가 불명확합니다.',
        suggestion: '“소비기한: 용기 측면 별도표기일까지”로 통일하세요.',
      },
    ],
  },
  {
    id: 'LR-260817-04',
    productId: 'PRD-003',
    productCode: 'FG-JEY-200',
    productName: '직화 제육볶음 200g',
    version: 'v2.6',
    packageType: '파우치',
    requestedBy: '김다은',
    requestedAt: '2026-08-17 15:44',
    dueDate: '2026-08-19',
    reviewer: '박지현',
    status: '검토대기',
    riskLevel: '낮음',
    issueCount: 0,
    aiScore: 96,
    summary: '디자인 개편에 따른 글자 크기와 의무표시 영역의 최종 확인이 남았습니다.',
    issues: [],
  },
  {
    id: 'LR-260816-03',
    productId: 'PRD-001',
    productCode: 'FG-BLG-500',
    productName: '한결 소불고기 500g',
    version: 'v4.9',
    packageType: '상단필름',
    requestedBy: '윤서진',
    requestedAt: '2026-08-16 11:20',
    dueDate: '2026-08-18',
    reviewer: '이정민',
    status: '승인완료',
    riskLevel: '낮음',
    issueCount: 0,
    aiScore: 99,
    summary: '법정 의무표시 및 내부 원재료 DB 대조를 통과했습니다.',
    issues: [],
  },
  {
    id: 'LR-260815-02',
    productId: 'PRD-004',
    productCode: 'SF-BLG-SAUCE',
    productName: '불고기 양념 베이스',
    version: 'v1.4',
    packageType: '라벨 스티커',
    requestedBy: '최유진',
    requestedAt: '2026-08-15 14:08',
    dueDate: '2026-08-18',
    reviewer: '박지현',
    status: '수정요청',
    riskLevel: '보통',
    issueCount: 1,
    aiScore: 77,
    summary: 'B2B 납품용 제품의 보관조건 문구가 제조지시서와 일치하지 않습니다.',
    issues: [
      {
        field: '보관방법',
        message: '표시 시안은 0~5℃, 제조규격서는 0~10℃로 기재되어 있습니다.',
        suggestion: '품질팀 확인 후 승인 규격으로 두 문서를 일치시키세요.',
      },
    ],
  },
]

export const purchaseOrders: PurchaseOrder[] = [
  {
    id: 'PO-001',
    orderNo: 'PO-260818-014',
    supplier: '우리장식품',
    itemCode: 'RM-GCHJ-01',
    itemName: '태양초 고추장',
    quantity: 400,
    receivedQuantity: 0,
    unit: 'kg',
    unitPrice: 4200,
    amount: 1680000,
    orderDate: '2026-08-18',
    expectedDate: '2026-08-20',
    manager: '정민수',
    status: '발주완료',
    progress: 35,
    note: '닭갈비 생산계획 증가분 반영',
  },
  {
    id: 'PO-002',
    orderNo: 'PO-260818-013',
    supplier: '그린패키지',
    itemCode: 'PM-TRAY-500',
    itemName: 'PP 실링용기 500호',
    quantity: 20000,
    receivedQuantity: 0,
    unit: 'EA',
    unitPrice: 118,
    amount: 2360000,
    orderDate: '2026-08-18',
    expectedDate: '2026-08-21',
    manager: '정민수',
    status: '승인대기',
    progress: 15,
    note: '안전재고 미달 자동 발주 제안',
  },
  {
    id: 'PO-003',
    orderNo: 'PO-260817-011',
    supplier: '대산축산유통',
    itemCode: 'RM-BEEF-02',
    itemName: '호주산 소고기 앞다리',
    quantity: 600,
    receivedQuantity: 300,
    unit: 'kg',
    unitPrice: 13800,
    amount: 8280000,
    orderDate: '2026-08-17',
    expectedDate: '2026-08-18',
    manager: '한예린',
    status: '부분입고',
    progress: 72,
    note: '2차 300kg 17시 도착 예정',
  },
  {
    id: 'PO-004',
    orderNo: 'PO-260814-008',
    supplier: '세광인쇄',
    itemCode: 'PM-FILM-BLG',
    itemName: '소불고기 상단필름',
    quantity: 30,
    receivedQuantity: 0,
    unit: 'ROLL',
    unitPrice: 146000,
    amount: 4380000,
    orderDate: '2026-08-14',
    expectedDate: '2026-08-18',
    manager: '한예린',
    status: '지연',
    progress: 48,
    note: '인쇄 색상 재조정으로 납기 1일 지연',
  },
  {
    id: 'PO-005',
    orderNo: 'PO-260812-004',
    supplier: '청정농산',
    itemCode: 'RM-ONION-01',
    itemName: '국산 양파',
    quantity: 800,
    receivedQuantity: 800,
    unit: 'kg',
    unitPrice: 1450,
    amount: 1160000,
    orderDate: '2026-08-12',
    expectedDate: '2026-08-16',
    manager: '정민수',
    status: '입고완료',
    progress: 100,
    note: '수입검사 적합 / 정상 입고',
  },
]

export const workTasks: WorkTask[] = [
  {
    id: 'TASK-260818-01',
    title: '소불고기 3차 배합 및 가열',
    type: '생산',
    process: '배합·가열',
    productName: '한결 소불고기 500g',
    assignee: '오태식',
    team: '생산1팀',
    startAt: '2026-08-18 13:30',
    dueAt: '2026-08-18 16:30',
    priority: '높음',
    status: '진행중',
    progress: 64,
    aiAssigned: true,
    description: 'SO-260818-022 긴급 물량 600팩 생산분',
  },
  {
    id: 'TASK-260818-02',
    title: '닭갈비 표시사항 수정본 확인',
    type: '표시사항',
    process: '표시 검증',
    productName: '매콤 닭갈비 350g',
    assignee: '박지현',
    team: '품질관리팀',
    startAt: '2026-08-18 14:00',
    dueAt: '2026-08-19 11:00',
    priority: '긴급',
    status: '검토중',
    progress: 45,
    aiAssigned: true,
    description: '알레르기 및 영양정보 수정 시안 재검증',
  },
  {
    id: 'TASK-260818-03',
    title: '입고 소고기 미생물 신속검사',
    type: '품질',
    process: '수입검사',
    productName: '호주산 소고기 앞다리',
    assignee: '이정민',
    team: '품질관리팀',
    startAt: '2026-08-18 10:30',
    dueAt: '2026-08-18 15:30',
    priority: '높음',
    status: '진행중',
    progress: 80,
    aiAssigned: false,
    description: 'LOT BFA-260816-7 입고 300kg 검사',
  },
  {
    id: 'TASK-260818-04',
    title: '냉장 2창고 소비기한 임박품 이동',
    type: '물류',
    process: '재고 이동',
    productName: '직화 제육볶음 200g',
    assignee: '서동현',
    team: '물류팀',
    startAt: '2026-08-18 15:00',
    dueAt: '2026-08-18 17:00',
    priority: '보통',
    status: '대기',
    progress: 0,
    aiAssigned: true,
    description: 'FEFO 출고를 위해 A-03 로케이션으로 420팩 이동',
  },
  {
    id: 'TASK-260818-05',
    title: '2호 실링기 예방점검',
    type: '설비',
    process: '예방보전',
    productName: '공통',
    assignee: '강성호',
    team: '공무팀',
    startAt: '2026-08-18 09:00',
    dueAt: '2026-08-18 12:00',
    priority: '보통',
    status: '완료',
    progress: 100,
    aiAssigned: false,
    description: '히터·실링압·안전센서 월간 예방점검',
  },
  {
    id: 'TASK-260817-06',
    title: '상단필름 납기 지연 대체재 확인',
    type: '구매',
    process: '협력사 관리',
    productName: '소불고기 상단필름',
    assignee: '한예린',
    team: '구매팀',
    startAt: '2026-08-17 16:00',
    dueAt: '2026-08-18 10:00',
    priority: '긴급',
    status: '지연',
    progress: 70,
    aiAssigned: true,
    description: '생산 중단 방지를 위한 호환 필름 재고 및 퀵 납품 확인',
  },
]

export const inventoryLots: InventoryLot[] = [
  {
    id: 'LOT-001',
    lotNo: 'BLG-260818-B2',
    itemCode: 'FG-BLG-500',
    itemName: '한결 소불고기 500g',
    category: '완제품',
    warehouse: '냉장 1창고',
    location: 'A-01-02',
    quantity: 1200,
    availableQuantity: 1200,
    unit: 'EA',
    manufacturedAt: '2026-08-18',
    receivedAt: '2026-08-18 12:20',
    expiresAt: '2026-08-30',
    daysToExpire: 12,
    status: '정상',
    inspectionStatus: '적합',
  },
  {
    id: 'LOT-002',
    lotNo: 'DCK-260815-A1',
    itemCode: 'FG-DCK-350',
    itemName: '매콤 닭갈비 350g',
    category: '완제품',
    warehouse: '냉장 1창고',
    location: 'A-04-03',
    quantity: 760,
    availableQuantity: 760,
    unit: 'EA',
    manufacturedAt: '2026-08-15',
    receivedAt: '2026-08-15 17:10',
    expiresAt: '2026-08-25',
    daysToExpire: 7,
    status: '임박',
    inspectionStatus: '적합',
  },
  {
    id: 'LOT-003',
    lotNo: 'JEY-260811-C1',
    itemCode: 'FG-JEY-200',
    itemName: '직화 제육볶음 200g',
    category: '완제품',
    warehouse: '냉장 2창고',
    location: 'B-07-01',
    quantity: 420,
    availableQuantity: 420,
    unit: 'EA',
    manufacturedAt: '2026-08-11',
    receivedAt: '2026-08-11 15:42',
    expiresAt: '2026-08-23',
    daysToExpire: 5,
    status: '임박',
    inspectionStatus: '적합',
  },
  {
    id: 'LOT-004',
    lotNo: 'BFA-260816-7',
    itemCode: 'RM-BEEF-02',
    itemName: '호주산 소고기 앞다리',
    category: '원재료',
    warehouse: '원료 냉장고',
    location: 'R-02-04',
    quantity: 300,
    availableQuantity: 0,
    unit: 'kg',
    manufacturedAt: '2026-08-16',
    receivedAt: '2026-08-18 09:50',
    expiresAt: '2026-09-05',
    daysToExpire: 18,
    status: '보류',
    inspectionStatus: '검사대기',
  },
  {
    id: 'LOT-005',
    lotNo: 'GCH-260401-12',
    itemCode: 'RM-GCHJ-01',
    itemName: '태양초 고추장',
    category: '원재료',
    warehouse: '상온 원료창고',
    location: 'D-03-05',
    quantity: 74,
    availableQuantity: 74,
    unit: 'kg',
    manufacturedAt: '2026-04-01',
    receivedAt: '2026-04-08 13:20',
    expiresAt: '2027-04-01',
    daysToExpire: 226,
    status: '정상',
    inspectionStatus: '적합',
  },
  {
    id: 'LOT-006',
    lotNo: 'TR500-260805-03',
    itemCode: 'PM-TRAY-500',
    itemName: 'PP 실링용기 500호',
    category: '포장재',
    warehouse: '포장재 창고',
    location: 'P-01-08',
    quantity: 9200,
    availableQuantity: 9000,
    unit: 'EA',
    manufacturedAt: '2026-08-05',
    receivedAt: '2026-08-07 11:15',
    expiresAt: null,
    daysToExpire: null,
    status: '정상',
    inspectionStatus: '적합',
  },
  {
    id: 'LOT-007',
    lotNo: 'SAU-260812-A1',
    itemCode: 'SF-BLG-SAUCE',
    itemName: '불고기 양념 베이스',
    category: '반제품',
    warehouse: '반제품 냉장고',
    location: 'S-02-01',
    quantity: 48,
    availableQuantity: 0,
    unit: 'kg',
    manufacturedAt: '2026-08-12',
    receivedAt: '2026-08-12 16:45',
    expiresAt: '2026-09-11',
    daysToExpire: 24,
    status: '보류',
    inspectionStatus: '재검사',
  },
]

export const salesOrders: SalesOrder[] = [
  {
    id: 'SO-001',
    orderNo: 'SO-260818-022',
    customer: '푸른마켓 수도권센터',
    channel: 'B2B',
    items: [
      { productCode: 'FG-BLG-500', productName: '한결 소불고기 500g', quantity: 1200, unit: 'EA', unitPrice: 8900 },
      { productCode: 'FG-JEY-200', productName: '직화 제육볶음 200g', quantity: 900, unit: 'EA', unitPrice: 4900 },
    ],
    itemSummary: '한결 소불고기 외 1종',
    totalQuantity: 2100,
    orderAmount: 15090000,
    orderDate: '2026-08-18',
    requestedDeliveryDate: '2026-08-19',
    deliveryAddress: '경기 이천시 마장면 물류로 45',
    salesManager: '윤서진',
    status: '출고준비',
    paymentStatus: '후불',
  },
  {
    id: 'SO-002',
    orderNo: 'SO-260818-019',
    customer: '온담 온라인몰',
    channel: '온라인',
    items: [
      { productCode: 'FG-BLG-500', productName: '한결 소불고기 500g', quantity: 420, unit: 'EA', unitPrice: 9400 },
    ],
    itemSummary: '한결 소불고기 500g',
    totalQuantity: 420,
    orderAmount: 3948000,
    orderDate: '2026-08-18',
    requestedDeliveryDate: '2026-08-19',
    deliveryAddress: '경기 김포시 고촌읍 아라육로 78',
    salesManager: '김다은',
    status: '주문접수',
    paymentStatus: '결제완료',
  },
  {
    id: 'SO-003',
    orderNo: 'SO-260817-016',
    customer: '새봄푸드서비스',
    channel: '급식',
    items: [
      { productCode: 'FG-DCK-350', productName: '매콤 닭갈비 350g', quantity: 800, unit: 'EA', unitPrice: 6300 },
      { productCode: 'FG-JEY-200', productName: '직화 제육볶음 200g', quantity: 1200, unit: 'EA', unitPrice: 4400 },
    ],
    itemSummary: '매콤 닭갈비 외 1종',
    totalQuantity: 2000,
    orderAmount: 10320000,
    orderDate: '2026-08-17',
    requestedDeliveryDate: '2026-08-20',
    deliveryAddress: '서울 송파구 충민로 66',
    salesManager: '윤서진',
    status: '보류',
    paymentStatus: '후불',
  },
  {
    id: 'SO-004',
    orderNo: 'SO-260816-011',
    customer: '정담식자재 대전점',
    channel: '대리점',
    items: [
      { productCode: 'FG-BLG-500', productName: '한결 소불고기 500g', quantity: 40, unit: 'BOX', unitPrice: 168000 },
      { productCode: 'FG-DCK-350', productName: '매콤 닭갈비 350g', quantity: 30, unit: 'BOX', unitPrice: 151200 },
    ],
    itemSummary: '한결 소불고기 외 1종',
    totalQuantity: 70,
    orderAmount: 11256000,
    orderDate: '2026-08-16',
    requestedDeliveryDate: '2026-08-18',
    deliveryAddress: '대전 대덕구 한밭대로 1033',
    salesManager: '최유진',
    status: '배송중',
    paymentStatus: '일부결제',
  },
  {
    id: 'SO-005',
    orderNo: 'SO-260814-007',
    customer: '미래리테일 부산센터',
    channel: 'B2B',
    items: [
      { productCode: 'FG-JEY-200', productName: '직화 제육볶음 200g', quantity: 2400, unit: 'EA', unitPrice: 4550 },
    ],
    itemSummary: '직화 제육볶음 200g',
    totalQuantity: 2400,
    orderAmount: 10920000,
    orderDate: '2026-08-14',
    requestedDeliveryDate: '2026-08-17',
    deliveryAddress: '부산 강서구 유통단지1로 41',
    salesManager: '최유진',
    status: '납품완료',
    paymentStatus: '후불',
  },
]

export const employees: Employee[] = [
  {
    id: 'EMP-001',
    employeeNo: 'HGF-19012',
    name: '오태식',
    department: '생산1팀',
    position: '반장',
    role: '배합·가열 책임자',
    shift: '주간',
    workStatus: '근무중',
    checkIn: '07:52',
    checkOut: null,
    todayHours: 6.7,
    monthlyHours: 126.5,
    attendanceRate: 98.6,
    phone: '010-4821-7730',
    email: 'ts.oh@hangyeolfood.co.kr',
    joinedAt: '2019-03-11',
    assignedTask: '소불고기 3차 배합 및 가열',
  },
  {
    id: 'EMP-002',
    employeeNo: 'HGF-21007',
    name: '박지현',
    department: '품질관리팀',
    position: '대리',
    role: '표시사항·HACCP',
    shift: '일반',
    workStatus: '근무중',
    checkIn: '08:34',
    checkOut: null,
    todayHours: 6.0,
    monthlyHours: 121.0,
    attendanceRate: 100,
    phone: '010-3375-9012',
    email: 'jh.park@hangyeolfood.co.kr',
    joinedAt: '2021-02-15',
    assignedTask: '닭갈비 표시사항 수정본 확인',
  },
  {
    id: 'EMP-003',
    employeeNo: 'HGF-20018',
    name: '이정민',
    department: '품질관리팀',
    position: '주임',
    role: '수입·공정검사',
    shift: '주간',
    workStatus: '근무중',
    checkIn: '07:58',
    checkOut: null,
    todayHours: 6.6,
    monthlyHours: 128.3,
    attendanceRate: 99.2,
    phone: '010-5290-1184',
    email: 'jm.lee@hangyeolfood.co.kr',
    joinedAt: '2020-08-03',
    assignedTask: '입고 소고기 미생물 신속검사',
  },
  {
    id: 'EMP-004',
    employeeNo: 'HGF-22023',
    name: '서동현',
    department: '물류팀',
    position: '사원',
    role: '입출고·재고관리',
    shift: '주간',
    workStatus: '휴게중',
    checkIn: '08:01',
    checkOut: null,
    todayHours: 6.5,
    monthlyHours: 132.0,
    attendanceRate: 97.8,
    phone: '010-7644-2309',
    email: 'dh.seo@hangyeolfood.co.kr',
    joinedAt: '2022-05-09',
    assignedTask: '냉장 2창고 소비기한 임박품 이동',
  },
  {
    id: 'EMP-005',
    employeeNo: 'HGF-18004',
    name: '강성호',
    department: '공무팀',
    position: '과장',
    role: '설비·유틸리티',
    shift: '일반',
    workStatus: '외근',
    checkIn: '08:22',
    checkOut: null,
    todayHours: 6.2,
    monthlyHours: 119.7,
    attendanceRate: 100,
    phone: '010-6158-4420',
    email: 'sh.kang@hangyeolfood.co.kr',
    joinedAt: '2018-09-17',
    assignedTask: '냉동기 소모품 구매',
  },
  {
    id: 'EMP-006',
    employeeNo: 'HGF-23011',
    name: '한예린',
    department: '구매팀',
    position: '사원',
    role: '원부자재 구매',
    shift: '일반',
    workStatus: '근무중',
    checkIn: '08:41',
    checkOut: null,
    todayHours: 5.9,
    monthlyHours: 116.2,
    attendanceRate: 99.4,
    phone: '010-8904-1256',
    email: 'yr.han@hangyeolfood.co.kr',
    joinedAt: '2023-01-16',
    assignedTask: '상단필름 납기 지연 대체재 확인',
  },
  {
    id: 'EMP-007',
    employeeNo: 'HGF-24006',
    name: '배수빈',
    department: '생산2팀',
    position: '사원',
    role: '계량·포장',
    shift: '야간',
    workStatus: '퇴근',
    checkIn: '21:48',
    checkOut: '06:04',
    todayHours: 8.0,
    monthlyHours: 124.8,
    attendanceRate: 96.9,
    phone: '010-2047-6651',
    email: 'sb.bae@hangyeolfood.co.kr',
    joinedAt: '2024-04-22',
    assignedTask: '배정 대기',
  },
  {
    id: 'EMP-008',
    employeeNo: 'HGF-20003',
    name: '정민수',
    department: '구매팀',
    position: '과장',
    role: '구매·협력사 관리',
    shift: '일반',
    workStatus: '연차',
    checkIn: null,
    checkOut: null,
    todayHours: 0,
    monthlyHours: 108.4,
    attendanceRate: 98.1,
    phone: '010-4419-8235',
    email: 'ms.jeong@hangyeolfood.co.kr',
    joinedAt: '2020-01-06',
    assignedTask: '연차',
  },
]

export const aiReviewItems: AIReviewItem[] = [
  {
    id: 'AI-260818-001',
    category: '표시사항',
    title: '알레르기 유발물질 “밀” 누락 가능성',
    targetId: 'LR-260818-01',
    targetName: '매콤 닭갈비 350g v3.2',
    description: '고추장 원료 구성에는 소맥분이 있으나 최종 시안의 알레르기 문구에서 밀을 찾을 수 없습니다.',
    suggestion: '표시 문구를 “닭고기, 대두, 밀 함유”로 수정한 뒤 품질 담당자가 원재료 배합표와 재대조하세요.',
    reason: '원재료 DB 12개 항목과 표시 시안 OCR 결과 비교',
    severity: '위험',
    confidence: 98,
    status: '담당자확인',
    assignee: '박지현',
    createdAt: '2026-08-18 14:18',
    dueAt: '2026-08-18 17:00',
  },
  {
    id: 'AI-260818-002',
    category: '재고',
    title: '제육볶음 LOT 우선 출고 필요',
    targetId: 'LOT-003',
    targetName: 'JEY-260811-C1',
    description: '소비기한이 5일 남은 420팩이 B-07-01에 있으며 후입고 LOT보다 출고 순위가 낮게 설정되어 있습니다.',
    suggestion: '오늘 A-03 피킹존으로 이동하고 SO-260818-022에 해당 LOT를 우선 할당하세요.',
    reason: 'FEFO 규칙 및 확정 판매주문 납기 비교',
    severity: '주의',
    confidence: 96,
    status: '처리중',
    assignee: '서동현',
    createdAt: '2026-08-18 13:52',
    dueAt: '2026-08-18 17:00',
  },
  {
    id: 'AI-260818-003',
    category: '발주',
    title: 'PP 실링용기 안전재고 미달 예상',
    targetId: 'PO-260818-013',
    targetName: 'PP 실링용기 500호',
    description: '현재 가용재고와 확정 생산계획을 반영하면 8월 20일 오전에 안전재고 10,000개 아래로 내려갑니다.',
    suggestion: '20,000개 발주안을 승인하면 8월 21일 이후 예상 재고가 21,400개로 회복됩니다.',
    reason: '7일 생산계획·BOM 소요량·현재 가용재고 기반 예측',
    severity: '주의',
    confidence: 93,
    status: '검토필요',
    assignee: '정민수',
    createdAt: '2026-08-18 12:40',
    dueAt: '2026-08-19 10:00',
  },
  {
    id: 'AI-260818-004',
    category: '생산',
    title: '소불고기 긴급 주문 대응 작업 재배치',
    targetId: 'SO-260818-022',
    targetName: '푸른마켓 수도권센터 주문',
    description: '내일 납품 물량 중 소불고기 600팩이 부족하며 생산1팀 3차 배합으로 충당 가능합니다.',
    suggestion: '오태식 반장에게 3차 배합을 배정하고 2호 실링라인을 16:40~18:10 확보하세요.',
    reason: '완제품 가용재고·라인별 OEE·작업자 숙련도 비교',
    severity: '제안',
    confidence: 91,
    status: '처리중',
    assignee: '오태식',
    createdAt: '2026-08-18 11:56',
    dueAt: '2026-08-18 16:30',
  },
  {
    id: 'AI-260818-005',
    category: '품질',
    title: '불고기 양념 베이스 재검사 필요',
    targetId: 'LOT-007',
    targetName: 'SAU-260812-A1',
    description: '염도 실측값 3.8%가 관리 기준 하한 4.0%보다 낮고 동일 배치 2회 측정 편차가 큽니다.',
    suggestion: 'LOT 사용을 계속 보류하고 보정된 염도계로 3점 재측정하세요.',
    reason: '공정검사 결과와 제품 규격서 허용범위 자동 대조',
    severity: '위험',
    confidence: 97,
    status: '담당자확인',
    assignee: '이정민',
    createdAt: '2026-08-18 10:48',
    dueAt: '2026-08-18 15:30',
  },
  {
    id: 'AI-260818-006',
    category: '인사',
    title: '야간 포장 인력 1명 보강 제안',
    targetId: 'SHIFT-260818-N',
    targetName: '생산2팀 야간조',
    description: '확정 생산량 대비 야간 포장 공수가 2.4시간 부족하고 현재 배정 인원 중 1명이 연장근무 한도에 근접했습니다.',
    suggestion: '주간조 포장 숙련자 1명을 18:00~22:00 지원 배정하거나 생산 순서를 조정하세요.',
    reason: '작업표준시간·근태·개인별 숙련도 및 연장근무 누계 분석',
    severity: '제안',
    confidence: 88,
    status: '검토필요',
    assignee: '미배정',
    createdAt: '2026-08-18 09:34',
    dueAt: '2026-08-18 17:30',
  },
  {
    id: 'AI-260817-007',
    category: '판매',
    title: '닭갈비 주문 납기 재협의 필요',
    targetId: 'SO-260817-016',
    targetName: '새봄푸드서비스 주문',
    description: '표시사항 승인 지연과 현재 재고를 반영하면 요청 납기까지 800팩 전량 출고가 어렵습니다.',
    suggestion: '8월 20일 500팩, 8월 21일 300팩 분할 납품안을 고객사에 제안하세요.',
    reason: '표시 승인 상태·생산계획·가용재고·배송 리드타임 분석',
    severity: '주의',
    confidence: 94,
    status: '검토필요',
    assignee: '윤서진',
    createdAt: '2026-08-17 17:22',
    dueAt: '2026-08-18 15:00',
  },
]
