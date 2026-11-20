//! A Tag's portrait: a recipe of component IDs from an art catalog the clients bundle and draw.
//!
//! The Control Plane keeps the recipe and its own write revision on the Tag's row, apart from the
//! Tag's revision: a portrait write changes nothing that runs, and a Tag write keeps its portrait.
//! It checks every ID against the catalogs it knows, so a client never stores a look another
//! client can't draw, and it never stores or relays an image.
use serde_json::{Value, json};
use sqlx::{Row, any::AnyRow};
use supertag_protocol::v2::{SetTagAppearanceRequest, Tag, TagAppearance};

use crate::{
    Store, StoreError,
    store::{Result, invalid, name},
};

/// The recipe schema this release reads and writes.
const RECIPE_VERSION: u32 = 1;

/// One art catalog's component IDs, and the pairs of accessories that can't be worn together.
struct Catalog {
    id: &'static str,
    heads: &'static [&'static str],
    colors: &'static [&'static str],
    expressions: &'static [&'static str],
    hats: &'static [&'static str],
    glasses: &'static [&'static str],
    headphones: &'static [&'static str],
    /// A hat and headphones that both sit on the crown.
    hat_headphones_conflicts: &'static [(&'static str, &'static str)],
}

/// Every catalog a client may save a portrait from. A catalog stays here after newer ones ship,
/// so a portrait saved from it can be saved again.
const CATALOGS: &[Catalog] = &[Catalog {
    id: "felt-v1",
    heads: &["pear", "bean"],
    colors: &["moss", "coral", "ocean"],
    expressions: &["cheerful", "curious", "sleepy"],
    hats: &["plum-beanie"],
    glasses: &["round-charcoal"],
    headphones: &["navy-over-ear"],
    hat_headphones_conflicts: &[("plum-beanie", "navy-over-ear")],
}];

fn one_of(kind: &str, value: &str, known: &[&str], catalog: &str) -> Result<()> {
    if known.contains(&value) {
        Ok(())
    } else {
        Err(invalid(&format!(
            "the {catalog} art catalog has no {kind} {value:?}"
        )))
    }
}

fn optional(kind: &str, value: &str, known: &[&str], catalog: &str) -> Result<()> {
    if value.is_empty() {
        Ok(())
    } else {
        one_of(kind, value, known, catalog)
    }
}

/// Refuses a recipe of another schema version, an unknown catalog or component, or accessories
/// that can't be worn together.
pub(crate) fn validate(appearance: &TagAppearance) -> Result<()> {
    if appearance.version != RECIPE_VERSION {
        return Err(invalid(&format!(
            "Tag appearance version {} is not supported; this release saves version {RECIPE_VERSION}",
            appearance.version
        )));
    }
    let Some(catalog) = CATALOGS
        .iter()
        .find(|catalog| catalog.id == appearance.catalog)
    else {
        return Err(invalid(&format!(
            "unknown Tag appearance catalog {:?}",
            appearance.catalog
        )));
    };
    let id = catalog.id;
    one_of("head", &appearance.head, catalog.heads, id)?;
    one_of("color", &appearance.color, catalog.colors, id)?;
    one_of(
        "expression",
        &appearance.expression,
        catalog.expressions,
        id,
    )?;
    optional("hat", &appearance.hat, catalog.hats, id)?;
    optional("glasses", &appearance.glasses, catalog.glasses, id)?;
    optional("headphones", &appearance.headphones, catalog.headphones, id)?;
    if catalog
        .hat_headphones_conflicts
        .iter()
        .any(|(hat, headphones)| appearance.hat == *hat && appearance.headphones == *headphones)
    {
        return Err(invalid(&format!(
            "hat {} and headphones {} both sit on the crown; remove one",
            appearance.hat, appearance.headphones
        )));
    }
    Ok(())
}

fn encode(appearance: &TagAppearance) -> String {
    let accessory = |value: &str| (!value.is_empty()).then(|| value.to_owned());
    json!({
        "version": appearance.version,
        "catalog": appearance.catalog,
        "head": appearance.head,
        "color": appearance.color,
        "expression": appearance.expression,
        "hat": accessory(&appearance.hat),
        "glasses": accessory(&appearance.glasses),
        "headphones": accessory(&appearance.headphones),
    })
    .to_string()
}

fn decode(stored: &str) -> Result<TagAppearance> {
    let value: Value = serde_json::from_str(stored)?;
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Ok(TagAppearance {
        version: value
            .get("version")
            .and_then(Value::as_u64)
            .and_then(|version| u32::try_from(version).ok())
            .unwrap_or_default(),
        catalog: text("catalog"),
        head: text("head"),
        color: text("color"),
        expression: text("expression"),
        hat: text("hat"),
        glasses: text("glasses"),
        headphones: text("headphones"),
    })
}

/// A Tag row's portrait and its write revision. A stored recipe is returned as it was saved,
/// even from a catalog this release no longer accepts, so clients can keep showing it.
pub(crate) fn from_row(row: &AnyRow) -> Result<(Option<TagAppearance>, u64)> {
    let appearance = row
        .try_get::<Option<String>, _>("appearance")?
        .as_deref()
        .map(decode)
        .transpose()?;
    let revision = row.try_get::<i64, _>("appearance_revision")? as u64;
    Ok((appearance, revision))
}

