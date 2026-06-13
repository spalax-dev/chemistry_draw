use serde::{Deserialize, Serialize};

// POST body genérico para /convert, /aromatize, etc.
#[derive(Deserialize)]
#[allow(dead_code)]
pub struct IndigoRequest {
    #[serde(rename = "struct")]
    pub struct_: String,
    #[serde(default = "default_output_format")]
    pub output_format: String,
    #[serde(default)]
    pub options: std::collections::HashMap<String, serde_json::Value>,
}

fn default_output_format() -> String {
    "chemical/x-mdl-molfile".into()
}

#[derive(Serialize)]
pub struct IndigoResponse {
    #[serde(rename = "struct")]
    pub struct_: String,
    pub format: String,
}

#[derive(Serialize)]
pub struct IndigoError {
    pub error: String,
}

// Render
#[derive(Deserialize)]
#[allow(dead_code)]
pub struct RenderRequest {
    #[serde(rename = "struct")]
    pub struct_: String,
    #[serde(default = "default_render_format")]
    pub output_format: String,
    pub query: Option<String>,
    #[serde(default)]
    pub options: std::collections::HashMap<String, serde_json::Value>,
}

fn default_render_format() -> String {
    "image/svg+xml".into()
}

// Calculate
#[derive(Deserialize)]
#[allow(dead_code)]
pub struct CalculateRequest {
    #[serde(rename = "struct")]
    pub struct_: String,
    #[serde(default = "default_properties")]
    pub properties: Vec<String>,
    #[serde(default)]
    pub options: std::collections::HashMap<String, serde_json::Value>,
}

fn default_properties() -> Vec<String> {
    vec!["molecular-weight".into()]
}

#[derive(Serialize)]
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

// Check
#[derive(Deserialize)]
#[allow(dead_code)]
pub struct CheckRequest {
    #[serde(rename = "struct")]
    pub struct_: String,
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
