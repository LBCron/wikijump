-- The only e-mail backstop covers verified claims; unverified claims are
-- guarded solely by a service-layer check that races under concurrency.
-- Reconcile duplicate live claims before adding the invariant that
-- registration and e-mail changes expect.
--
-- Scope matches the service-layer check: live regular users holding a
-- non-empty address, compared case-insensitively. The earliest live holder
-- (lowest user ID) keeps the address; later duplicates are displaced to a
-- per-user placeholder address and lose verification, since a displaced
-- claim cannot stay verified for an address it no longer holds.
DO $$
DECLARE
    displaced_count BIGINT;
BEGIN
    WITH ranked_live_users AS (
        SELECT
            "user".user_id,
            ROW_NUMBER() OVER (
                PARTITION BY lower("user".email)
                ORDER BY "user".user_id ASC
            ) AS ordinal
        FROM "user"
        WHERE "user".user_type = 'regular'
          AND "user".deleted_at IS NULL
          AND "user".email <> ''
    )
    UPDATE "user"
    SET email = 'duplicate-' || ranked_live_users.user_id || '@invalid',
        email_verified_at = NULL
    FROM ranked_live_users
    WHERE "user".user_id = ranked_live_users.user_id
      AND ranked_live_users.ordinal > 1;

    GET DIAGNOSTICS displaced_count = ROW_COUNT;
    IF displaced_count > 0 THEN
        RAISE NOTICE 'user_email_active_unique: displaced % duplicate live user email claim(s)', displaced_count;
    END IF;
END $$;

CREATE UNIQUE INDEX user_email_active_unique_idx
    ON "user" (lower(email))
    WHERE user_type = 'regular'
      AND deleted_at IS NULL
      AND email <> '';
