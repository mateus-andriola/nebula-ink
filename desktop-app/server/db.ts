/**
 * Camada de Persistência SQLite (Desktop) utilizando o módulo nativo `node:sqlite`.
 * Implementa chaves estrangeiras, índices, transações ACID explícitas (BEGIN IMMEDIATE / COMMIT),
 * deduplicação idempotente por operationId e histórico completo de desfazer/refazer.
 */

import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_GRID_SETTINGS,
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  type GridSettings,
  type NotebookSummary,
  type PageMetadata,
  type PageStateSnapshot,
  type Stroke,
  type StrokePoint,
} from '../../protocol/src/index.ts';

export interface PairedDeviceRecord {
  deviceId: string;
  deviceName: string;
  approved: boolean;
  pairedAt: number;
  lastSeenAt: number;
}

export interface CommitResult {
  committed: boolean;
  duplicate: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

interface StoredOperationPayload {
  strokeId?: string;
  stroke?: Stroke;
  targetStrokeIds?: string[];
  removedStrokes?: Stroke[];
}

export class NotebookDatabase {
  private readonly db: DatabaseSync;

  constructor(dbFilePath = ':memory:') {
    this.db = new DatabaseSync(dbFilePath);
    this.initializeSchema();
    this.ensureDefaultNotebook();
  }

  public close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_operations_page_history
        ON operations(page_id, reversible, undone);

