// app/shell-tauri/src-tauri/src/store/position.rs
// Fractional index keys over an ASCII-ordered base-62 alphabet, so lexical
// ordering IS sibling ordering and an insert between two siblings is one row
// update rather than a renumber of the whole sibling set.

// ASCII order and alphabet order are the same for 0-9, A-Z, a-z, which is what
// lets plain string comparison sort these correctly in SQL and in Rust.
const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: usize = 62;

/// Seeded keys are spaced, not dense: `0,1,2` leaves nowhere to insert.
const STRIDE: u64 = 16;
const WIDTH: usize = 4;

// A caller gets a `Result` because positions come from disk: every key `after`
// and `between` are handed is read straight out of SQLite, where nothing
// constrains the column's contents, and a panic here would poison the store
// mutex and take the process down with the writer's unflushed edits.
fn val(c: u8) -> Option<usize> {
    DIGITS.iter().position(|&d| d == c)
}

/// One alphabet digit as a `char`. Building keys as a `String` rather than as a
/// `Vec<u8>` run through `from_utf8` keeps this module free of any fallible
/// conversion at all: every byte it emits comes from `DIGITS`, and saying so in
/// the type is better than saying so in an `.expect` message.
fn digit(d: usize) -> char {
    DIGITS[d] as char
}

fn malformed(key: &str) -> String {
    format!("position key {key:?} holds a byte outside the base-62 alphabet")
}

/// Both bounds are checked WHOLE, up front, rather than as the digit loop
/// happens to reach them: the loop returns as soon as it finds room, so a
/// malformed tail would pass unseen for some inputs and be refused for others.
/// A key in the file either is a position or it is not.
fn validate(key: &str) -> Result<(), String> {
    match key.as_bytes().iter().all(|&c| val(c).is_some()) {
        true => Ok(()),
        false => Err(malformed(key)),
    }
}

/// True when nothing sorts strictly between `a` and `b`, because `b` is `a`
/// with one '0' appended. `between` cannot serve that pair and panics on it, so
/// a caller handed arbitrary neighbours must ask here first.
pub fn is_immediate_successor(a: Option<&str>, b: &str) -> bool {
    let a = a.unwrap_or("");
    b.len() == a.len() + 1 && b.starts_with(a) && b.ends_with('0')
}

/// A key strictly between `a` and `b`. `None` means unbounded on that side.
///
/// LIMITATION, append-only case: `between(Some(k), None)` takes the midpoint
/// toward the alphabet ceiling, so it absorbs only ~6 appends per trailing
/// digit and key length grows LINEARLY with a run of end-appends — measured
/// at 167 chars after 1000 sequential appends. Seeding does not hit this
/// (`seeded_position` is fixed-width). Use `after` to append at the end of a
/// sibling group; it increments with carry and holds the width. `between`
/// stays the right call for a mid-sibling insert, where both bounds exist.
///
/// Panics when `b` is `a`'s immediate successor: see `is_immediate_successor`.
///
/// Returns `Err` when either bound holds a byte outside the alphabet, because
/// both bounds are read back from disk. Out-of-order bounds stay a panic: that
/// is a caller bug, not bad data.
pub fn between(a: Option<&str>, b: Option<&str>) -> Result<String, String> {
    for bound in [a, b].into_iter().flatten() {
        validate(bound)?;
    }
    if let (Some(av), Some(bv)) = (a, b) {
        if av >= bv {
            panic!(
                "between: bounds out of order ({a:?} >= {b:?}); sibling positions must be strictly increasing"
            );
        }
    }
    // The room below a key whose tail is all zeros lives in a SHORTER key, and
    // the digit loop below only ever extends: on "0000" it copies zeros forever,
    // with the output vector growing without bound. Dropping one trailing zero
    // lands strictly between, since a proper prefix sorts first and `b` extends
    // `a`. One trailing zero is the exception -- there the interval is empty.
    if let Some(bv) = b {
        let av = a.unwrap_or("");
        if bv.len() > av.len()
            && bv.starts_with(av)
            && bv.as_bytes()[av.len()..].iter().all(|&c| c == b'0')
        {
            if is_immediate_successor(a, bv) {
                panic!(
                    "between: no key fits between {a:?} and {b:?}; the caller must check is_immediate_successor first"
                );
            }
            return Ok(bv[..bv.len() - 1].to_string());
        }
    }
    let a = a.unwrap_or("");
    let mut out = String::new();
    // Once the prefix built so far is strictly below `b`, `b` stops
    // constraining the remaining digits. Without this the "adjacent keys" case
    // loops forever.
    let mut diverged = false;
    let mut i = 0usize;
    loop {
        // Both bounds were validated whole on entry, so these cannot fail.
        let da = match a.as_bytes().get(i) {
            Some(&c) => val(c).ok_or_else(|| malformed(a))?,
            None => 0,
        };
        let db = if diverged {
            BASE
        } else {
            match b {
                Some(b) => match b.as_bytes().get(i) {
                    Some(&c) => val(c).ok_or_else(|| malformed(b))?,
                    None => 0,
                },
                None => BASE,
            }
        };
        if db > da + 1 {
            out.push(digit((da + db) / 2));
            return Ok(out);
        }
        if db > da {
            diverged = true;
        }
        out.push(digit(da));
        i += 1;
    }
}

