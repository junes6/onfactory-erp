-- R11-B 렌즈: 코어 lenses 테이블을 일반 워크스페이스 행 모양에 맞춘다.
-- 추가 전용이며 기존 행은 그대로 둔다.
ALTER TABLE lenses ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lenses ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
ALTER TABLE lenses ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE lenses ALTER COLUMN name DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lenses_active
ON lenses (org_id, position)
WHERE deleted_at IS NULL;
