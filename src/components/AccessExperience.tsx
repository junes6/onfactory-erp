import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Accessibility, ArrowLeft, Briefcase, Check, ChevronRight, Download, Eye, EyeOff, KeyRound, Laptop, LockKeyhole, LogIn, Mail, Moon, Palette, Phone, Save, ShieldCheck, Smartphone, Sun, Type, UserPen, X } from 'lucide-react'
import { BrandMark } from './AppIcons'
import { Button, IconButton } from './ui/Button'
import { BRAND } from '../brand'
import { useIndustrySurface } from '../modules/IndustryContext'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type FontChoice = 'standard' | 'large' | 'extra'
export type AccentChoice = 'blue' | 'green' | 'violet' | 'teal' | 'rose' | 'navy'
export type EasyModeChoice = 'standard' | 'easy'

export const accentOptions: Array<{ id: AccentChoice; label: string }> = [
  { id: 'blue', label: '파랑' },
  { id: 'green', label: '초록' },
  { id: 'violet', label: '보라' },
  { id: 'teal', label: '청록' },
  { id: 'rose', label: '자주' },
  { id: 'navy', label: '남색' },
]

type LoginPageProps = {
  onLogin: (credentials: { workspace: 'tenant' | 'platform'; email: string; password: string; remember: boolean }) => Promise<{ ok: boolean; message: string }>
  initialError?: string
}

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
const PWA_BANNER_KEY = 'onfactory-pwa-install-dismissed'
const isStandaloneDisplay = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)

function InstallBanner() {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(PWA_BANNER_KEY) === '1' } catch { return true } })
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandaloneDisplay)
  useEffect(() => {
    const onPrompt = (event: Event) => { event.preventDefault(); setInstallEvent(event as BeforeInstallPromptEvent) }
    const onInstalled = () => setInstalled(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled) }
  }, [])
  const dismiss = () => { try { localStorage.setItem(PWA_BANNER_KEY, '1') } catch { /* 저장 불가 환경 */ } setDismissed(true) }
  if (dismissed || installed) return null
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
  return <div className="auth-install-banner" role="note" aria-label="앱 설치 안내">
    <Smartphone size={18} />
    <div>
      <strong>{BRAND.name}를 앱처럼 설치할 수 있어요</strong>
      <span>{installEvent ? 'PC에서는 독립 창으로, 휴대폰에서는 홈 화면 아이콘으로 바로 엽니다.' : isIos ? 'Safari 공유 버튼 → “홈 화면에 추가”를 누르면 홈 화면에서 바로 엽니다.' : 'Chrome 주소창 오른쪽의 설치 아이콘(또는 메뉴 → 앱 설치)을 누르면 독립 창으로 엽니다.'}</span>
    </div>
    {installEvent && <button type="button" className="auth-install-action" onClick={() => { void installEvent.prompt().then(() => installEvent.userChoice).then((choice) => { if (choice.outcome === 'accepted') setInstalled(true) }).catch(() => {}) }}><Download size={16} /> 설치</button>}
    <button type="button" className="auth-install-close" aria-label="설치 안내 닫기 (다시 표시되지 않음)" onClick={dismiss}><X size={16} /></button>
  </div>
}

