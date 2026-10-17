//! SPICE number parsing: `10k`, `2.2u`, `1meg`, `1e-3`, `10kohm`.

/// Parses a SPICE value with an optional SI suffix. Trailing unit letters
/// after the suffix are ignored, as in SPICE (`10kohm` is 10e3, `1.8v` is 1.8).
/// Values that overflow (`1e400`) are rejected rather than read as infinity.
pub fn parse_value(s: &str) -> Option<f64> {
    parse_raw(s).filter(|v| v.is_finite())
}

fn parse_raw(s: &str) -> Option<f64> {
    let t = s.trim();
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - digits_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - f0;
    }
    if int_digits + frac_digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        if j < b.len() && b[j].is_ascii_digit() {
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            i = j;
        }
    }
    let mant = &t[..i];
    let rest = t[i..].to_ascii_lowercase();
    if rest.starts_with("mil") {
        return Some(mant.parse::<f64>().ok()? * 25.4e-6);
    }
    let exp10 = if rest.starts_with("meg") {
        6
    } else {
        match rest.chars().next() {
            Some('t') => 12,
            Some('g') => 9,
            Some('k') => 3,
            Some('m') => -3,
            // The micro sign (U+00B5) and the Greek mu (U+03BC) look the same.
            Some('u') | Some('\u{b5}') | Some('\u{3bc}') => -6,
            Some('n') => -9,
            Some('p') => -12,
            Some('f') => -15,
            Some('a') => -18,
            _ => 0,
        }
    };
    if exp10 == 0 {
        return mant.parse().ok();
    }
    // Apply the suffix as a decimal exponent so `2.5u` parses exactly like `2.5e-6`.
    match mant.find(['e', 'E']) {
        Some(p) => {
            let e: i32 = mant[p + 1..].parse().ok()?;
            format!("{}e{}", &mant[..p], e + exp10).parse().ok()
        }
        None => format!("{mant}e{exp10}").parse().ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_value as p;

    #[test]
    fn suffixes() {
        assert_eq!(p("10k"), Some(10e3));
        assert_eq!(p("1meg"), Some(1e6));
        assert_eq!(p("1MEG"), Some(1e6));
        assert_eq!(p("2.5u"), Some(2.5e-6));
        assert_eq!(p("1e-3"), Some(1e-3));
        assert_eq!(p("1.5E3"), Some(1.5e3));
        assert_eq!(p("10kohm"), Some(10e3));
        assert_eq!(p("1.8v"), Some(1.8));
        assert_eq!(p("-3m"), Some(-3e-3));
        assert_eq!(p(".5p"), Some(0.5e-12));
        assert_eq!(p("100f"), Some(100e-15));
        assert_eq!(p("2\u{b5}"), Some(2e-6));
        assert_eq!(p("10\u{3bc}F"), Some(10e-6));
        assert_eq!(p("1a"), Some(1e-18));
        assert_eq!(p("5mil"), Some(5.0 * 25.4e-6));
        assert_eq!(p("abc"), None);
        assert_eq!(p("1e400"), None);
        assert_eq!(p("-1e400"), None);
        assert_eq!(p("1e308k"), None);
        assert_eq!(p("1e-400"), Some(0.0));
        assert_eq!(p("."), None);
    }
}
