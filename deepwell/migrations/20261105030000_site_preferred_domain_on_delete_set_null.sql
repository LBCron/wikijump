-- Removing a site's preferred custom domain deletes the site_domain row
-- while site.preferred_domain still references it; the 2022 foreign key
-- has NO ACTION, so the removal fails with a raw FK violation. Deleting
-- the domain row now clears the reference instead, so the site falls
-- back to its canonical domain, as if the preference had been reset
-- first.
ALTER TABLE site DROP CONSTRAINT site_preferred_domain_fk;
ALTER TABLE site
    ADD CONSTRAINT site_preferred_domain_fk
    FOREIGN KEY (preferred_domain) REFERENCES site_domain(domain)
    ON DELETE SET NULL;
