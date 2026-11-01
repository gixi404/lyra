//! Monotonic workspace identifiers.
//!
//! An id is both identity and path (`workspaces/<id>`), so it is validated
//! before ever being joined onto a filesystem path. Identifiers are never
//! reused: deleting `ws_002` and creating a new workspace yields `ws_004`.

pub const ID_PREFIX: &str = "ws_";
const MIN_DIGITS: usize = 3;

/// Formats a sequence number as a workspace id (`1 -> "ws_001"`).
pub fn format_id(seq: u32) -> String {
    debug_assert!(seq > 0, "workspace sequence starts at 1");
    format!("{ID_PREFIX}{seq:0MIN_DIGITS$}")
}

/// Parses the numeric sequence of a workspace id.
pub fn parse_seq(id: &str) -> Result<u32, String> {
    let digits = id
        .strip_prefix(ID_PREFIX)
        .ok_or_else(|| format!("Invalid workspace id '{id}': missing '{ID_PREFIX}' prefix"))?;
    if digits.len() < MIN_DIGITS {
        return Err(format!("Invalid workspace id '{id}': fewer than {MIN_DIGITS} digits"));
    }
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("Invalid workspace id '{id}': non-numeric sequence"));
    }
    let seq: u32 = digits
        .parse()
        .map_err(|_| format!("Invalid workspace id '{id}': sequence out of range"))?;
    if seq == 0 {
        return Err(format!("Invalid workspace id '{id}': sequence must start at 1"));
    }
    Ok(seq)
}

/// Validates that `id` is safe to use as a single path component.
///
/// The accepted alphabet is `ws_` followed by ASCII digits, which cannot
/// contain separators, dots or drive prefixes, so path traversal is excluded
/// by construction.
pub fn validate_id(id: &str) -> Result<(), String> {
    parse_seq(id).map(|_| ())
}

/// Smallest sequence number greater than every id in `ids`.
pub fn next_seq<'a>(ids: impl IntoIterator<Item = &'a str>) -> u32 {
    ids.into_iter()
        .filter_map(|id| parse_seq(id).ok())
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_padded_monotonic_ids() {
        assert_eq!(format_id(1), "ws_001");
        assert_eq!(format_id(42), "ws_042");
        assert_eq!(format_id(1234), "ws_1234");
    }

    #[test]
    fn rejects_unsafe_or_malformed_ids() {
        for bad in [
            "",
            "ws_",
            "ws_1",
            "ws_01",
            "ws_000",
            "ws_00a",
            "ws_001/../x",
            "../ws_001",
            "ws_001 ",
            "wS_001",
            "/ws_001",
            "ws_-01",
        ] {
            assert!(validate_id(bad).is_err(), "id '{bad}' should be rejected");
        }
        assert!(validate_id("ws_004").is_ok());
        assert!(validate_id("ws_1234").is_ok());
    }

    #[test]
    fn never_reuses_sequences() {
        assert_eq!(next_seq(["ws_001"]), 2);
        assert_eq!(next_seq(["ws_001", "ws_003"]), 4);
        assert_eq!(next_seq(Vec::<&str>::new()), 1);
        // Desconocidos no rompen la asignación.
        assert_eq!(next_seq(["ws_001", "basura"]), 2);
    }
}