/// The next key after `last`, for appending at the END of a sibling group.
///
/// PRECONDITION: `last` MUST be the greatest position in that group
/// (`SELECT MAX(position) FROM item WHERE parent_id IS ?`). Stepping by one
/// from a non-maximal key walks into the stride-16 gap the seed leaves between
/// siblings and lands exactly on the next one after 16 steps, where the UNIQUE
/// `item_sibling` index (`item_root_sibling` for a root) rejects the write.
/// Loud, but still a bug at the call site. Both indexes are needed to say that:
/// item_sibling alone leaves roots unconstrained, because a unique index treats
/// NULLs as distinct. To insert BETWEEN two siblings, use `between`.
///
/// `between(Some(last), None)` takes the midpoint toward the alphabet ceiling,
/// which absorbs only ~6 appends per trailing digit and grows the key linearly
/// (measured: 167 chars after 1000 appends). Incrementing with carry keeps the
/// width fixed until the group genuinely exhausts the alphabet at that width,
/// and then extends by exactly one digit rather than widening existing keys.
///
/// Returns `Err` on a byte outside the base-62 alphabet, like `val`: `last`
/// is read back from disk and nothing in the schema constrains it.
pub fn after(last: &str) -> Result<String, String> {
    let mut digits: Vec<usize> = last
        .as_bytes()
        .iter()
        .map(|&c| val(c).ok_or_else(|| malformed(last)))
        .collect::<Result<Vec<usize>, String>>()?;
    for slot in digits.iter_mut().rev() {
        if *slot + 1 < BASE {
            *slot += 1;
            return Ok(digits.iter().map(|&d| digit(d)).collect());
        }
        *slot = 0;
    }
    // Every digit was the ceiling: "zzzz" -> "zzzz1". Extending rather than
    // carrying into a new leading digit keeps the result strictly greater than
    // the input, which a leading carry ("10000" < "zzzz" lexically) would not.
    let mut out = last.to_string();
    out.push(digit(1));
    Ok(out)
}

