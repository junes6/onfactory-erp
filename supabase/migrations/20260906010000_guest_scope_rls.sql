-- A절 외부 게스트 초대: 게스트 범위 RLS.
-- 앱 필터가 실수해도 DB가 한 번 더 자르기 위한 2차 방어다. 서버는 평소 app.role='service'로
-- 접속해 전량 통과하고, 게스트의 GET 라우트만 트랜잭션 안에서 app.role='tenant-guest' +
-- app.org_id + app.current_account_id + app.guest_project_ids(콤마 구분)를 세팅해 SELECT한다.
-- 게스트 컨텍스트에는 INSERT/UPDATE 정책이 없으므로 쓰기는 거부된다(쓰기는 service 컨텍스트에서만).
-- 주의: 접속 롤이 슈퍼유저이거나 BYPASSRLS면 이 정책은 적용되지 않는다 — run-postgres-e2e가 검사한다.

CREATE OR REPLACE FUNCTION app_guest_project_ids() RETURNS TEXT[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(string_to_array(NULLIF(current_setting('app.guest_project_ids', TRUE), ''), ','), '{}')
$$;

-- 여섯 테이블 모두: RLS 강제 + service 전량 통과. 게스트 SELECT 정책은 아래에서 테이블별로 준다.
-- guest_grants 자체는 service 전용이다(게스트가 자기 grant를 DB에서 직접 읽을 길은 없다).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_service ON %I', t, t);
    EXECUTE format($p$
      CREATE POLICY %I_service ON %I
      USING (current_setting('app.role', TRUE) = 'service')
      WITH CHECK (current_setting('app.role', TRUE) = 'service')
    $p$, t, t);
  END LOOP;
END $$;

-- 프로젝트: 초대 범위 안이고 members에 본인이 들어 있는 것만.
DROP POLICY IF EXISTS project_spaces_guest_read ON project_spaces;
CREATE POLICY project_spaces_guest_read ON project_spaces FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND id = ANY (app_guest_project_ids())
  AND payload->'members' @> jsonb_build_array(jsonb_build_object('id', current_setting('app.current_account_id', TRUE)))
);

-- 게시글: 범위 안 프로젝트의 글만.
DROP POLICY IF EXISTS project_posts_guest_read ON project_posts;
CREATE POLICY project_posts_guest_read ON project_posts FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND payload->>'projectId' = ANY (app_guest_project_ids())
);

-- 업무: 범위 안 프로젝트에 귀속되고 담당자가 본인인 건만.
DROP POLICY IF EXISTS work_items_guest_read ON work_items;
CREATE POLICY work_items_guest_read ON work_items FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND payload->>'projectId' = ANY (app_guest_project_ids())
  AND payload->>'ownerId' = current_setting('app.current_account_id', TRUE)
);

-- 대화방: 참여 중이어야 하고, direct가 아니면 범위 안 프로젝트 채널이어야 한다.
DROP POLICY IF EXISTS messenger_conversations_guest_read ON messenger_conversations;
CREATE POLICY messenger_conversations_guest_read ON messenger_conversations FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND payload->'participantIds' ? current_setting('app.current_account_id', TRUE)
  AND (payload->>'type' = 'direct' OR payload->>'projectId' = ANY (app_guest_project_ids()))
);

-- 자료: 본인이 올린 것, 또는 restricted이면서 allowedUserIds에 본인이 있는 것만.
-- items 테이블은 여러 종류를 담으므로 item_type='company-document'로 한정한다.
DROP POLICY IF EXISTS items_guest_read ON items;
CREATE POLICY items_guest_read ON items FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND item_type = 'company-document'
  AND (
    payload->>'uploadedById' = current_setting('app.current_account_id', TRUE)
    OR (payload->>'visibility' = 'restricted' AND payload->'allowedUserIds' ? current_setting('app.current_account_id', TRUE))
  )
);

-- 계정: 게스트는 자기 행만 본다(다른 직원의 존재 자체를 DB에서 확인할 수 없다).
ALTER TABLE core_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS core_accounts_service ON core_accounts;
CREATE POLICY core_accounts_service ON core_accounts
  USING (current_setting('app.role', TRUE) = 'service')
  WITH CHECK (current_setting('app.role', TRUE) = 'service');
DROP POLICY IF EXISTS core_accounts_guest_self ON core_accounts;
CREATE POLICY core_accounts_guest_self ON core_accounts FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND id = current_setting('app.current_account_id', TRUE)
);
