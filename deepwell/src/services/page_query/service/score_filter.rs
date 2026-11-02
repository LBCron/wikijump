use super::super::structs::{ComparisonOperation, ScoreSelector};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::page::{self, Entity as Page};
use crate::services::score::ScoreValue;
use sea_orm::{
    ColumnTrait, DatabaseTransaction, EntityTrait, ExprTrait, QueryFilter, QuerySelect,
};
use sea_query::{Expr, SimpleExpr, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ScoreFilterCacheValue {
    Integer(i64),
    Float(u64),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct ScoreFilterCacheKey {
    site_id: i64,
    selectors: Vec<(u8, ScoreFilterCacheValue)>,
}

impl ScoreFilterCacheKey {
    pub(super) fn new(site_id: i64, selectors: &[ScoreSelector]) -> Self {
        Self {
            site_id,
            selectors: selectors
                .iter()
                .map(|selector| {
                    let value = match selector.score {
                        ScoreValue::Integer(value) => {
                            ScoreFilterCacheValue::Integer(value)
                        }
                        ScoreValue::Float(value) => {
                            ScoreFilterCacheValue::Float(value.to_bits())
                        }
                    };
                    let comparison_code = match selector.comparison {
                        ComparisonOperation::GreaterThan => 0,
                        ComparisonOperation::LessThan => 1,
                        ComparisonOperation::GreaterOrEqualThan => 2,
                        ComparisonOperation::LessOrEqualThan => 3,
                        ComparisonOperation::Equal => 4,
                        ComparisonOperation::NotEqual => 5,
                    };
                    (comparison_code, value)
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ScoreFilterCacheLookup {
    FirstUse,
    RepeatedUnmaterialized,
    Materialized(ScoreFilterMembership),
    Uncacheable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ScoreFilterMembership {
    Included(Vec<i64>),
    Excluded(Vec<i64>),
}

impl ScoreFilterMembership {
    fn len(&self) -> usize {
        match self {
            Self::Included(page_ids) | Self::Excluded(page_ids) => page_ids.len(),
        }
    }
}

pub(super) const MAX_CACHED_SCORE_FILTER_PAGE_IDS: usize = 50_000;
pub(super) const MAX_TOTAL_CACHED_SCORE_FILTER_PAGE_IDS: usize = 100_000;

#[derive(Debug, Default)]
pub(crate) struct PageQueryScoreFilterCache {
    pub(super) seen: BTreeSet<ScoreFilterCacheKey>,
    pub(super) memberships: BTreeMap<ScoreFilterCacheKey, ScoreFilterMembership>,
    pub(super) cached_page_ids: usize,
    pub(super) uncacheable: BTreeSet<ScoreFilterCacheKey>,
}

#[derive(Debug, Default)]
pub(crate) struct PageQueryScoreFilterSession {
    pub(super) seen: BTreeSet<ScoreFilterCacheKey>,
}

impl PageQueryScoreFilterSession {
    pub(super) fn register_use(&mut self, key: &ScoreFilterCacheKey) -> bool {
        self.seen.insert(key.clone())
    }
}

impl PageQueryScoreFilterCache {
    pub(super) fn materialized_membership(
        &self,
        key: &ScoreFilterCacheKey,
    ) -> Option<ScoreFilterMembership> {
        if self.uncacheable.contains(key) {
            return None;
        }
        self.memberships.get(key).cloned()
    }

    pub(super) fn touch(
        &mut self,
        key: &ScoreFilterCacheKey,
        register_logical_use: bool,
    ) -> ScoreFilterCacheLookup {
        if self.uncacheable.contains(key) {
            return ScoreFilterCacheLookup::Uncacheable;
        }
        if let Some(membership) = self.memberships.get(key) {
            return ScoreFilterCacheLookup::Materialized(membership.clone());
        }
        if self.seen.contains(key) {
            if register_logical_use {
                return ScoreFilterCacheLookup::RepeatedUnmaterialized;
            }
            return ScoreFilterCacheLookup::FirstUse;
        }
        if register_logical_use {
            self.seen.insert(key.clone());
        } else {
            debug_assert!(false, "a score key must be registered on its first batch");
        }
        ScoreFilterCacheLookup::FirstUse
    }

    pub(super) fn insert(
        &mut self,
        key: ScoreFilterCacheKey,
        membership: ScoreFilterMembership,
    ) {
        debug_assert!(membership.len() <= MAX_CACHED_SCORE_FILTER_PAGE_IDS);
        let membership_len = membership.len();
        let replaced_len = self
            .memberships
            .get(&key)
            .map_or(0, ScoreFilterMembership::len);
        let new_total = self.cached_page_ids - replaced_len + membership_len;
        if new_total > MAX_TOTAL_CACHED_SCORE_FILTER_PAGE_IDS {
            self.mark_uncacheable(key);
            return;
        }

        self.memberships.insert(key, membership);
        self.cached_page_ids = new_total;
    }

    pub(super) fn mark_uncacheable(&mut self, key: ScoreFilterCacheKey) {
        if let Some(membership) = self.memberships.remove(&key) {
            self.cached_page_ids -= membership.len();
        }
        self.uncacheable.insert(key);
    }
}

pub(super) async fn apply_score_filters(
    txn: &DatabaseTransaction,
    query: sea_orm::Select<page::Entity>,
    queried_site_id: i64,
    score: &[ScoreSelector],
    mut cache: Option<&mut PageQueryScoreFilterCache>,
    session: Option<&mut PageQueryScoreFilterSession>,
) -> Result<sea_orm::Select<page::Entity>> {
    if score.is_empty() {
        return Ok(query);
    }

    let key = ScoreFilterCacheKey::new(queried_site_id, score);
    if let Some(membership) = cache
        .as_deref()
        .and_then(|cache| cache.materialized_membership(&key))
    {
        return Ok(query.filter(score_membership_condition(membership)));
    }

    let observed_candidates = query
        .clone()
        .select_only()
        .column(page::Column::PageId)
        .distinct()
        .limit((MAX_CORRELATED_SCORE_CANDIDATES + 1) as u64)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .or_raise(|| {
            Error::new(
                "failed to plan ListPages score filter",
                ErrorType::PageQuery,
            )
        })?
        .len();

    match score_filter_plan_from_probe(queried_site_id, observed_candidates) {
        ScoreFilterPlan::CandidateCorrelated => Ok(query.filter(
            score_selectors_condition(score, ScoreFilterPlan::CandidateCorrelated),
        )),
        ScoreFilterPlan::SiteWide { site_id } => {
            let key = ScoreFilterCacheKey::new(site_id, score);
            let register_logical_use = session
                .map(|session| session.register_use(&key))
                .unwrap_or(true);
            let lookup = cache
                .as_deref_mut()
                .map(|cache| cache.touch(&key, register_logical_use));

            match lookup {
                Some(ScoreFilterCacheLookup::Materialized(membership)) => {
                    Ok(query.filter(score_membership_condition(membership)))
                }
                Some(ScoreFilterCacheLookup::RepeatedUnmaterialized) => {
                    match materialize_score_membership(txn, score, site_id).await? {
                        Some(membership) => {
                            cache
                                .expect("score cache should still be available")
                                .insert(key, membership.clone());
                            Ok(query.filter(score_membership_condition(membership)))
                        }
                        None => {
                            cache
                                .expect("score cache should still be available")
                                .mark_uncacheable(key);
                            Ok(query.filter(score_selectors_condition(
                                score,
                                ScoreFilterPlan::SiteWide { site_id },
                            )))
                        }
                    }
                }
                Some(ScoreFilterCacheLookup::FirstUse)
                | Some(ScoreFilterCacheLookup::Uncacheable)
                | None => Ok(query.filter(score_selectors_condition(
                    score,
                    ScoreFilterPlan::SiteWide { site_id },
                ))),
            }
        }
    }
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub(super) enum ScoreFilterPlan {
    SiteWide { site_id: i64 },
    CandidateCorrelated,
}

pub(super) const MAX_CORRELATED_SCORE_CANDIDATES: usize = 512;

pub(super) fn score_filter_plan_from_probe(
    site_id: i64,
    observed_candidates: usize,
) -> ScoreFilterPlan {
    if observed_candidates <= MAX_CORRELATED_SCORE_CANDIDATES {
        ScoreFilterPlan::CandidateCorrelated
    } else {
        ScoreFilterPlan::SiteWide { site_id }
    }
}

pub(super) fn score_comparison_operator(comparison: ComparisonOperation) -> &'static str {
    match comparison {
        ComparisonOperation::GreaterThan => ">",
        ComparisonOperation::LessThan => "<",
        ComparisonOperation::GreaterOrEqualThan => ">=",
        ComparisonOperation::LessOrEqualThan => "<=",
        ComparisonOperation::Equal => "=",
        ComparisonOperation::NotEqual => "!=",
    }
}

fn score_selector_value(selector: &ScoreSelector) -> Value {
    match selector.score {
        ScoreValue::Integer(value) => Value::BigInt(Some(value)),
        ScoreValue::Float(value) => Value::Double(Some(value)),
    }
}

pub(super) fn score_selectors_condition(
    selectors: &[ScoreSelector],
    plan: ScoreFilterPlan,
) -> SimpleExpr {
    debug_assert!(!selectors.is_empty());
    match plan {
        ScoreFilterPlan::SiteWide { site_id } => {
            let conditions = selectors
                .iter()
                .enumerate()
                .map(|(index, selector)| {
                    format!(
                        "filtered_score.effective_score {} ${}",
                        score_comparison_operator(selector.comparison),
                        index + 2,
                    )
                })
                .collect::<Vec<_>>()
                .join(" AND ");
            let values = std::iter::once(Value::BigInt(Some(site_id)))
                .chain(selectors.iter().map(score_selector_value))
                .collect::<Vec<_>>();
            Expr::cust_with_values(
                format!(
                    "page.page_id IN (\
                        SELECT filtered_score.page_id \
                        FROM (\
                            SELECT scored_page.page_id, \
                                CASE \
                                    WHEN COALESCE(score_category.rating_type, score_default_category.rating_type, 'plus_minus') = 'stars' \
                                    THEN COALESCE(AVG(score_vote.value) FILTER (WHERE score_vote.rating_system = 'stars'), 0) \
                                    ELSE COALESCE(score_snapshot.imported_rating, 0) + COALESCE(SUM(score_vote.value) FILTER (WHERE score_vote.rating_system = 'points' AND (score_snapshot.imported_rating IS NULL OR score_vote.from_wikidot = FALSE)), 0) \
                                END AS effective_score \
                            FROM page scored_page \
                            JOIN page_category score_category \
                                ON score_category.category_id = scored_page.page_category_id \
                            LEFT JOIN page_category score_default_category \
                                ON score_default_category.site_id = scored_page.site_id \
                                AND score_default_category.slug = '_default' \
                            LEFT JOIN wikidot_page_snapshot score_snapshot \
                                ON score_snapshot.page_id = scored_page.page_id \
                            LEFT JOIN page_vote score_vote \
                                ON score_vote.page_id = scored_page.page_id \
                                AND score_vote.deleted_at IS NULL \
                                AND score_vote.disabled_at IS NULL \
                            WHERE scored_page.site_id = $1 \
                                AND scored_page.deleted_at IS NULL \
                            GROUP BY scored_page.page_id, score_snapshot.imported_rating, score_category.rating_type, score_default_category.rating_type\
                        ) filtered_score \
                        WHERE {conditions}\
                    )"
                ),
                values,
            )
        }
        ScoreFilterPlan::CandidateCorrelated => {
            let conditions = selectors
                .iter()
                .enumerate()
                .map(|(index, selector)| {
                    format!(
                        "filtered_score.effective_score {} ${}",
                        score_comparison_operator(selector.comparison),
                        index + 1,
                    )
                })
                .collect::<Vec<_>>()
                .join(" AND ");
            let values = selectors
                .iter()
                .map(score_selector_value)
                .collect::<Vec<_>>();
            Expr::cust_with_values(
                format!(
                    "EXISTS (\
                        SELECT 1 \
                        FROM (\
                            SELECT CASE \
                                WHEN COALESCE(score_category.rating_type, score_default_category.rating_type, 'plus_minus') = 'stars' \
                                THEN COALESCE(AVG(score_vote.value) FILTER (WHERE score_vote.rating_system = 'stars'), 0) \
                                ELSE COALESCE(score_snapshot.imported_rating, 0) + COALESCE(SUM(score_vote.value) FILTER (WHERE score_vote.rating_system = 'points' AND (score_snapshot.imported_rating IS NULL OR score_vote.from_wikidot = FALSE)), 0) \
                            END AS effective_score \
                            FROM page scored_page \
                            JOIN page_category score_category \
                                ON score_category.category_id = scored_page.page_category_id \
                            LEFT JOIN page_category score_default_category \
                                ON score_default_category.site_id = scored_page.site_id \
                                AND score_default_category.slug = '_default' \
                            LEFT JOIN wikidot_page_snapshot score_snapshot \
                                ON score_snapshot.page_id = scored_page.page_id \
                            LEFT JOIN page_vote score_vote \
                                ON score_vote.page_id = scored_page.page_id \
                                AND score_vote.deleted_at IS NULL \
                                AND score_vote.disabled_at IS NULL \
                            WHERE scored_page.page_id = page.page_id \
                            GROUP BY scored_page.page_id, score_snapshot.imported_rating, score_category.rating_type, score_default_category.rating_type\
                        ) filtered_score \
                        WHERE {conditions}\
                    )"
                ),
                values,
            )
        }
    }
}

pub(super) fn score_membership_condition(
    membership: ScoreFilterMembership,
) -> SimpleExpr {
    let (operator, page_ids) = match membership {
        ScoreFilterMembership::Included(page_ids) => ("$1 = ANY($2)", page_ids),
        ScoreFilterMembership::Excluded(page_ids) => ("$1 != ALL($2)", page_ids),
    };
    Expr::cust_with_exprs(
        operator,
        [Expr::col((Page, page::Column::PageId)), Expr::val(page_ids)],
    )
}

fn zero_satisfies_score_selector(selector: &ScoreSelector) -> bool {
    match selector.score {
        ScoreValue::Integer(value) => match selector.comparison {
            ComparisonOperation::GreaterThan => 0 > value,
            ComparisonOperation::LessThan => 0 < value,
            ComparisonOperation::GreaterOrEqualThan => 0 >= value,
            ComparisonOperation::LessOrEqualThan => 0 <= value,
            ComparisonOperation::Equal => value == 0,
            ComparisonOperation::NotEqual => value != 0,
        },
        ScoreValue::Float(value) if value.is_finite() => match selector.comparison {
            ComparisonOperation::GreaterThan => 0.0 > value,
            ComparisonOperation::LessThan => 0.0 < value,
            ComparisonOperation::GreaterOrEqualThan => 0.0 >= value,
            ComparisonOperation::LessOrEqualThan => 0.0 <= value,
            ComparisonOperation::Equal => value == 0.0,
            ComparisonOperation::NotEqual => value != 0.0,
        },
        ScoreValue::Float(_) => false,
    }
}

fn zero_satisfies_score_selectors(selectors: &[ScoreSelector]) -> bool {
    selectors.iter().all(zero_satisfies_score_selector)
}

pub(super) fn score_membership_polarity_order(selectors: &[ScoreSelector]) -> [bool; 2] {
    let prefer_excluded = zero_satisfies_score_selectors(selectors);
    [prefer_excluded, !prefer_excluded]
}

async fn score_membership_page_ids(
    txn: &DatabaseTransaction,
    selectors: &[ScoreSelector],
    site_id: i64,
    excluded: bool,
) -> Result<Option<Vec<i64>>> {
    let score_condition =
        score_selectors_condition(selectors, ScoreFilterPlan::SiteWide { site_id });
    let page_ids = Page::find()
        .select_only()
        .column(page::Column::PageId)
        .filter(page::Column::SiteId.eq(site_id))
        .filter(page::Column::DeletedAt.is_null())
        .filter(if excluded {
            score_condition.not()
        } else {
            score_condition
        })
        .limit((MAX_CACHED_SCORE_FILTER_PAGE_IDS + 1) as u64)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .or_raise(|| {
            Error::new(
                "failed to materialize ListPages score filter",
                ErrorType::PageQuery,
            )
        })?;
    Ok(bounded_score_page_ids(page_ids))
}

async fn materialize_score_membership(
    txn: &DatabaseTransaction,
    selectors: &[ScoreSelector],
    site_id: i64,
) -> Result<Option<ScoreFilterMembership>> {
    for excluded in score_membership_polarity_order(selectors) {
        if let Some(page_ids) =
            score_membership_page_ids(txn, selectors, site_id, excluded).await?
        {
            return Ok(Some(if excluded {
                ScoreFilterMembership::Excluded(page_ids)
            } else {
                ScoreFilterMembership::Included(page_ids)
            }));
        }
    }
    Ok(None)
}

pub(super) fn bounded_score_page_ids(page_ids: Vec<i64>) -> Option<Vec<i64>> {
    if page_ids.len() > MAX_CACHED_SCORE_FILTER_PAGE_IDS {
        None
    } else {
        Some(page_ids)
    }
}

#[cfg(test)]
pub(super) fn score_selector_condition(
    selector: &ScoreSelector,
    plan: ScoreFilterPlan,
) -> SimpleExpr {
    score_selectors_condition(std::slice::from_ref(selector), plan)
}
