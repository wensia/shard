//! Native table core. Callers own vault gates, public-path policy and Git lifecycle.
pub mod model;
pub mod mutations;
pub mod storage;
pub mod validation;
pub mod xlsx;

pub use model::*;
pub use storage::{apply_to_file, create_at_path, read_table_file};

#[cfg(test)]
mod performance;