impl Store {
    /// Saves a Tag's portrait if it is still at `expected_revision`, in one write that touches
    /// nothing else of the Tag. The caller's authority is checked before this, as for PutTag.
    pub async fn set_tag_appearance(&self, input: SetTagAppearanceRequest) -> Result<Tag> {
        let SetTagAppearanceRequest {
            tag_id,
            appearance,
            expected_revision,
        } = input;
        name("Tag ID", &tag_id)?;
        if let Some(appearance) = &appearance {
            validate(appearance)?;
        }
        let _wake = self.hint_after_commit();
        let (mut tx, _) = self.write().await?;
        let row = sqlx::query(
            "SELECT retired_at_ms,appearance_revision FROM supertag_v2_tags WHERE tag_id=$1",
        )
        .bind(&tag_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("Tag {tag_id} was not found")))?;
        crate::tags::ensure_active(&row, &tag_id)?;
        if row.try_get::<i64, _>("appearance_revision")? as u64 != expected_revision {
            return Err(StoreError::Conflict(
                "Tag appearance revision changed".into(),
            ));
        }
        sqlx::query(
            "UPDATE supertag_v2_tags SET appearance=$1,appearance_revision=appearance_revision+1
             WHERE tag_id=$2",
        )
        .bind(appearance.as_ref().map(encode))
        .bind(&tag_id)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query(&format!("SELECT {} WHERE t.tag_id=$1", crate::tags::READ))
            .bind(&tag_id)
            .fetch_one(&mut *tx)
            .await?;
        let tag = crate::tags::tag_from_row(&row)?;
        tx.commit().await?;
        Ok(tag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recipe() -> TagAppearance {
        TagAppearance {
            version: 1,
            catalog: "felt-v1".into(),
            head: "pear".into(),
            color: "moss".into(),
            expression: "cheerful".into(),
            hat: "plum-beanie".into(),
            glasses: "round-charcoal".into(),
            headphones: String::new(),
        }
    }

    #[test]
    fn a_recipe_round_trips_through_its_stored_form() {
        let saved = recipe();
        let stored = encode(&saved);
        assert!(stored.contains("\"headphones\":null"), "{stored}");
        assert_eq!(decode(&stored).unwrap(), saved);
    }

    #[test]
    fn validation_refuses_unknown_ids_and_conflicts() {
        validate(&recipe()).unwrap();
        let refused = |change: fn(&mut TagAppearance)| {
            let mut appearance = recipe();
            change(&mut appearance);
            validate(&appearance).unwrap_err().to_string()
        };
        assert!(refused(|a| a.version = 2).contains("version 2"));
        assert!(refused(|a| a.catalog = "felt-v9".into()).contains("felt-v9"));
        assert!(refused(|a| a.head = "round".into()).contains("head \"round\""));
        assert!(refused(|a| a.color = "plum".into()).contains("color"));
        assert!(refused(|a| a.expression = "focused".into()).contains("expression"));
        assert!(refused(|a| a.glasses = "tortoise".into()).contains("glasses"));
        assert!(
            refused(|a| a.headphones = "navy-over-ear".into()).contains("both sit on the crown")
        );
    }

    /// The desktop app bundles the catalog the Control Plane checks against; they name the same
    /// components and the same conflicts.
    #[test]
    fn the_catalog_matches_the_one_the_desktop_app_bundles() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../apps/desktop/src/avatars/felt-v1/catalog.json");
        let bundled: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let catalog = &CATALOGS[0];
        assert_eq!(bundled["catalog"], catalog.id);
        let keys = |slot: &str| {
            let shapes = bundled["shapes"].as_object().unwrap();
            let mut ids: Vec<String> = vec![];
            for shape in shapes.values() {
                let mut found: Vec<String> =
                    shape[slot].as_object().unwrap().keys().cloned().collect();
                found.sort();
                if ids.is_empty() {
                    ids = found;
                } else {
                    assert_eq!(ids, found, "every head has the same {slot} choices");
                }
            }
            ids
        };
        let sorted = |ids: &[&str]| {
            let mut ids: Vec<String> = ids.iter().map(|id| (*id).to_owned()).collect();
            ids.sort();
            ids
        };
        let mut heads: Vec<String> = bundled["shapes"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        heads.sort();
        assert_eq!(heads, sorted(catalog.heads));
        assert_eq!(keys("head"), sorted(catalog.colors));
        assert_eq!(keys("expression"), sorted(catalog.expressions));
        assert_eq!(keys("hat"), sorted(catalog.hats));
        assert_eq!(keys("glasses"), sorted(catalog.glasses));
        assert_eq!(keys("headphonesBack"), sorted(catalog.headphones));
        assert_eq!(keys("headphonesFront"), sorted(catalog.headphones));
        let conflicts: Vec<(String, String)> = bundled["incompatible"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| {
                (
                    pair["hat"].as_str().unwrap().to_owned(),
                    pair["headphones"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(
            conflicts,
            catalog
                .hat_headphones_conflicts
                .iter()
                .map(|(hat, headphones)| ((*hat).to_owned(), (*headphones).to_owned()))
                .collect::<Vec<_>>()
        );
        for preset in bundled["presets"].as_array().unwrap() {
            let slot = |key: &str| preset[key].as_str().unwrap_or_default().to_owned();
            validate(&TagAppearance {
                version: 1,
                catalog: catalog.id.into(),
                head: slot("head"),
                color: slot("color"),
                expression: slot("expression"),
                hat: slot("hat"),
                glasses: slot("glasses"),
                headphones: slot("headphones"),
            })
            .unwrap();
        }
    }
}
