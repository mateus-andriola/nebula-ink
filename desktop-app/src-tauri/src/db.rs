use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrokePoint {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub tilt_x: Option<f64>,
    pub tilt_y: Option<f64>,
    pub orientation: Option<f64>,
    pub t: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub id: String,
    pub page_id: String,
    pub notebook_id: String,
    pub color: String,
    pub base_width: f64,
    pub tool_type: String,
    pub points: Vec<StrokePoint>,
    pub created_at: i64,
}

pub struct SqliteStore {
    conn: Connection,
}

impl SqliteStore {
    pub fn open<P: AsRef<Path>>(path: P) -> SqlResult<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS notebooks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pages (
                id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                page_index INTEGER NOT NULL,
                title TEXT NOT NULL,
                width REAL NOT NULL DEFAULT 1000.0,
                height REAL NOT NULL DEFAULT 1414.2135,
                background_color TEXT NOT NULL DEFAULT '#FFFFFF',
                grid_enabled INTEGER NOT NULL DEFAULT 1,
                grid_spacing REAL NOT NULL DEFAULT 25.0,
                grid_color TEXT NOT NULL DEFAULT '#94A3B8',
                grid_opacity REAL NOT NULL DEFAULT 0.45,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_pages_notebook
                ON pages(notebook_id, page_index);

            CREATE TABLE IF NOT EXISTS strokes (
                id TEXT PRIMARY KEY,
                page_id TEXT NOT NULL,
                notebook_id TEXT NOT NULL,
                color TEXT NOT NULL,
                base_width REAL NOT NULL,
                tool_type TEXT NOT NULL DEFAULT 'pen',
                points_json TEXT NOT NULL,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                created_op_id TEXT NOT NULL,
                deleted_op_id TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
                FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_strokes_page_active
                ON strokes(page_id, is_deleted);

            CREATE TABLE IF NOT EXISTS operations (
                operation_id TEXT PRIMARY KEY,
                page_id TEXT NOT NULL,
                notebook_id TEXT NOT NULL,
                op_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                undone INTEGER NOT NULL DEFAULT 0,
                reversible INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
                FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
            );
            ",
        )?;
        Ok(Self { conn })
    }

    /// Persiste um traço de forma atômica e idempotente dentro de uma transação SQLite.
    /// Retorna `Ok(true)` se era uma operação nova ou `Ok(false)` se era duplicada.
    pub fn commit_stroke_end(&mut self, operation_id: &str, stroke: &Stroke) -> SqlResult<bool> {
        let tx = self.conn.transaction()?;

        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id = ?1)",
            params![operation_id],
            |row| row.get(0),
        )?;

        if exists {
            tx.commit()?;
            return Ok(false);
        }

        let points_json = serde_json::to_string(&stroke.points).unwrap_or_else(|_| "[]".into());
        tx.execute(
            "INSERT INTO strokes (
                id, page_id, notebook_id, color, base_width, tool_type,
                points_json, is_deleted, created_op_id, deleted_op_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, NULL, ?9)
             ON CONFLICT(id) DO UPDATE SET points_json = excluded.points_json, is_deleted = 0",
            params![
                stroke.id,
                stroke.page_id,
                stroke.notebook_id,
                stroke.color,
                stroke.base_width,
                stroke.tool_type,
                points_json,
                operation_id,
                stroke.created_at
            ],
        )?;

        let payload_json = serde_json::to_string(stroke).unwrap_or_else(|_| "{}".into());
        tx.execute(
            "INSERT INTO operations (
                operation_id, page_id, notebook_id, op_type, payload_json, undone, reversible, created_at
             ) VALUES (?1, ?2, ?3, 'stroke.end', ?4, 0, 1, ?5)",
            params![
                operation_id,
                stroke.page_id,
                stroke.notebook_id,
                payload_json,
                stroke.created_at
            ],
        )?;

        tx.commit()?;
        Ok(true)
    }

    /// Persiste a remoção integral de traços (`strokes.erase`) de forma transacional e idempotente.
    pub fn commit_strokes_erase(
        &mut self,
        operation_id: &str,
        notebook_id: &str,
        page_id: &str,
        target_stroke_ids: &[String],
        payload_json: &str,
        timestamp: i64,
    ) -> SqlResult<bool> {
        let tx = self.conn.transaction()?;

        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id = ?1)",
            params![operation_id],
            |row| row.get(0),
        )?;

        if exists {
            tx.commit()?;
            return Ok(false);
        }

        for stroke_id in target_stroke_ids {
            tx.execute(
                "UPDATE strokes SET is_deleted = 1, deleted_op_id = ?1 WHERE id = ?2 AND page_id = ?3",
                params![operation_id, stroke_id, page_id],
            )?;
        }

        tx.execute(
            "INSERT INTO operations (
                operation_id, page_id, notebook_id, op_type, payload_json, undone, reversible, created_at
             ) VALUES (?1, ?2, ?3, 'strokes.erase', ?4, 0, 1, ?5)",
            params![operation_id, page_id, notebook_id, payload_json, timestamp],
        )?;

        tx.commit()?;
        Ok(true)
    }
}
