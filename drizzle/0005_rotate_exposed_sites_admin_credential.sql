-- 공개 저장소 이력(d4fd0e8)에 이 계정의 임시 비밀번호 평문과 그 해시가 함께 노출됐다.
-- 아는 사람이 없는 값으로 바꿔 잠근다: 다음 로그인은 비밀번호 재설정 경로
-- (/api/auth/password-reset → 운영자 확인)를 타야 한다.
--
-- 노출된 해시가 아직 그대로인 경우에만 바꾼다. 이미 스스로 비밀번호를 바꾼
-- 배포에서 관리자를 잠그면 안 되기 때문이다. 비교하는 해시는 이미 공개된 값이라
-- 여기 다시 적어도 새로 새는 것은 없다.
UPDATE app_state
SET payload = json_set(
      payload,
      '$."workspaceStore"."accountCredentials"."USR-SUNSEA-ADMIN"',
      json_object(
        'passwordHash', lower(hex(randomblob(32))),
        'mustChangePassword', json('true'),
        'temporaryPasswordExpiresAt', json('null'),
        'rotatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        'rotationReason', 'public-history-exposure'
      )
    ),
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'onfactory'
  AND json_type(payload, '$."workspaceStore"') = 'object'
  AND json_extract(payload, '$."workspaceStore"."accountCredentials"."USR-SUNSEA-ADMIN"."passwordHash"')
      = 'a8ed52944ee3b217b18df8c275db17390bc4dd1bf124e2ef7d20ab5184f9bd13';