      CREATE TABLE IF NOT EXISTS paired_devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        session_resume_token TEXT NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0,
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);
  }

  private ensureDefaultNotebook(): void {
    const countRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM notebooks')
      .get() as { cnt: number } | undefined;

    if (!countRow || countRow.cnt === 0) {
      const now = Date.now();
      this.inTransaction(() => {
        this.db
          .prepare(
            'INSERT INTO notebooks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
          )
          .run('nb_default', 'Caderno S24 Ultra', now, now);

        this.db
          .prepare(
            `INSERT INTO pages (
              id, notebook_id, page_index, title, width, height,
              background_color, grid_enabled, grid_spacing, grid_color, grid_opacity,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            'page_default_1',
            'nb_default',
            0,
            'Página 1',
            DEFAULT_PAGE_WIDTH,
            DEFAULT_PAGE_HEIGHT,
            '#FFFFFF',
            1,
            DEFAULT_GRID_SETTINGS.spacing,
            DEFAULT_GRID_SETTINGS.color,
            DEFAULT_GRID_SETTINGS.opacity,
            now,
            now
          );
      });
    }
  }

  private inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ==========================================================================
  // Consultas de Cadernos e Páginas
  // ==========================================================================

  public listNotebooks(): NotebookSummary[] {
    const nbRows = this.db
      .prepare('SELECT id, title, created_at, updated_at FROM notebooks ORDER BY created_at ASC')
      .all() as Array<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
    }>;

    return nbRows.map((nb) => ({
      id: nb.id,
      title: nb.title,
      createdAt: nb.created_at,
      updatedAt: nb.updated_at,
      pages: this.listPagesForNotebook(nb.id),
    }));
  }

  public listPagesForNotebook(notebookId: string): PageMetadata[] {
    const rows = this.db
      .prepare(
        `SELECT id, notebook_id, page_index, title, width, height,
                background_color, grid_enabled, grid_spacing, grid_color, grid_opacity,
                created_at, updated_at
         FROM pages
         WHERE notebook_id = ?
         ORDER BY page_index ASC, rowid ASC`
      )
      .all(notebookId) as Array<{
      id: string;
      notebook_id: string;
      page_index: number;
      title: string;
      width: number;
      height: number;
      background_color: string;
      grid_enabled: number;
      grid_spacing: number;
      grid_color: string;
      grid_opacity: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      notebookId: r.notebook_id,
      pageIndex: r.page_index,
      title: r.title,
      width: r.width,
      height: r.height,
      backgroundColor: r.background_color,
      grid: {
        enabled: r.grid_enabled === 1,
        spacing: r.grid_spacing,
        color: r.grid_color,
        opacity: r.grid_opacity,
      },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public createNotebook(id: string, title: string): NotebookSummary {
    const now = Date.now();
    const firstPageId = `page_${id}_1`;

    this.inTransaction(() => {
      this.db
        .prepare('INSERT INTO notebooks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, title, now, now);

      this.db
        .prepare(
          `INSERT INTO pages (
            id, notebook_id, page_index, title, width, height,
            background_color, grid_enabled, grid_spacing, grid_color, grid_opacity,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          firstPageId,
          id,
          0,
          'Página 1',
          DEFAULT_PAGE_WIDTH,
          DEFAULT_PAGE_HEIGHT,
          '#FFFFFF',
          1,
          DEFAULT_GRID_SETTINGS.spacing,
          DEFAULT_GRID_SETTINGS.color,
          DEFAULT_GRID_SETTINGS.opacity,
          now,
          now
        );
    });

    const notebooks = this.listNotebooks();
    return notebooks.find((n) => n.id === id) ?? notebooks[0]!;
  }

  public createPage(notebookId: string, pageId: string, title?: string): PageMetadata {
    const now = Date.now();
    const existingPages = this.listPagesForNotebook(notebookId);
    const nextIndex = existingPages.length;
    const resolvedTitle = title ?? `Página ${nextIndex + 1}`;

    this.inTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO pages (
            id, notebook_id, page_index, title, width, height,
            background_color, grid_enabled, grid_spacing, grid_color, grid_opacity,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          pageId,
          notebookId,
          nextIndex,
          resolvedTitle,
          DEFAULT_PAGE_WIDTH,
          DEFAULT_PAGE_HEIGHT,
          '#FFFFFF',
          1,
          DEFAULT_GRID_SETTINGS.spacing,
          DEFAULT_GRID_SETTINGS.color,
          DEFAULT_GRID_SETTINGS.opacity,
          now,
          now
        );

      this.db
        .prepare('UPDATE notebooks SET updated_at = ? WHERE id = ?')
        .run(now, notebookId);
    });

    const pages = this.listPagesForNotebook(notebookId);
    return pages.find((p) => p.id === pageId) ?? pages[pages.length - 1]!;
  }

  public ensurePageExists(notebookId: string, pageId: string): PageMetadata {
    const nbExists = this.db
      .prepare('SELECT id FROM notebooks WHERE id = ?')
      .get(notebookId) as { id: string } | undefined;

    if (!nbExists) {
      const now = Date.now();
      this.db
        .prepare('INSERT INTO notebooks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(notebookId, `Caderno ${notebookId}`, now, now);
    }

    const pageRow = this.db
      .prepare('SELECT id FROM pages WHERE id = ?')
      .get(pageId) as { id: string } | undefined;

    if (!pageRow) {
      return this.createPage(notebookId, pageId);
    }

    const pages = this.listPagesForNotebook(notebookId);
    return pages.find((p) => p.id === pageId) ?? pages[0]!;
  }

  public updatePageGrid(pageId: string, grid: GridSettings, backgroundColor?: string): PageMetadata | null {
    const now = Date.now();
    this.inTransaction(() => {
      this.db
        .prepare(
          `UPDATE pages
           SET grid_enabled = ?,
               grid_spacing = ?,
               grid_color = ?,
               grid_opacity = ?,
               background_color = COALESCE(?, background_color),
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          grid.enabled ? 1 : 0,
          grid.spacing,
          grid.color,
          grid.opacity,
          backgroundColor ?? null,
          now,
          pageId
        );
    });

    const row = this.db
      .prepare('SELECT notebook_id FROM pages WHERE id = ?')
      .get(pageId) as { notebook_id: string } | undefined;
    if (!row) return null;
    return this.listPagesForNotebook(row.notebook_id).find((p) => p.id === pageId) ?? null;
  }

  public updatePageDimensions(pageId: string, width: number, height: number): PageMetadata | null {
    const now = Date.now();
    this.inTransaction(() => {
      this.db
        .prepare(
          `UPDATE pages
           SET width = ?,
               height = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(width, height, now, pageId);
    });

    const row = this.db
      .prepare('SELECT notebook_id FROM pages WHERE id = ?')
      .get(pageId) as { notebook_id: string } | undefined;
    if (!row) return null;
    return this.listPagesForNotebook(row.notebook_id).find((p) => p.id === pageId) ?? null;
  }

  public deleteNotebook(notebookId: string): boolean {
    this.inTransaction(() => {
      this.db.prepare('DELETE FROM notebooks WHERE id = ?').run(notebookId);
    });
    this.ensureDefaultNotebook();
    return true;
  }

  public deletePage(pageId: string): boolean {
    const row = this.db
      .prepare('SELECT notebook_id FROM pages WHERE id = ?')
      .get(pageId) as { notebook_id: string } | undefined;
    if (!row) return false;

    this.inTransaction(() => {
      this.db.prepare('DELETE FROM pages WHERE id = ?').run(pageId);
    });

    const remaining = this.listPagesForNotebook(row.notebook_id);
    if (remaining.length === 0) {
      this.createPage(row.notebook_id, `page_${Date.now()}`, 'Página 1');
    }
    return true;
  }

  public getPageSnapshot(pageId: string): PageStateSnapshot | null {
    const pageRow = this.db
      .prepare('SELECT notebook_id FROM pages WHERE id = ?')
      .get(pageId) as { notebook_id: string } | undefined;
    if (!pageRow) return null;

    const metadata = this.listPagesForNotebook(pageRow.notebook_id).find((p) => p.id === pageId);
    if (!metadata) return null;

    const strokeRows = this.db
      .prepare(
        `SELECT id, page_id, notebook_id, color, base_width, tool_type, points_json, created_at
         FROM strokes
         WHERE page_id = ? AND is_deleted = 0
         ORDER BY rowid ASC`
      )
      .all(pageId) as Array<{
      id: string;
      page_id: string;
      notebook_id: string;
      color: string;
      base_width: number;
      tool_type: 'pen';
      points_json: string;
      created_at: number;
    }>;

    const strokes: Stroke[] = strokeRows.map((s) => ({
      id: s.id,
      pageId: s.page_id,
      notebookId: s.notebook_id,
      color: s.color,
      baseWidth: s.base_width,
      toolType: s.tool_type,
      points: JSON.parse(s.points_json) as StrokePoint[],
      createdAt: s.created_at,
    }));

    const { canUndo, canRedo } = this.getUndoRedoAvailability(pageId);

    return {
      metadata,
      strokes,
      canUndo,
      canRedo,
    };
  }

  // ==========================================================================
  // Operações Transacionais Idempotentes (Escrita, Borracha, Undo, Redo)
  // ==========================================================================

  public hasOperation(operationId: string): boolean {
    const row = this.db
      .prepare('SELECT operation_id FROM operations WHERE operation_id = ?')
      .get(operationId) as { operation_id: string } | undefined;
    return Boolean(row);
  }

  /**
   * Persiste um traço confirmado (`stroke.end`) dentro de uma transação SQLite.
   * Só retorna após o COMMIT ser concluído com sucesso.
   */
  public commitStrokeEnd(operationId: string, stroke: Stroke): CommitResult {
    return this.inTransaction(() => {
      this.ensurePageExists(stroke.notebookId, stroke.pageId);

      if (this.hasOperation(operationId)) {
        const { canUndo, canRedo } = this.getUndoRedoAvailability(stroke.pageId);
        return { committed: true, duplicate: true, canUndo, canRedo };
      }

      const now = Date.now();
      const pointsJson = JSON.stringify(stroke.points);

      this.db
        .prepare(
          `INSERT INTO strokes (
            id, page_id, notebook_id, color, base_width, tool_type,
            points_json, is_deleted, created_op_id, deleted_op_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)
          ON CONFLICT(id) DO UPDATE SET
            points_json = excluded.points_json,
            is_deleted = 0`
        )
        .run(
          stroke.id,
          stroke.pageId,
          stroke.notebookId,
          stroke.color,
          stroke.baseWidth,
          stroke.toolType,
          pointsJson,
          operationId,
          stroke.createdAt || now
        );

      // Limpar pilha de redo da página ao inserir nova operação primária
      this.db
        .prepare('DELETE FROM operations WHERE page_id = ? AND reversible = 1 AND undone = 1')
        .run(stroke.pageId);

      const opPayload: StoredOperationPayload = {
        strokeId: stroke.id,
        stroke,
      };

      this.db
        .prepare(
          `INSERT INTO operations (
            operation_id, page_id, notebook_id, op_type, payload_json, undone, reversible, created_at
          ) VALUES (?, ?, ?, 'stroke.end', ?, 0, 1, ?)`
        )
        .run(operationId, stroke.pageId, stroke.notebookId, JSON.stringify(opPayload), now);

      this.db
        .prepare('UPDATE pages SET updated_at = ? WHERE id = ?')
        .run(now, stroke.pageId);

      const { canUndo, canRedo } = this.getUndoRedoAvailability(stroke.pageId);
      return { committed: true, duplicate: false, canUndo, canRedo };
    });
  }

  /**
   * Persiste uma remoção integral de traços (`strokes.erase`) dentro de uma transação SQLite.
   * Garante idempotência: reenviar o mesmo `operationId` jamais apaga outros traços.
   */
  public commitStrokesErase(
    operationId: string,
    notebookId: string,
    pageId: string,
    targetStrokeIds: string[],
    removedStrokesFallback: Stroke[]
  ): CommitResult {
    return this.inTransaction(() => {
      this.ensurePageExists(notebookId, pageId);

      if (this.hasOperation(operationId)) {
        const { canUndo, canRedo } = this.getUndoRedoAvailability(pageId);
        return { committed: true, duplicate: true, canUndo, canRedo };
      }

      const now = Date.now();
      const markStmt = this.db.prepare(
        'UPDATE strokes SET is_deleted = 1, deleted_op_id = ? WHERE id = ? AND page_id = ?'
      );

      for (const strokeId of targetStrokeIds) {
        markStmt.run(operationId, strokeId, pageId);
      }

      this.db
        .prepare('DELETE FROM operations WHERE page_id = ? AND reversible = 1 AND undone = 1')
        .run(pageId);

      const opPayload: StoredOperationPayload = {
        targetStrokeIds,
        removedStrokes: removedStrokesFallback,
      };

      this.db
        .prepare(
          `INSERT INTO operations (
            operation_id, page_id, notebook_id, op_type, payload_json, undone, reversible, created_at
          ) VALUES (?, ?, ?, 'strokes.erase', ?, 0, 1, ?)`
        )
        .run(operationId, pageId, notebookId, JSON.stringify(opPayload), now);

      this.db
        .prepare('UPDATE pages SET updated_at = ? WHERE id = ?')
        .run(now, pageId);

      const { canUndo, canRedo } = this.getUndoRedoAvailability(pageId);
      return { committed: true, duplicate: false, canUndo, canRedo };
    });
  }

  /**
   * Executa `operation.undo` em transação SQLite.
   */
  public commitUndo(
    operationId: string,
    notebookId: string,
    pageId: string,
    targetOperationId?: string
  ): CommitResult {
    return this.inTransaction(() => {
      this.ensurePageExists(notebookId, pageId);

      if (this.hasOperation(operationId)) {
        const { canUndo, canRedo } = this.getUndoRedoAvailability(pageId);
        return { committed: true, duplicate: true, canUndo, canRedo };
      }

      const targetRow = targetOperationId
        ? (this.db
            .prepare(
              `SELECT operation_id, op_type, payload_json
               FROM operations
               WHERE page_id = ? AND operation_id = ? AND reversible = 1 AND undone = 0`
            )
            .get(pageId, targetOperationId) as
            | { operation_id: string; op_type: string; payload_json: string }
            | undefined)
        : (this.db
            .prepare(
              `SELECT operation_id, op_type, payload_json
               FROM operations
               WHERE page_id = ? AND reversible = 1 AND undone = 0
               ORDER BY rowid DESC
               LIMIT 1`
            )
            .get(pageId) as
            | { operation_id: string; op_type: string; payload_json: string }
            | undefined);

      if (targetRow) {
        const payload = JSON.parse(targetRow.payload_json) as StoredOperationPayload;
        if (targetRow.op_type === 'stroke.end' && payload.strokeId) {
          this.db
            .prepare('UPDATE strokes SET is_deleted = 1 WHERE id = ? AND page_id = ?')
            .run(payload.strokeId, pageId);
        } else if (targetRow.op_type === 'strokes.erase' && payload.targetStrokeIds) {
          const restoreStmt = this.db.prepare(
            'UPDATE strokes SET is_deleted = 0, deleted_op_id = NULL WHERE id = ? AND page_id = ?'
          );
          for (const id of payload.targetStrokeIds) {
            restoreStmt.run(id, pageId);
          }
        }

        this.db
          .prepare('UPDATE operations SET undone = 1 WHERE operation_id = ?')
          .run(targetRow.operation_id);
      }

      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO operations (
            operation_id, page_id, notebook_id, op_type, payload_json, undone, reversible, created_at
          ) VALUES (?, ?, ?, 'operation.undo', ?, 0, 0, ?)`
        )
        .run(
          operationId,
          pageId,
          notebookId,
          JSON.stringify({ targetOperationId: targetRow?.operation_id ?? null }),
          now
        );

      const { canUndo, canRedo } = this.getUndoRedoAvailability(pageId);
      return { committed: true, duplicate: false, canUndo, canRedo };
    });
  }

  /**
   * Executa `operation.redo` em transação SQLite.
   */
  public commitRedo(
    operationId: string,
    notebookId: string,
    pageId: string,
    targetOperationId?: string
  ): CommitResult {
    return this.inTransaction(() => {
      this.ensurePageExists(notebookId, pageId);

      if (this.hasOperation(operationId)) {
        const { canUndo, canRedo } = this.getUndoRedoAvailability(pageId);
        return { committed: true, duplicate: true, canUndo, canRedo };
      }

      const targetRow = targetOperationId
        ? (this.db
            .prepare(
              `SELECT operation_id, op_type, payload_json
               FROM operations
               WHERE page_id = ? AND operation_id = ? AND reversible = 1 AND undone = 1`
            )
            .get(pageId, targetOperationId) as
            | { operation_id: string; op_type: string; payload_json: string }
            | undefined)
        : (this.db
            .prepare(
              `SELECT operation_id, op_type, payload_json
               FROM operations
               WHERE page_id = ? AND reversible = 1 AND undone = 1
               ORDER BY rowid ASC
               LIMIT 1`
            )
            .get(pageId) as
            | { operation_id: string; op_type: string; payload_json: string }
            | undefined);

      if (targetRow) {
        const payload = JSON.parse(targetRow.payload_json) as StoredOperationPayload;
        if (targetRow.op_type === 'stroke.end' && payload.strokeId) {
          this.db
            .prepare('UPDATE strokes SET is_deleted = 0 WHERE id = ? AND page_id = ?')
            .run(payload.strokeId, pageId);
        } else if (targetRow.op_type === 'strokes.erase' && payload.targetStrokeIds) {
          const eraseStmt = this.db.prepare(
            'UPDATE strokes SET is_deleted = 1, deleted_op_id = ? WHERE id = ? AND page_id = ?'
          );
          for (const id of payload.targetStrokeIds) {
            eraseStmt.run(targetRow.operation_id, id, pageId);
          }
        }

        this.db
          .prepare('UPDATE operations SET undone = 0 WHERE operation_id = ?')
          .run(targetRow.operation_id);
      }

      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO operations (
            operation_id, page_id, notebook_id, op_type, payload_json, undone, reversible, created_at
          ) VALUES (?, ?, ?, 'operation.redo', ?, 0, 0, ?)`
        )
        .run(
          operationId,
          pageId,
          notebookId,
          JSON.stringify({ targetOperationId: targetRow?.operation_id ?? null }),
          now
        );

      const { canUndo, canRedo } = this.getUndoRedoAvailability(pageId);
      return { committed: true, duplicate: false, canUndo, canRedo };
    });
  }

  private getUndoRedoAvailability(pageId: string): { canUndo: boolean; canRedo: boolean } {
    const undoRow = this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM operations WHERE page_id = ? AND reversible = 1 AND undone = 0'
      )
      .get(pageId) as { cnt: number } | undefined;

    const redoRow = this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM operations WHERE page_id = ? AND reversible = 1 AND undone = 1'
      )
      .get(pageId) as { cnt: number } | undefined;

    return {
      canUndo: (undoRow?.cnt ?? 0) > 0,
      canRedo: (redoRow?.cnt ?? 0) > 0,
    };
  }

  // ==========================================================================
  // Dispositivos Pareados
  // ==========================================================================

  public upsertPairedDevice(
    deviceId: string,
    deviceName: string,
    sessionResumeToken: string,
    approved: boolean
  ): void {
    const now = Date.now();
    this.inTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO paired_devices (
            device_id, device_name, session_resume_token, approved, paired_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            device_name = excluded.device_name,
            session_resume_token = excluded.session_resume_token,
            approved = excluded.approved,
            last_seen_at = excluded.last_seen_at`
        )
        .run(deviceId, deviceName, sessionResumeToken, approved ? 1 : 0, now, now);
    });
  }

  public setDeviceApproval(deviceId: string, approved: boolean): void {
    const now = Date.now();
    this.inTransaction(() => {
      this.db
        .prepare('UPDATE paired_devices SET approved = ?, last_seen_at = ? WHERE device_id = ?')
        .run(approved ? 1 : 0, now, deviceId);
    });
  }

  public verifyResumeToken(deviceId: string, sessionResumeToken: string): boolean {
    const row = this.db
      .prepare(
        'SELECT approved FROM paired_devices WHERE device_id = ? AND session_resume_token = ?'
      )
      .get(deviceId, sessionResumeToken) as { approved: number } | undefined;
    return row?.approved === 1;
  }

  public listPairedDevices(): PairedDeviceRecord[] {
    const rows = this.db
      .prepare(
        'SELECT device_id, device_name, approved, paired_at, last_seen_at FROM paired_devices ORDER BY last_seen_at DESC'
      )
      .all() as Array<{
      device_id: string;
      device_name: string;
      approved: number;
      paired_at: number;
      last_seen_at: number;
    }>;

    return rows.map((r) => ({
      deviceId: r.device_id,
      deviceName: r.device_name,
      approved: r.approved === 1,
      pairedAt: r.paired_at,
      lastSeenAt: r.last_seen_at,
    }));
  }
}
