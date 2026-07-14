pub mod persistence;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TerminalNodeData {
    pub id: String,
    pub position: Position,
    pub size: Size,
    #[serde(rename = "agentType")]
    pub agent_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub cwd: String,
    #[serde(rename = "ptyId")]
    pub pty_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WebviewNodeData {
    pub id: String,
    pub position: Position,
    pub size: Size,
    pub url: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CanvasNode {
    Terminal(TerminalNodeData),
    Webview(WebviewNodeData),
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CanvasEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub direction: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub viewport: Viewport,
    pub nodes: Vec<CanvasNode>,
    pub edges: Vec<CanvasEdge>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}