export function LoginPage({ onLogin, initialError = '' }: LoginPageProps) {
  const queryResetToken = new URLSearchParams(window.location.search).get('reset') ?? ''
  const [view, setView] = useState<'login' | 'forgot' | 'reset' | 'pending'>(queryResetToken ? 'reset' : 'login')
  const [showPassword, setShowPassword] = useState(false)
  const [notice, setNotice] = useState('')
  const [workspace, setWorkspace] = useState<'tenant' | 'platform'>('tenant')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loginError, setLoginError] = useState(initialError)
  const [remember, setRemember] = useState(true)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSubmitting, setResetSubmitting] = useState(false)
  const [resetToken, setResetToken] = useState(queryResetToken)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setLoginError('')
    const result = await onLogin({ workspace, email, password, remember })
    if (!result.ok) setLoginError(result.message)
    setSubmitting(false)
  }

  const changeWorkspace = (value: 'tenant' | 'platform') => {
    setWorkspace(value)
    setEmail('')
    setPassword('')
    setLoginError('')
  }

  const sendReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setResetSubmitting(true)
    setNotice('')
    try {
      const response = await fetch('/api/auth/password-reset', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: resetEmail }),
      })
      const body = await response.json() as { message?: string; developmentReset?: { token?: string; expiresAt?: string }; error?: { message?: string } }
      if (response.ok && body.developmentReset?.token) {
        setResetToken(body.developmentReset.token)
        setView('reset')
        setNotice('로컬 개발 환경에서 재설정 토큰을 확인했습니다. 새 비밀번호를 설정해 주세요.')
      } else {
        setNotice(response.ok ? body.message || '재설정 요청을 접수했습니다.' : body.error?.message || '요청을 처리하지 못했습니다.')
      }
    } catch {
      setNotice('재설정 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setResetSubmitting(false)
    }
  }

  const confirmReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (newPassword !== confirmPassword) { setNotice('새 비밀번호 확인이 일치하지 않습니다.'); return }
    setResetSubmitting(true)
    setNotice('')
    try {
      const response = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: resetToken, newPassword }),
      })
      const body = await response.json() as { email?: string; message?: string; error?: { message?: string } }
      if (!response.ok) { setNotice(body.error?.message || '비밀번호를 재설정하지 못했습니다.'); return }
      if (body.email) setEmail(body.email)
      setPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setResetToken('')
      window.history.replaceState({}, '', window.location.pathname)
      setNotice(body.message || '새 비밀번호를 저장했습니다. 로그인해 주세요.')
      setView('login')
    } catch {
      setNotice('재설정 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setResetSubmitting(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-brand-panel" aria-label={`${BRAND.name} 소개`}>
        <div className="auth-brand"><BrandMark size={48} /><div><strong>{BRAND.name}</strong><span>{BRAND.tagline}</span></div></div>
        <div className="auth-brand-copy">
          <span className="auth-overline">ONE CONNECTED WORKSPACE</span>
          <h1>회사의 오늘을<br />한눈에, 한 흐름으로.</h1>
          <p>업무·프로젝트·일정·문서·결재를 한곳에 연결하고, 업종별 모듈과 AI가 필요한 순간에만 먼저 알려드립니다.</p>
        </div>
        <div className="auth-trust-row">
          <span><ShieldCheck size={18} /> 고객사별 데이터 분리</span>
          <span><LockKeyhole size={18} /> 관리자 승인 계정</span>
        </div>
      </section>

      <section className="auth-form-panel">
        <div className="auth-form-card">
          {view === 'login' && <>
            <header><span className="auth-mobile-brand"><BrandMark size={38} /> {BRAND.name}</span><h2>다시 만나서 반갑습니다</h2><p>회사 계정으로 안전하게 로그인하세요.</p></header>
            <InstallBanner />
            <form onSubmit={submitLogin}>
              <label className="form-field full"><span>회사 워크스페이스</span><select value={workspace} onChange={(event) => changeWorkspace(event.target.value as 'tenant' | 'platform')}><option value="tenant">고객사 ERP (회사 계정)</option><option value="platform">{BRAND.platformAdminLabel}</option></select></label>
              <label className="form-field full"><span>이메일</span><div className="input-with-icon"><Mail size={18} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></div></label>
              <label className="form-field full"><span>비밀번호</span><div className="input-with-icon"><KeyRound size={18} /><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button type="button" aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 보기'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
              <div className="auth-form-options"><label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> 이 기기에서 로그인 유지</label><button type="button" onClick={() => { setView('forgot'); setNotice('') }}>비밀번호 찾기</button></div>
              {loginError && <div className="auth-inline-error" role="alert">{loginError}</div>}
              {notice && <div className="auth-inline-success" role="status"><Check size={18} /> {notice}</div>}
              <button className="auth-submit" type="submit" disabled={submitting}><LogIn size={19} /> {submitting ? '인증 중…' : '로그인'}</button>
            </form>
            <button className="auth-status-link" type="button" onClick={() => setView('pending')}>신규 직원이신가요? 가입 및 승인 상태 확인 <ChevronRight size={17} /></button>
            <div className="auth-demo-note"><ShieldCheck size={18} /><div><strong>관리자가 발급한 회사 계정으로 로그인하세요.</strong><span>{workspace === 'platform' ? '승인된 플랫폼 운영자만 통합 콘솔에 접근합니다.' : '로그인한 회사의 데이터만 분리해 확인합니다.'}</span></div></div>
          </>}

          {view === 'forgot' && <>
            <button className="auth-back" type="button" onClick={() => setView('login')}><ArrowLeft size={18} /> 로그인으로</button>
            <header><h2>비밀번호 재설정</h2><p>로컬에서는 바로 새 비밀번호를 설정하고, 운영 배포에서는 연결된 회사 메일 또는 관리자 재발급으로 안내합니다.</p></header>
            <form onSubmit={sendReset}>
              <label className="form-field full"><span>회사 이메일</span><div className="input-with-icon"><Mail size={18} /><input type="email" placeholder="name@company.co.kr" autoFocus value={resetEmail} onChange={(event) => setResetEmail(event.target.value)} required /></div></label>
              {notice && <div className="auth-inline-success" role="status"><Check size={18} /> {notice}</div>}
              <button className="auth-submit" type="submit" disabled={resetSubmitting}>{resetSubmitting ? '요청 중…' : '재설정 요청'}</button>
            </form>
          </>}

          {view === 'reset' && <>
            <button className="auth-back" type="button" onClick={() => { setView('forgot'); setNotice(''); setResetToken(''); window.history.replaceState({}, '', window.location.pathname) }}><ArrowLeft size={18} /> 다시 요청</button>
            <header><h2>새 비밀번호 설정</h2><p>재설정 링크는 30분 동안 한 번만 사용할 수 있습니다.</p></header>
            <form onSubmit={confirmReset}>
              <label className="form-field full"><span>새 비밀번호</span><div className="input-with-icon"><KeyRound size={18} /><input type="password" autoFocus autoComplete="new-password" minLength={10} maxLength={72} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></div></label>
              <label className="form-field full"><span>새 비밀번호 확인</span><div className="input-with-icon"><LockKeyhole size={18} /><input type="password" autoComplete="new-password" minLength={10} maxLength={72} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div></label>
              <PasswordRules value={newPassword} />
              {notice && <div className={notice.includes('확인했습니다') ? 'auth-inline-success' : 'auth-inline-error'} role="status">{notice}</div>}
              <button className="auth-submit" type="submit" disabled={resetSubmitting}>{resetSubmitting ? '저장 중…' : '새 비밀번호 저장'}</button>
            </form>
          </>}

          {view === 'pending' && <>
            <button className="auth-back" type="button" onClick={() => setView('login')}><ArrowLeft size={18} /> 로그인으로</button>
            <header><h2>신규 직원 계정</h2><p>회사의 관리자가 이름·이메일·소속·직무를 등록하고 승인한 뒤 계정을 활성화합니다.</p></header>
            <ol className="approval-steps">
              <li className="done"><span><Check size={17} /></span><div><strong>관리자 구성원 등록</strong><p>회사 이메일·소속·직무 입력</p></div></li>
              <li className="active"><span>2</span><div><strong>관리자 승인</strong><p>소속·직무·접근 권한 확인</p></div></li>
              <li><span>3</span><div><strong>계정 활성화</strong><p>72시간 초기 비밀번호 로그인 후 즉시 변경</p></div></li>
            </ol>
            <div className="pending-account-card"><span className="status-dot" /><div><strong>승인 상태는 회사 관리자에게 확인하세요</strong><p>관리자가 계정을 승인하면 72시간 유효한 초기 비밀번호를 전달합니다.</p></div></div>
            <p className="auth-help">계정이 없다면 회사 관리자에게 구성원 등록과 임시 비밀번호 발급을 요청하세요.</p>
          </>}
        </div>
      </section>
    </main>
  )
}

