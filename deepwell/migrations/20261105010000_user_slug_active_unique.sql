-- A UNIQUE (slug, deleted_at) constraint does not protect live users because
-- PostgreSQL treats NULL values as distinct. Reconcile any existing live
-- duplicates before adding the invariant that registration and rename expect.
--
-- The earliest live holder (lowest user ID) keeps the slug; later duplicates
-- are displaced to "<slug>-<user_id>". Repeat until no live duplicates
-- remain: a displaced slug can itself collide with a pre-existing slug of
-- that exact suffixed form, and such a row is displaced again in turn.
DO $$
DECLARE
    displaced_count BIGINT;
    total_displaced BIGINT := 0;
BEGIN
    LOOP
        WITH ranked_live_users AS (
            SELECT
                "user".user_id,
                "user".slug,
                ROW_NUMBER() OVER (
                    PARTITION BY "user".slug
                    ORDER BY "user".user_id ASC
                ) AS ordinal
            FROM "user"
            WHERE "user".deleted_at IS NULL
        )
        UPDATE "user"
        SET slug = ranked_live_users.slug || '-' || ranked_live_users.user_id
        FROM ranked_live_users
        WHERE "user".user_id = ranked_live_users.user_id
          AND ranked_live_users.ordinal > 1;

        GET DIAGNOSTICS displaced_count = ROW_COUNT;
        total_displaced := total_displaced + displaced_count;
        EXIT WHEN displaced_count = 0;
    END LOOP;

    IF total_displaced > 0 THEN
        RAISE NOTICE 'user_slug_active_unique: displaced % duplicate live user slug(s)', total_displaced;
    END IF;
END $$;

CREATE UNIQUE INDEX user_slug_active_unique_idx
    ON "user" (slug)
    WHERE deleted_at IS NULL;
