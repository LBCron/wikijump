use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

pub(in crate::services::render) const COMPAT_TEXT_MARKER_PREFIX: &str =
    "WIKIJUMPWIKIDOTCOMPATTEXT";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(in crate::services::render) struct CompatTextFragments {
    namespace: String,
    fragments: Vec<String>,
    #[serde(default)]
    cleanup_exempt_fragments: BTreeSet<usize>,
}

impl CompatTextFragments {
    pub(in crate::services::render) fn new(untrusted_source: &str) -> Self {
        let namespace = loop {
            let candidate =
                format!("{COMPAT_TEXT_MARKER_PREFIX}{}I", Uuid::new_v4().as_simple());
            if !untrusted_source.contains(&candidate) {
                break candidate;
            }
        };
        Self {
            namespace,
            fragments: Vec::new(),
            cleanup_exempt_fragments: BTreeSet::new(),
        }
    }

    fn push_owned(&mut self, text: String) -> (String, usize) {
        let index = self.fragments.len();
        self.fragments.push(text);
        (format!("{}{index}X", self.namespace), index)
    }

    pub(in crate::services::render) fn push(&mut self, text: &str) -> String {
        self.push_owned(text.to_owned()).0
    }

    pub(in crate::services::render) fn push_authored_runtime_marker_literal(
        &mut self,
        text: &str,
    ) -> String {
        let (marker, index) = self.push_owned(text.to_owned());
        self.cleanup_exempt_fragments.insert(index);
        marker
    }

    pub(in crate::services::render) fn push_escaped_html_text(
        &mut self,
        text: &str,
    ) -> String {
        let (marker, index) = self.push_owned(escape_html_text(text));
        self.cleanup_exempt_fragments.insert(index);
        marker
    }

    pub(in crate::services::render) fn push_tracked_escaped_html_text(
        &mut self,
        text: &str,
    ) -> (String, usize) {
        let (marker, index) = self.push_owned(escape_html_text(text));
        self.cleanup_exempt_fragments.insert(index);
        (marker, index)
    }

    pub(in crate::services::render) fn logical_len_for_tracked_fragments(
        &self,
        text: &str,
        tracked: &BTreeSet<usize>,
    ) -> Option<usize> {
        if tracked.is_empty() || !text.contains(&self.namespace) {
            return Some(text.len());
        }

        let mut logical_len = text.len();
        let mut cursor = 0;
        while let Some(offset) = text[cursor..].find(&self.namespace) {
            let start = cursor + offset;
            if let Some((index, marker_len)) = self.marker_at(&text[start..]) {
                if tracked.contains(&index) {
                    logical_len = logical_len
                        .checked_sub(marker_len)?
                        .checked_add(self.fragments[index].len())?;
                }
                cursor = start + marker_len;
            } else {
                cursor = start + self.namespace.len();
            }
        }
        Some(logical_len)
    }

    pub(in crate::services::render) fn is_empty(&self) -> bool {
        self.fragments.is_empty()
    }

    pub(in crate::services::render) fn contains_marker(&self, text: &str) -> bool {
        !self.fragments.is_empty()
            && text
                .to_ascii_lowercase()
                .contains(&self.namespace.to_ascii_lowercase())
    }

    pub(in crate::services::render) fn restore(&self, text: &str) -> String {
        if self.fragments.is_empty() || !text.contains(&self.namespace) {
            return text.to_owned();
        }

        let mut output = String::with_capacity(text.len());
        let mut cursor = 0;
        while let Some(offset) = text[cursor..].find(&self.namespace) {
            let start = cursor + offset;
            output.push_str(&text[cursor..start]);
            if let Some((index, len)) = self.marker_at(&text[start..]) {
                output.push_str(&self.fragments[index]);
                cursor = start + len;
            } else {
                output.push_str(&self.namespace);
                cursor = start + self.namespace.len();
            }
        }
        output.push_str(&text[cursor..]);
        output
    }

    pub(in crate::services::render) fn restore_with_cleanup(
        &self,
        text: &str,
        cleanup: impl Fn(&str) -> String,
    ) -> String {
        self.restore_with_resolver_and_cleanup(text, str::to_owned, cleanup)
    }