function PasswordRules({ value }: { value: string }) {
  const checks = [
    ['10자 이상', value.length >= 10],
    ['영문 대·소문자', /[a-z]/.test(value) && /[A-Z]/.test(value)],
    ['숫자 포함', /\d/.test(value)],
    ['특수문자 포함', /[^a-z0-9]/i.test(value)],
  ] as const
  return <div className="auth-password-rules" aria-label="비밀번호 조건">
    {checks.map(([label, passed]) => <span className={passed ? 'passed' : ''} key={label}><Check size={14} />{label}</span>)}
  </div>
}

type PasswordChangePageProps = {
  name: string
  email: string
  onChange: (newPassword: string) => Promise<{ ok: boolean; message: string }>
  onLogout: () => void
}

export function PasswordChangePage({ name, email, onChange, onLogout }: PasswordChangePageProps) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password !== confirm) { setError('새 비밀번호 확인이 일치하지 않습니다.'); return }
    setSubmitting(true)
    setError('')
    const result = await onChange(password)
    if (!result.ok) setError(result.message)
    setSubmitting(false)
  }
  return <main className="auth-shell">
    <section className="auth-brand-panel" aria-label={`${BRAND.name} 보안 안내`}>
      <div className="auth-brand"><BrandMark size={48} /><div><strong>{BRAND.name}</strong><span>{BRAND.tagline}</span></div></div>
      <div className="auth-brand-copy"><span className="auth-overline">SECURE ONBOARDING</span><h1>처음 한 번,<br />안전하게 시작합니다.</h1><p>관리자가 발급한 초기 비밀번호는 제한된 시간만 유효하며 새 비밀번호 설정 후 즉시 폐기됩니다.</p></div>
      <div className="auth-trust-row"><span><ShieldCheck size={18} /> 첫 로그인 강제 변경</span><span><LockKeyhole size={18} /> 다른 세션 자동 만료</span></div>
    </section>
    <section className="auth-form-panel"><div className="auth-form-card">
      <header><span className="auth-mobile-brand"><BrandMark size={38} /> {BRAND.name}</span><h2>새 비밀번호를 설정하세요</h2><p>{name}님 · {email}<br />설정을 마쳐야 회사 워크스페이스를 사용할 수 있습니다.</p></header>
      <form onSubmit={submit}>
        <label className="form-field full"><span>새 비밀번호</span><div className="input-with-icon"><KeyRound size={18} /><input type="password" autoFocus autoComplete="new-password" minLength={10} maxLength={72} value={password} onChange={(event) => setPassword(event.target.value)} required /></div></label>
        <label className="form-field full"><span>새 비밀번호 확인</span><div className="input-with-icon"><LockKeyhole size={18} /><input type="password" autoComplete="new-password" minLength={10} maxLength={72} value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></div></label>
        <PasswordRules value={password} />
        {error && <div className="auth-inline-error" role="alert">{error}</div>}
        <button className="auth-submit" type="submit" disabled={submitting}>{submitting ? '안전하게 저장 중…' : '비밀번호 설정하고 시작'}</button>
        <button className="auth-status-link" type="button" onClick={onLogout}>다른 계정으로 로그인</button>
      </form>
    </div></section>
  </main>
}

