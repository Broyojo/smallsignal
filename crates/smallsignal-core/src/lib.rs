//! Symbolic small-signal analysis of analog circuits.
//!
//! Pipeline: SPICE netlist → DC operating point (ngspice-compatible device
//! equations) → linearized small-signal parameters → symbolic modified nodal
//! analysis → exact rational transfer functions, plus a simplified form whose
//! numeric error is measured against the exact result.

pub mod analyze;
pub mod dc;
pub mod det;
pub mod devices;
pub mod linalg;
pub mod netlist;
pub mod poly;
pub mod render;
pub mod roots;
pub mod ss;
pub mod units;
pub mod verify;

pub use analyze::{analyze, analyze_json, Request};
