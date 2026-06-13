//! Request / response types for the Indigo REST v2 API.

use serde::{Deserialize, Serialize};

/// Generic request for Indigo operations (convert, aromatize, layout, etc.).
#[derive(Deserialize)]
pub struct IndigoRequest {
    /// Input structure (SMILES, molfile, etc.).
    #[serde(rename = "struct")]
    pub struct_: String,
    /// Desired output format, defaults to `chemical/x-mdl-molfile`.
    #[serde(default = "default_output_format")]
    pub output_format: String,
    /// Extra options passed through to the backend.
    #[serde(default)]
    pub options: std::collections::HashMap<String, serde_json::Value>,
}

fn default_output_format() -> String {
    "chemical/x-mdl-molfile".into()
}

/// Generic response for Indigo operations.
#[derive(Serialize)]
pub struct IndigoResponse {
    /// Resulting structure in the requested format.
    #[serde(rename = "struct")]
    pub struct_: String,
    /// Echo of the requested output format.
    pub format: String,
}

/// Render request (adds query for rendering options).
#[derive(Deserialize)]
pub struct RenderRequest {
    #[serde(rename = "struct")]
    pub struct_: String,
    /// Output format: `image/png`, `image/svg+xml`, etc.
    #[serde(default = "default_render_format")]
    pub output_format: String,
    /// Optional rendering query string.
    pub query: Option<String>,
    #[serde(default)]
    pub options: std::collections::HashMap<String, serde_json::Value>,
}

fn default_render_format() -> String {
    "image/svg+xml".into()
}

/// Calculate request: specify which properties to compute.
#[derive(Deserialize)]
pub struct CalculateRequest {
    #[serde(rename = "struct")]
    pub struct_: String,
    /// List of property names, e.g. `["molecular-weight", "gross"]`.
    #[serde(default = "default_properties")]
    pub properties: Vec<String>,
    #[serde(default)]
    pub options: std::collections::HashMap<String, serde_json::Value>,
}

fn default_properties() -> Vec<String> {
    vec!["molecular-weight".into()]
}

/// Calculate response with optional fields for each property.
#[derive(Default, Serialize)]
pub struct CalculateResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub molecular_weight: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gross: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub most_abundant_mass: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monoisotopic_mass: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mass_composition: Option<String>,
}

/// Check request: run validation checks on a structure.
#[derive(Deserialize)]
pub struct CheckRequest {
    #[serde(rename = "struct")]
    pub struct_: String,
    /// Validation types, e.g. `["valence", "stereo", "overlapping_atoms"]`.
    #[serde(default = "default_check_types")]
    pub types: Vec<String>,
    #[serde(default)]
    pub options: std::collections::HashMap<String, serde_json::Value>,
}

fn default_check_types() -> Vec<String> {
    vec![
        "valence".into(),
        "ambiguous_h".into(),
        "query".into(),
        "pseudoatoms".into(),
        "radicals".into(),
        "stereo".into(),
        "overlapping_atoms".into(),
        "overlapping_bonds".into(),
        "3d".into(),
        "sgroups".into(),
        "v3000".into(),
        "rgroups".into(),
    ]
}
