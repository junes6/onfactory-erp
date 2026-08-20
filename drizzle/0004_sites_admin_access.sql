-- One-time credential recovery for the existing public Sites demo workspace.
-- The plaintext password is never stored; only the account-scoped scrypt hash
-- is written, and every other workspace value remains untouched.
UPDATE app_state
SET payload = json_set(
      payload,
      '$."workspaceStore"."accountCredentials"."USR-SUNSEA-ADMIN"',
      json_object(
        'passwordHash', 'a8ed52944ee3b217b18df8c275db17390bc4dd1bf124e2ef7d20ab5184f9bd13',
        'mustChangePassword', json('false'),
        'temporaryPasswordExpiresAt', json('null'),
        'issuedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    ),
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'onfactory'
  AND json_type(payload, '$."workspaceStore"') = 'object';
