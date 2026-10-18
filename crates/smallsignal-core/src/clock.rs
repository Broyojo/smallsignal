//! Wall-clock milliseconds for time caps. Native builds use the OS clock;
//! a WASM host registers its own (`set_clock`), since wasm32 has none.

use std::sync::OnceLock;

static CLOCK: OnceLock<fn() -> f64> = OnceLock::new();

/// Registers the host's clock (milliseconds, any origin). The first one
/// registered stays.
pub fn set_clock(now_ms: fn() -> f64) {
    let _ = CLOCK.set(now_ms);
}

/// Milliseconds since an arbitrary origin; None when there is no clock (a
/// WASM host that registered none), so a time cap never fires.
pub fn now_ms() -> Option<f64> {
    if let Some(now) = CLOCK.get() {
        return Some(now());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        Some(START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1e3)
    }
    #[cfg(target_arch = "wasm32")]
    {
        None
    }
}