type SettingsDrawerProps = {
  open: boolean
  onClose: () => void
  onEditProfile?: () => void
  profileName: string
  profileRole: string
  companyName: string
  theme: ThemeChoice
  fontSize: FontChoice
  accent: AccentChoice
  easyMode: EasyModeChoice
  onThemeChange: (value: ThemeChoice) => void
  onFontSizeChange: (value: FontChoice) => void
  onAccentChange: (value: AccentChoice) => void
  onEasyModeChange: (value: EasyModeChoice) => void
  onLogout: () => void
}

export function SettingsDrawer({ open, onClose, profileName, profileRole, companyName, theme, fontSize, accent, easyMode, onThemeChange, onFontSizeChange, onAccentChange, onEasyModeChange, onLogout, onEditProfile }: SettingsDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const drawer = drawerRef.current
    drawer?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !drawer) return
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])'))
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [open, onClose])

  if (!open) return null
  return <>
    <button className="drawer-scrim" type="button" aria-label="개인 설정 닫기" onClick={onClose} />
    <aside ref={drawerRef} className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header><div><span className="eyebrow">PERSONAL SETTINGS</span><h2 id="settings-title">내 화면 설정</h2></div><IconButton tone="ghost" type="button" aria-label="설정 닫기" onClick={onClose}><X size={21} /></IconButton></header>
      <div className="settings-profile"><span>{profileName.slice(0, 1)}</span><div><strong>{profileName}</strong><p>{profileRole} · {companyName}</p></div>{onEditProfile && <button type="button" className="settings-profile-edit" onClick={onEditProfile}><UserPen size={16} /> 프로필 수정</button>}</div>
      <section className="setting-section">
        <div className="setting-section-title"><Sun size={19} /><div><h3>화면 테마</h3><p>눈에 편한 화면을 선택하세요.</p></div></div>
        <div className="setting-option-grid three">
          <button className={theme === 'light' ? 'selected' : ''} type="button" onClick={() => onThemeChange('light')}><Sun size={21} /><span>라이트</span>{theme === 'light' && <Check size={16} />}</button>
          <button className={theme === 'dark' ? 'selected' : ''} type="button" onClick={() => onThemeChange('dark')}><Moon size={21} /><span>다크</span>{theme === 'dark' && <Check size={16} />}</button>
          <button className={theme === 'system' ? 'selected' : ''} type="button" onClick={() => onThemeChange('system')}><Laptop size={21} /><span>시스템</span>{theme === 'system' && <Check size={16} />}</button>
        </div>
      </section>
      <section className="setting-section">
        <div className="setting-section-title"><Type size={19} /><div><h3>글자 크기</h3><p>본문·버튼·표 글자가 단계별로 커집니다.</p></div></div>
        <div className="font-preview"><span>가</span><span>가</span><span>가</span></div>
        <div className="setting-segmented" role="group" aria-label="글자 크기">
          {([['standard', '기본'], ['large', '크게'], ['extra', '아주 크게']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={fontSize === value} onClick={() => onFontSizeChange(value)}>{label}</button>)}
        </div>
      </section>
      <section className="setting-section">
        <div className="setting-section-title"><Palette size={19} /><div><h3>포인트 컬러</h3><p>왼쪽 메뉴·버튼·강조 표시가 함께 바뀝니다.</p></div></div>
        <div className="setting-accent-grid" role="group" aria-label="포인트 컬러 선택">
          {accentOptions.map((option) => (
            <button key={option.id} type="button" className={`setting-accent-swatch accent-${option.id}${accent === option.id ? ' selected' : ''}`} aria-pressed={accent === option.id} onClick={() => onAccentChange(option.id)}>
              <i aria-hidden="true">{accent === option.id && <Check size={15} />}</i>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="setting-section">
        <div className="setting-section-title"><Accessibility size={19} /><div><h3>쉬운 화면</h3><p>메인 화면만 큰 바로가기와 지금 할 일 중심으로 단순화합니다. 다른 업무 화면은 기본 배치를 유지합니다.</p></div></div>
        <div className="setting-segmented" role="group" aria-label="쉬운 화면 모드">
          <button type="button" aria-pressed={easyMode === 'standard'} onClick={() => onEasyModeChange('standard')}>기본 화면</button>
          <button type="button" aria-pressed={easyMode === 'easy'} onClick={() => onEasyModeChange('easy')}>쉬운 화면</button>
        </div>
      </section>
      <footer><button className="settings-logout" type="button" onClick={onLogout}><LogIn size={18} /> 로그아웃</button></footer>
    </aside>
  </>
}

export type ProfileAccount = { id: string; name: string; email: string; team?: string; jobRole?: string; phone?: string; bio?: string; role: string; tenantName: string | null }

/** 내 프로필 수정 — 이름·부서·직책·연락처·소개 + 비밀번호 변경 */
export function ProfileEditor({ account, onClose, onSaved, onToast }: { account: ProfileAccount; onClose: () => void; onSaved: (account: ProfileAccount & Record<string, unknown>) => void; onToast: (message: string) => void }) {
  const industry = useIndustrySurface()
  const [name, setName] = useState(account.name)
  const [team, setTeam] = useState(account.team ?? '')
  const [jobRole, setJobRole] = useState(account.jobRole ?? '')
  const [phone, setPhone] = useState(account.phone ?? '')
  const [bio, setBio] = useState(account.bio ?? '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey) }, [onClose])
  const operator = account.role === 'platform-operator'
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/me/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), team: team.trim(), jobRole: jobRole.trim(), phone: phone.trim(), bio: bio.trim() }) })
      const body = await response.json() as { account?: ProfileAccount & Record<string, unknown>; error?: { message?: string } }
      if (!response.ok || !body.account) { setError(body.error?.message || '프로필을 저장하지 못했습니다.'); return }
      onSaved(body.account)
      onToast('프로필을 저장했습니다.')
      onClose()
    } catch { setError('서버에 연결하지 못했습니다.') }
    finally { setBusy(false) }
  }
  const changePassword = async () => {
    if (newPassword !== newPasswordConfirm) { setError('새 비밀번호 확인이 일치하지 않습니다.'); return }
    setPasswordBusy(true); setError('')
    try {
      const response = await fetch('/api/me/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) })
      const body = await response.json() as { ok?: boolean; error?: { message?: string } }
      if (!response.ok) { setError(body.error?.message || '비밀번호를 변경하지 못했습니다.'); return }
      setCurrentPassword(''); setNewPassword(''); setNewPasswordConfirm('')
      onToast('비밀번호를 변경했습니다. 다음 로그인부터 새 비밀번호를 사용하세요.')
    } catch { setError('서버에 연결하지 못했습니다.') }
    finally { setPasswordBusy(false) }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card profile-editor" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
      <header><div><span className="eyebrow">MY PROFILE</span><h2 id="profile-editor-title">내 프로필</h2><p>{account.email}{account.tenantName ? ` · ${account.tenantName}` : ''}</p></div><IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton></header>
      <form onSubmit={saveProfile}>
        <div className="profile-editor-identity"><span className="profile-editor-avatar">{name.trim().slice(0, 1) || account.name.slice(0, 1)}</span><div><strong>{name.trim() || account.name}</strong><small>{[jobRole.trim(), team.trim()].filter(Boolean).join(' · ') || (operator ? '플랫폼 운영자' : '직책·부서 미입력')}</small></div></div>
        <div className="form-grid">
          <label className="form-field"><span>이름 <em>필수</em></span><input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={40} autoFocus /></label>
          <label className="form-field"><span>연락처</span><div className="input-with-icon"><Phone size={17} /><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="010-0000-0000" maxLength={30} /></div></label>
        </div>
        <div className="form-grid">
          <label className="form-field"><span>부서</span><input value={team} onChange={(event) => setTeam(event.target.value)} maxLength={40} placeholder={operator ? BRAND.operatorTeam : industry.examples.department} /></label>
          <label className="form-field"><span>직책</span><div className="input-with-icon"><Briefcase size={17} /><input value={jobRole} onChange={(event) => setJobRole(event.target.value)} maxLength={40} placeholder="예: 품질 책임자" /></div></label>
        </div>
        <label className="form-field full"><span>한 줄 소개 <em>선택</em></span><input value={bio} onChange={(event) => setBio(event.target.value)} maxLength={200} placeholder="담당 업무나 연락 가능한 시간을 적어 두면 동료가 찾기 쉽습니다." /></label>
        <p className="profile-editor-note">이메일과 역할(관리자·직원)은 회사 관리자가 관리합니다. 이름·부서·직책은 업무지시·일지·메신저에 바로 반영됩니다.</p>
        {error && <div className="auth-inline-error" role="alert">{error}</div>}
        <footer><Button tone="ghost" type="button" onClick={onClose} disabled={busy}>닫기</Button><Button tone="primary" type="submit" disabled={busy || name.trim().length < 2}><Save size={17} /> {busy ? '저장 중…' : '프로필 저장'}</Button></footer>
      </form>
      <section className="profile-password" aria-labelledby="profile-password-title">
        <h3 id="profile-password-title"><KeyRound size={16} /> 비밀번호 변경</h3>
        <div className="form-grid three">
          <label className="form-field"><span>현재 비밀번호</span><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label>
          <label className="form-field"><span>새 비밀번호</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" placeholder="10자 이상, 대/소문자·숫자·특수문자" /></label>
          <label className="form-field"><span>새 비밀번호 확인</span><input type="password" value={newPasswordConfirm} onChange={(event) => setNewPasswordConfirm(event.target.value)} autoComplete="new-password" /></label>
        </div>
        <div className="profile-password-actions"><Button tone="secondary" type="button" disabled={passwordBusy || !currentPassword || newPassword.length < 10 || !newPasswordConfirm} onClick={() => void changePassword()}><KeyRound size={16} /> {passwordBusy ? '변경 중…' : '비밀번호 변경'}</Button></div>
      </section>
    </section>
  </div>
}