    pub(in crate::services::render) fn restore_with_resolver_and_cleanup(
        &self,
        text: &str,
        resolve: impl Fn(&str) -> String,
        cleanup: impl Fn(&str) -> String,
    ) -> String {
        if self.fragments.is_empty() || !text.contains(&self.namespace) {
            return cleanup(&resolve(text));
        }

        let mut output = String::with_capacity(text.len());
        let mut cursor = 0;
        while let Some(offset) = text[cursor..].find(&self.namespace) {
            let start = cursor + offset;
            output.push_str(&cleanup(&resolve(&text[cursor..start])));
            if let Some((index, len)) = self.marker_at(&text[start..]) {
                let fragment = &self.fragments[index];
                let fragment = resolve(fragment);
                if self.cleanup_exempt_fragments.contains(&index) {
                    output.push_str(&fragment);
                } else {
                    output.push_str(&cleanup(&fragment));
                }
                cursor = start + len;
            } else {
                output.push_str(&self.namespace);
                cursor = start + self.namespace.len();
            }
        }
        output.push_str(&cleanup(&resolve(&text[cursor..])));
        output
    }

    pub(in crate::services::render) fn restore_ignoring_case(
        &self,
        text: &str,
    ) -> String {
        if self.fragments.is_empty() {
            return text.to_owned();
        }
        let namespace = self.namespace.to_ascii_lowercase();
        let lowered = text.to_ascii_lowercase();
        if !lowered.contains(&namespace) {
            return text.to_owned();
        }

        let mut output = String::with_capacity(text.len());
        let mut cursor = 0;
        while let Some(offset) = lowered[cursor..].find(&namespace) {
            let start = cursor + offset;
            output.push_str(&text[cursor..start]);
            let suffix = &lowered[start + namespace.len()..];
            let digits = suffix.bytes().take_while(u8::is_ascii_digit).count();
            let index = (digits > 0 && suffix.as_bytes().get(digits) == Some(&b'x'))
                .then(|| suffix[..digits].parse::<usize>().ok())
                .flatten()
                .filter(|index| *index < self.fragments.len());
            match index {
                Some(index) => {
                    output.push_str(&self.fragments[index]);
                    cursor = start + namespace.len() + digits + 1;
                }
                None => {
                    output.push_str(&text[start..start + namespace.len()]);
                    cursor = start + namespace.len();
                }
            }
        }
        output.push_str(&text[cursor..]);
        output
    }

    fn marker_at(&self, text: &str) -> Option<(usize, usize)> {
        let suffix = text.strip_prefix(&self.namespace)?;
        let digits = suffix.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || suffix.as_bytes().get(digits) != Some(&b'X') {
            return None;
        }
        let index = suffix[..digits].parse::<usize>().ok()?;
        (index < self.fragments.len())
            .then_some((index, self.namespace.len() + digits + 1))
    }

    pub(in crate::services::render) fn issued_marker_len_at(
        &self,
        text: &str,
    ) -> Option<usize> {
        self.marker_at(text).map(|(_, len)| len).or_else(|| {
            let lowered = text.to_ascii_lowercase();
            let namespace = self.namespace.to_ascii_lowercase();
            let suffix = lowered.strip_prefix(&namespace)?;
            let digits = suffix.bytes().take_while(u8::is_ascii_digit).count();
            let index = (digits > 0 && suffix.as_bytes().get(digits) == Some(&b'x'))
                .then(|| suffix[..digits].parse::<usize>().ok())
                .flatten()?;
            (index < self.fragments.len()).then_some(namespace.len() + digits + 1)
        })
    }
}

