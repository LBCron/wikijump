/*
 * services/render/literal_regions/parser_candidates/arena.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use std::collections::HashMap;
use std::fmt;
use std::ops::Range;

const MAX_EMIT_SET_NODES: usize = 262_144;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(in crate::services::render::literal_regions) struct LeafId(u32);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(in crate::services::render::literal_regions) struct EmitSetId(u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::services::render) struct EmitSetBudgetExceeded {
    max_nodes: usize,
}

impl fmt::Display for EmitSetBudgetExceeded {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "literal candidate graph exceeds its {}-node render budget",
            self.max_nodes,
        )
    }
}

impl std::error::Error for EmitSetBudgetExceeded {}

pub(in crate::services::render::literal_regions) type EmitSetResult<T> =
    Result<T, EmitSetBudgetExceeded>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EmitSetNode {
    Empty,
    Leaf(LeafId),
    Union(EmitSetId, EmitSetId),
}

#[derive(Debug)]
pub(in crate::services::render::literal_regions) struct EmitSetArena {
    leaves: Vec<Range<usize>>,
    leaf_nodes: Vec<EmitSetId>,
    nodes: Vec<EmitSetNode>,
    unions: HashMap<(EmitSetId, EmitSetId), EmitSetId>,
    max_nodes: usize,
}

#[derive(Debug)]
pub(in crate::services::render::literal_regions) struct EmitRangeIndex {
    ranges: Vec<Range<usize>>,
    tree_base: usize,
    tree: Vec<EmitSetId>,
}

impl Default for EmitSetArena {
    fn default() -> Self {
        Self {
            leaves: Vec::new(),
            leaf_nodes: Vec::new(),
            nodes: vec![EmitSetNode::Empty],
            unions: HashMap::new(),
            max_nodes: MAX_EMIT_SET_NODES,
        }
    }
}

impl EmitSetArena {
    pub(in crate::services::render::literal_regions) const EMPTY: EmitSetId =
        EmitSetId(0);

    pub(in crate::services::render::literal_regions) fn leaf(
        &mut self,
        range: Range<usize>,
    ) -> EmitSetResult<(LeafId, EmitSetId)> {
        assert!(range.start < range.end, "literal emits must be nonempty");
        let set = self.next_set_id()?;
        let leaf = LeafId(index_to_u32(self.leaves.len(), "literal leaf"));
        self.leaves.push(range);
        self.nodes.push(EmitSetNode::Leaf(leaf));
        self.leaf_nodes.push(set);
        Ok((leaf, set))
    }

    pub(in crate::services::render::literal_regions) fn union(
        &mut self,
        left: EmitSetId,
        right: EmitSetId,
    ) -> EmitSetResult<EmitSetId> {
        self.assert_set(left);
        self.assert_set(right);
        if left == Self::EMPTY {
            return Ok(right);
        }
        if right == Self::EMPTY || left == right {
            return Ok(left);
        }
        let pair = if left.0 < right.0 {
            (left, right)
        } else {
            (right, left)
        };
        if let Some(&set) = self.unions.get(&pair) {
            return Ok(set);
        }
        let set = self.next_set_id()?;
        self.nodes.push(EmitSetNode::Union(pair.0, pair.1));
        self.unions.insert(pair, set);
        Ok(set)
    }

    pub(in crate::services::render::literal_regions) fn leaf_set(
        &self,
        leaf: LeafId,
    ) -> EmitSetId {
        let index = leaf.0 as usize;
        *self
            .leaf_nodes
            .get(index)
            .expect("leaf ID must belong to this arena")
    }

    pub(in crate::services::render::literal_regions) fn materialize(
        &self,
        roots: impl IntoIterator<Item = EmitSetId>,
    ) -> Vec<Range<usize>> {
        let mut seen_nodes = vec![false; self.nodes.len()];
        let mut seen_leaves = vec![false; self.leaves.len()];
        let mut stack: Vec<_> = roots.into_iter().collect();
        while let Some(set) = stack.pop() {
            self.assert_set(set);
            let index = set.0 as usize;
            if std::mem::replace(&mut seen_nodes[index], true) {
                continue;
            }
            match self.nodes[index] {
                EmitSetNode::Empty => {}
                EmitSetNode::Leaf(leaf) => seen_leaves[leaf.0 as usize] = true,
                EmitSetNode::Union(left, right) => {
                    stack.push(right);
                    stack.push(left);
                }
            }
        }

        let mut ranges: Vec<_> = seen_leaves
            .into_iter()
            .enumerate()
            .filter(|(_, selected)| *selected)
            .map(|(index, _)| self.leaves[index].clone())
            .collect();
        ranges.sort_unstable_by_key(|range| (range.start, range.end));
        coalesce_ranges(ranges)
    }

    pub(in crate::services::render::literal_regions) fn range(
        &self,
        leaf: LeafId,
    ) -> &Range<usize> {
        &self.leaves[leaf.0 as usize]
    }

    fn assert_set(&self, set: EmitSetId) {
        assert!(
            (set.0 as usize) < self.nodes.len(),
            "emit-set ID must belong to this arena",
        );
    }

    fn next_set_id(&self) -> EmitSetResult<EmitSetId> {
        if self.nodes.len() >= self.max_nodes {
            return Err(EmitSetBudgetExceeded {
                max_nodes: self.max_nodes,
            });
        }
        Ok(EmitSetId(index_to_u32(self.nodes.len(), "emit-set node")))
    }

    #[cfg(test)]
    fn with_max_nodes(max_nodes: usize) -> Self {
        assert!(max_nodes > 0, "the empty emit-set node needs a budget slot");
        Self {
            max_nodes,
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn node_count(&self) -> usize {
        self.nodes.len()
    }
}

impl EmitRangeIndex {
    pub(in crate::services::render::literal_regions) fn new(
        arena: &mut EmitSetArena,
        ranges: Vec<Range<usize>>,
    ) -> EmitSetResult<Self> {
        debug_assert!(
            ranges.windows(2).all(|pair| pair[0].end <= pair[1].start),
            "indexed emits must be source ordered and disjoint",
        );
        let tree_base = ranges.len().max(1).next_power_of_two();
        let mut tree = vec![EmitSetArena::EMPTY; tree_base * 2];
        for (index, range) in ranges.iter().cloned().enumerate() {
            let (_, set) = arena.leaf(range)?;
            tree[tree_base + index] = set;
        }
        for index in (1..tree_base).rev() {
            tree[index] = arena.union(tree[index * 2], tree[index * 2 + 1])?;
        }
        Ok(Self {
            ranges,
            tree_base,
            tree,
        })
    }

    pub(in crate::services::render::literal_regions) fn contained_set(
        &self,
        arena: &mut EmitSetArena,
        container: Range<usize>,
    ) -> EmitSetResult<EmitSetId> {
        let mut first = self
            .ranges
            .partition_point(|range| range.end <= container.start);
        if self
            .ranges
            .get(first)
            .is_some_and(|range| range.start < container.start)
        {
            first += 1;
        }
        let mut end = self
            .ranges
            .partition_point(|range| range.start < container.end);
        while end > first && self.ranges[end - 1].end > container.end {
            end -= 1;
        }
        if first >= end || self.ranges[first].end > container.end {
            return Ok(EmitSetArena::EMPTY);
        }

        let mut left = self.tree_base + first;
        let mut right = self.tree_base + end;
        let mut left_set = EmitSetArena::EMPTY;
        let mut right_set = EmitSetArena::EMPTY;
        while left < right {
            if left % 2 == 1 {
                left_set = arena.union(left_set, self.tree[left])?;
                left += 1;
            }
            if right % 2 == 1 {
                right -= 1;
                right_set = arena.union(self.tree[right], right_set)?;
            }
            left /= 2;
            right /= 2;
        }
        arena.union(left_set, right_set)
    }
}

fn index_to_u32(index: usize, what: &str) -> u32 {
    u32::try_from(index).unwrap_or_else(|_| panic!("too many {what}s"))
}

fn coalesce_ranges(ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let mut output: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(previous) = output.last_mut()
            && range.start <= previous.end
        {
            previous.end = previous.end.max(range.end);
        } else {
            output.push(range);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{EmitRangeIndex, EmitSetArena};

    #[test]
    fn shared_deep_sets_materialize_iteratively_once() {
        let mut arena = EmitSetArena::default();
        let mut root = EmitSetArena::EMPTY;
        for index in 0..8_192 {
            let (_, leaf) = arena.leaf(index * 2..index * 2 + 1).unwrap();
            root = arena.union(root, leaf).unwrap();
        }
        assert_eq!(arena.materialize([root]).len(), 8_192);
    }

    #[test]
    fn duplicate_and_overlapping_leaves_are_coalesced() {
        let mut arena = EmitSetArena::default();
        let (_, first) = arena.leaf(2..8).unwrap();
        let (_, second) = arena.leaf(6..12).unwrap();
        let root = arena.union(first, second).unwrap();
        assert_eq!(arena.materialize([root, first]), vec![2..12]);
    }

    #[test]
    fn range_index_reuses_union_nodes_for_contained_children() {
        let mut arena = EmitSetArena::default();
        let index =
            EmitRangeIndex::new(&mut arena, vec![1..3, 5..7, 9..11, 13..15]).unwrap();
        let middle = index.contained_set(&mut arena, 4..12).unwrap();
        assert_eq!(arena.materialize([middle]), vec![5..7, 9..11]);
        let clipped = index.contained_set(&mut arena, 6..14).unwrap();
        assert_eq!(arena.materialize([clipped]), vec![9..11]);

        let mut arena = EmitSetArena::default();
        let index = EmitRangeIndex::new(&mut arena, vec![1..10, 12..14]).unwrap();
        let after_left_overlap = index.contained_set(&mut arena, 5..15).unwrap();
        assert_eq!(arena.materialize([after_left_overlap]), vec![12..14]);
    }

    #[test]
    fn unordered_union_pairs_are_interned() {
        let mut arena = EmitSetArena::with_max_nodes(4);
        let (_, first) = arena.leaf(0..1).unwrap();
        let (_, second) = arena.leaf(2..3).unwrap();
        let union = arena.union(first, second).unwrap();
        let node_count = arena.node_count();

        assert_eq!(arena.union(first, second).unwrap(), union);
        assert_eq!(arena.union(second, first).unwrap(), union);
        assert_eq!(arena.node_count(), node_count);
        assert_eq!(arena.materialize([union]), vec![0..1, 2..3]);
    }

    #[test]
    fn repeated_non_aligned_containment_queries_stop_growing_the_arena() {
        let mut arena = EmitSetArena::default();
        let ranges = (0..1_024).map(|index| index * 2..index * 2 + 1).collect();
        let index = EmitRangeIndex::new(&mut arena, ranges).unwrap();
        let baseline = arena.node_count();
        let expected = index.contained_set(&mut arena, 2..2_046).unwrap();
        let after_first_query = arena.node_count();

        for _ in 1..4_096 {
            assert_eq!(index.contained_set(&mut arena, 2..2_046).unwrap(), expected,);
        }

        assert!(after_first_query > baseline);
        assert_eq!(arena.node_count(), after_first_query);
        assert_eq!(arena.materialize([expected]).len(), 1_022);
    }

    #[test]
    fn distinct_unions_stop_at_the_hard_node_budget() {
        const MAX_NODES: usize = 1_024;
        let mut arena = EmitSetArena::with_max_nodes(MAX_NODES);
        let ranges = (0..256).map(|index| index * 2..index * 2 + 1).collect();
        let index = EmitRangeIndex::new(&mut arena, ranges).unwrap();
        let mut exhausted = false;

        'queries: for start in 0..255 {
            for end in start + 2..=256 {
                if index.contained_set(&mut arena, start * 2..end * 2).is_err() {
                    exhausted = true;
                    break 'queries;
                }
            }
        }

        assert!(
            exhausted,
            "distinct containment unions should exhaust the test budget"
        );
        assert_eq!(arena.node_count(), MAX_NODES);
    }
}
