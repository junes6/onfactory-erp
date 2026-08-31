import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { FALLBACK_INDUSTRY, industrySurface, resolveIndustry, type IndustrySurface, type TenantIndustryType } from './registry'

/**
 * 업종은 워크스페이스 전체의 성질이므로 화면마다 prop으로 옮겨 담지 않는다.
 * 한 번 감싸 두면 새로 붙는 화면이 업종을 "잊어버릴" 방법이 없다.
 */
const IndustryContext = createContext<TenantIndustryType>(FALLBACK_INDUSTRY)

export function IndustryProvider({ industryType, children }: { industryType?: string | null; children: ReactNode }) {
  const resolved = resolveIndustry(industryType)
  return <IndustryContext.Provider value={resolved}>{children}</IndustryContext.Provider>
}

export function useIndustry(): TenantIndustryType {
  return useContext(IndustryContext)
}

/** 화면 문구·목록의 단일 출처. 업종 고유 문구는 반드시 이 훅을 통해 읽는다. */
export function useIndustrySurface(): IndustrySurface {
  const industryType = useIndustry()
  return useMemo(() => industrySurface(industryType), [industryType])
}
