use serde::{Deserialize, Serialize};

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct CompiledStyles {
    pub(crate) styles: Vec<String>,
    pub(crate) theme_previewer_blank: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedPresentationV1 {
    version: u8,
    styles: Vec<String>,
    theme_previewer_blank: bool,
}

pub(crate) fn encode(
    styles: &[String],
    theme_previewer_blank: bool,
) -> serde_json::Result<String> {
    if !theme_previewer_blank {
        return serde_json::to_string(styles);
    }
    serde_json::to_string(&SavedPresentationV1 {
        version: 1,
        styles: styles.to_vec(),
        theme_previewer_blank,
    })
}

pub(crate) fn decode(input: &str) -> serde_json::Result<CompiledStyles> {
    let value: serde_json::Value = serde_json::from_str(input)?;
    if value.is_array() {
        return Ok(CompiledStyles {
            styles: serde_json::from_value(value)?,
            theme_previewer_blank: false,
        });
    }
    let saved: SavedPresentationV1 = serde_json::from_value(value)?;
    if saved.version != 1 {
        return Err(<serde_json::Error as serde::de::Error>::custom(
            "unsupported saved presentation version",
        ));
    }
    Ok(CompiledStyles {
        styles: saved.styles,
        theme_previewer_blank: saved.theme_previewer_blank,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_styles_and_saved_blank_theme_round_trip_without_css_markers() {
        let styles = vec!["body{color:red}".to_owned()];
        assert_eq!(
            encode(&styles, false).unwrap(),
            serde_json::to_string(&styles).unwrap()
        );
        assert_eq!(
            decode(&encode(&styles, false).unwrap()).unwrap(),
            CompiledStyles {
                styles: styles.clone(),
                theme_previewer_blank: false
            }
        );
        assert_eq!(
            decode(&encode(&styles, true).unwrap()).unwrap(),
            CompiledStyles {
                styles,
                theme_previewer_blank: true
            }
        );
        for invalid in [
            r#"{"version":2,"styles":[],"theme_previewer_blank":true}"#,
            r#"{"version":1,"styles":[],"theme_previewer_blank":true,"other":true}"#,
            "null",
        ] {
            assert!(decode(invalid).is_err());
        }
    }
}