/// The key for the nth seeded sibling. Fixed width so every seeded key sorts
/// by plain comparison and every gap is the same size.
///
/// Offset by one stride, so the first key is "000G" rather than the alphabet
/// floor "0000". Nothing sorts below "0", and `between` can only reach below an
/// all-zero key by shortening it, so a group seeded at the floor ran out of room
/// after three front-inserts: drag-to-top would fail permanently on a project's
/// first chapter. One stride of headroom absorbs thousands.
pub fn seeded_position(ordinal: u64) -> Result<String, String> {
    let mut n = ordinal
        .checked_add(1)
        .and_then(|o| o.checked_mul(STRIDE))
        .ok_or_else(|| format!("ordinal {ordinal} overflows the position stride"))?;
    let capacity = (BASE as u64).pow(WIDTH as u32);
    if n >= capacity {
        return Err(format!(
            "ordinal {ordinal} exceeds {WIDTH}-digit capacity ({capacity} / stride {STRIDE})"
        ));
    }
    let mut buf = ['0'; WIDTH];
    for slot in buf.iter_mut().rev() {
        *slot = digit((n % BASE as u64) as usize);
        n /= BASE as u64;
    }
    Ok(buf.iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_key_sits_mid_range() {
        let k = between(None, None).unwrap();
        assert!(k.as_str() > "0");
        assert!(k.as_str() < "z");
    }

    #[test]
    fn between_two_adjacent_keys_extends_rather_than_failing() {
        let a = "a";
        let b = "b";
        let mid = between(Some(a), Some(b)).unwrap();
        assert!(a < mid.as_str(), "{a} < {mid}");
        assert!(mid.as_str() < b, "{mid} < {b}");
    }

    #[test]
    fn appending_after_a_key_orders_after_it() {
        let a = between(None, None).unwrap();
        let b = between(Some(&a), None).unwrap();
        assert!(a < b);
    }

    #[test]
    fn inserting_before_the_first_key_orders_before_it() {
        let a = between(None, None).unwrap();
        let b = between(None, Some(&a)).unwrap();
        assert!(b < a);
    }

    #[test]
    fn seeded_positions_are_ordered_fixed_width_and_leave_room() {
        let first = seeded_position(0).unwrap();
        let second = seeded_position(1).unwrap();
        assert_eq!(first.len(), second.len());
        assert!(first < second);
        // Stride 16 means 15 insertions fit between neighbours before any key
        // has to grow, which is what keeps a seeded 15,200-row project from
        // producing kilobyte-long keys.
        let mid = between(Some(&first), Some(&second)).unwrap();
        assert_eq!(mid.len(), first.len());
    }

    #[test]
    fn the_first_seeded_key_leaves_room_below_it() {
        // At the floor "0000" the only room below is in shorter keys, and there
        // are three of those: a group seeded there loses drag-to-top for good on
        // the fourth attempt. One stride up, front-inserts halve a gap instead
        // of exhausting one.
        assert_eq!(seeded_position(0).unwrap(), "000G");
        let mut k = seeded_position(0).unwrap();
        for n in 0..2000 {
            assert!(
                !is_immediate_successor(None, &k),
                "out of room after {n} front-inserts, at {k}"
            );
            let next = between(None, Some(&k)).unwrap();
            assert!(next < k, "{next} < {k}");
            k = next;
        }
    }

    #[test]
    fn a_full_stress_seed_stays_fixed_width() {
        let last = seeded_position(15_199).unwrap();
        assert_eq!(last.len(), 4);
    }

    #[test]
    #[should_panic(expected = "bounds out of order")]
    fn swapped_bounds_panic_rather_than_hanging() {
        let _ = between(Some("b"), Some("a"));
    }

    #[test]
    #[should_panic(expected = "bounds out of order")]
    fn equal_bounds_panic_rather_than_hanging() {
        let _ = between(Some("m"), Some("m"));
    }

    #[test]
    fn a_key_below_the_first_sibling_is_shorter_rather_than_unreachable() {
        // The room below "0000" lives in a SHORTER key: the digit loop only ever
        // extends, so it used to copy zeros forever here. "0000" is
        // seeded_position(0), i.e. every seeded group's first key, so this is
        // the ordinary "move to the front" input, not a corner.
        for (a, b) in [(None, "0000"), (Some("00"), "0000"), (None, "00")] {
            let mid = between(a, Some(b)).unwrap();
            assert!(mid.as_str() < b, "{mid} < {b}");
            if let Some(a) = a {
                assert!(a < mid.as_str(), "{a} < {mid}");
            }
        }
    }

    #[test]
    fn a_key_and_its_immediate_successor_have_nothing_between_them() {
        assert!(is_immediate_successor(None, "0"));
        assert!(is_immediate_successor(Some("000"), "0000"));
        assert!(!is_immediate_successor(None, "0000"));
        assert!(!is_immediate_successor(Some("0000"), "0001"));
        assert!(!is_immediate_successor(Some("0000"), "0000V"));
    }

    #[test]
    #[should_panic(expected = "no key fits")]
    fn an_immediate_successor_panics_rather_than_hanging() {
        // Unsatisfiable, not merely awkward: nothing sorts between "000" and
        // "0000". Callers that can be handed arbitrary neighbours must ask
        // is_immediate_successor first.
        let _ = between(Some("000"), Some("0000"));
    }

    #[test]
    fn bounds_of_different_lengths_still_produce_a_key_between_them() {
        for (a, b) in [("a", "ab"), ("ab", "b"), ("a", "aa")] {
            let mid = between(Some(a), Some(b)).unwrap();
            assert!(a < mid.as_str() && mid.as_str() < b, "{a} < {mid} < {b}");
        }
    }

    #[test]
    fn appending_after_a_seeded_key_keeps_the_width() {
        let a = seeded_position(0).unwrap();
        let b = after(&a).unwrap();
        assert_eq!(b.len(), a.len(), "{a} -> {b}");
        assert!(a < b, "{a} < {b}");
    }

    #[test]
    fn a_thousand_appends_do_not_grow_the_key() {
        let mut k = seeded_position(0).unwrap();
        let width = k.len();
        for _ in 0..1000 {
            let next = after(&k).unwrap();
            assert!(k < next, "{k} < {next}");
            k = next;
        }
        // between() grew to 167 chars over the same run. Width must not move.
        assert_eq!(k.len(), width, "key grew to {} after 1000 appends", k.len());
    }

    #[test]
    fn appending_past_the_alphabet_ceiling_extends_by_one_digit() {
        let k = after("zzzz").unwrap();
        assert!(k.as_str() > "zzzz", "{k} > zzzz");
        assert_eq!(k.len(), 5, "{k}");
    }

    #[test]
    fn carry_propagates_leftward() {
        assert_eq!(after("0z").unwrap(), "10");
    }

    #[test]
    fn appends_stay_ordered_across_the_ceiling() {
        // Extending is the only branch that does not increment in place, so
        // walk keys up to the ceiling and out the other side.
        let mut k = String::from("zzy");
        for _ in 0..5 {
            let next = after(&k).unwrap();
            assert!(k < next, "{k} < {next}");
            k = next;
        }
    }

    #[test]
    fn a_thousand_sequential_appends_stay_ordered_and_bounded() {
        let mut keys: Vec<String> = vec![between(None, None).unwrap()];
        for _ in 0..1000 {
            let last = keys.last().unwrap().clone();
            keys.push(between(Some(&last), None).unwrap());
        }
        for pair in keys.windows(2) {
            assert!(pair[0] < pair[1], "{} < {}", pair[0], pair[1]);
        }
        // Report the real growth rather than asserting a number pulled from
        // thin air: if this is large, say so in your report.
        assert!(
            keys.last().unwrap().len() < 200,
            "key length {} after 1000 appends",
            keys.last().unwrap().len()
        );
    }

    #[test]
    fn a_key_holding_a_byte_outside_the_alphabet_is_refused_rather_than_panicking() {
        // No legitimate path writes such a key, but nothing in the schema stops
        // one being in the file, and a panic here poisons the store mutex.
        for bad in ["00-0", "0/00", "  ", "\u{00e9}"] {
            assert!(after(bad).is_err(), "after({bad:?}) should refuse");
            assert!(
                between(Some(bad), None).is_err(),
                "between(Some({bad:?}), None) should refuse"
            );
            assert!(
                between(None, Some(bad)).is_err(),
                "between(None, Some({bad:?})) should refuse"
            );
        }
    }
}
