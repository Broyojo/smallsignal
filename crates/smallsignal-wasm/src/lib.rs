use wasm_bindgen::prelude::*;

/// `analyze(netlist, requestJson) -> responseJson`; errors come back as
/// `{"error": "..."}` rather than exceptions.
#[wasm_bindgen]
pub fn analyze(netlist: &str, request: &str) -> String {
    smallsignal_core::analyze_json(netlist, request)
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
