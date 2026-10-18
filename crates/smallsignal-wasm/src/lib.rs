use wasm_bindgen::prelude::*;

/// `analyze(netlist, requestJson) -> responseJson`; errors come back as
/// `{"error": "..."}` rather than exceptions.
#[wasm_bindgen]
pub fn analyze(netlist: &str, request: &str) -> String {
    #[cfg(target_arch = "wasm32")]
    smallsignal_core::set_clock(now);
    smallsignal_core::analyze_json(netlist, request)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    /// The host's clock (ms), for the solver's time caps: wasm32 has none.
    #[wasm_bindgen(js_namespace = Date)]
    fn now() -> f64;
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