pub(in crate::services::render) fn escape_html_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_only_registered_fragments_without_recursion() {
        let mut fragments = CompatTextFragments::new("authored source");
        let marker_shaped = format!("{COMPAT_TEXT_MARKER_PREFIX}deadbeefI0X");
        let first = fragments.push(&format!("{{$first-{marker_shaped}}}"));
        let second = fragments.push("{$second}");
        let foreign =
            format!("{COMPAT_TEXT_MARKER_PREFIX}ffffffffffffffffffffffffffffffffI0X");

        assert_eq!(
            fragments.restore(&format!("{first}|{second}|{foreign}")),
            format!("{{$first-{marker_shaped}}}|{{$second}}|{foreign}"),
        );
    }

    #[test]
    fn malformed_and_out_of_range_markers_remain_literal() {
        let mut fragments = CompatTextFragments::new("");
        let valid = fragments.push("{$valid}");
        let malformed = format!("{}nopeX", fragments.namespace);
        let out_of_range = format!("{}9X", fragments.namespace);

        assert_eq!(fragments.restore(&valid), "{$valid}");
        assert_eq!(fragments.restore(&malformed), malformed);
        assert_eq!(fragments.restore(&out_of_range), out_of_range);
    }

    #[test]
    fn cleanup_preserves_authored_marker_text_in_registered_fragments() {
        let mut fragments = CompatTextFragments::new("");
        let marker =
            fragments.push_authored_runtime_marker_literal("authored INTERNAL text");
        let text = format!("before INTERNAL {marker} after");

        assert_eq!(
            fragments.restore_with_cleanup(&text, |text| text.replace("INTERNAL", "")),
            "before  authored INTERNAL text after",
        );
    }

    #[test]
    fn cleanup_removes_nested_runtime_markers_but_preserves_authored_literals() {
        let nested_runtime_marker =
            "WIKIJUMPWIKIDOTCOMPATHTML0123456789abcdef0123456789abcdefI7X";
        let mut fragments = CompatTextFragments::new("");
        let generated_fragment =
            fragments.push(&format!("generated {nested_runtime_marker}"));
        let authored_literal =
            fragments.push_authored_runtime_marker_literal(nested_runtime_marker);
        let text = format!("{generated_fragment}|{authored_literal}");

        assert_eq!(
            fragments.restore_with_cleanup(&text, |text| {
                text.replace(nested_runtime_marker, "")
            }),
            format!("generated |{nested_runtime_marker}"),
        );
    }

    #[test]
    fn nested_registry_resolution_keeps_escaped_authored_marker_literals() {
        let nested_runtime_marker =
            "WIKIJUMPWIKIDOTCOMPATHTML0123456789abcdef0123456789abcdefI7X";
        let authored_marker =
            "WIKIJUMPWIKIDOTCOMPATTEXTffffffffffffffffffffffffffffffffI0X";
        let mut fragments = CompatTextFragments::new("");
        let nested = fragments.push(&format!("generated {nested_runtime_marker}"));
        let authored = fragments.push_escaped_html_text(authored_marker);
        let text = format!("{nested}|{authored}");

        assert_eq!(
            fragments.restore_with_resolver_and_cleanup(
                &text,
                |text| text.replace(nested_runtime_marker, "resolved HTML"),
                |text| {
                    text.replace(nested_runtime_marker, "")
                        .replace(authored_marker, "")
                },
            ),
            format!("generated resolved HTML|{authored_marker}"),
        );
    }

    #[test]
    fn escaped_html_text_uses_the_same_unforgeable_registry() {
        let authored_marker =
            format!("{COMPAT_TEXT_MARKER_PREFIX}ffffffffffffffffffffffffffffffffI0X");
        let mut fragments = CompatTextFragments::new(&authored_marker);
        let dangerous = fragments.push_escaped_html_text("<script>&\"'");
        let second = fragments.push_escaped_html_text("[[module ListPages]]");

        assert_eq!(
            fragments.restore(&format!("{dangerous}|{second}|{authored_marker}")),
            format!(
                "&lt;script&gt;&amp;&quot;&#39;|[[module ListPages]]|{authored_marker}"
            ),
        );
    }

    #[test]
    fn tracked_logical_length_counts_surviving_restored_fragments_once_per_marker() {
        let mut fragments = CompatTextFragments::new("");
        let (tracked, tracked_index) =
            fragments.push_tracked_escaped_html_text("[[<unsafe>&]]");
        let untracked = fragments.push("ordinary");
        let source = format!("{tracked}|{tracked}|{untracked}");
        let tracked_indices = BTreeSet::from([tracked_index]);
        let restored_tracked_len = escape_html_text("[[<unsafe>&]]").len();

        assert_eq!(
            fragments.logical_len_for_tracked_fragments(&source, &tracked_indices,),
            Some(restored_tracked_len * 2 + 2 + untracked.len()),
        );
        assert_eq!(
            fragments.logical_len_for_tracked_fragments(
                "marker was removed",
                &tracked_indices,
            ),
            Some("marker was removed".len()),
        );
    }
}
