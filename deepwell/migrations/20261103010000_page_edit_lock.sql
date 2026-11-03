CREATE SEQUENCE page_edit_lock_lock_id_seq;

CREATE TABLE page_edit_lock (
    page_edit_lock_id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    lock_id BIGINT NOT NULL DEFAULT nextval('page_edit_lock_lock_id_seq'),
    lock_secret TEXT NOT NULL,
    mode TEXT NOT NULL,
    section_index INTEGER,
    base_revision_id BIGINT REFERENCES page_revision (revision_id),
    page_id BIGINT NOT NULL REFERENCES page (page_id),
    user_id BIGINT NOT NULL REFERENCES known_user (user_id),

    UNIQUE (lock_id),
    CHECK (length(lock_secret) > 0),
    CHECK (length(mode) > 0),
    CHECK ((mode = 'section') = (section_index IS NOT NULL))
);

CREATE INDEX page_edit_lock_page_id_idx ON page_edit_lock (page_id);
