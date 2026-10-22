import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { type Stroke } from '../../protocol/src/index.ts';
import { NotebookDatabase } from '../server/db.ts';

describe('Persistência SQLite: Transações ACID, Recuperação após Reinicialização e Idempotência', () => {
  it('Persiste cadernos, páginas, traços, remoções e histórico undo/redo e recupera integralmente após reinicialização', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-sqlite-test-'));
    const dbPath = path.join(tempDir, 'test_notebook.sqlite');

    try {
      // 1. Primeira sessão do banco de dados
      const db1 = new NotebookDatabase(dbPath);
      const nb = db1.createNotebook('nb_physics', 'Física Quântica');
      assert.equal(nb.title, 'Física Quântica');
      const page1Id = nb.pages[0]!.id;

      const strokeA: Stroke = {
        id: 'stk_phys_1',
        pageId: page1Id,
        notebookId: 'nb_physics',
        color: '#111827',
        baseWidth: 3.5,
        toolType: 'pen',
        points: [
          { x: 100, y: 120, pressure: 0.4, t: 0 },
          { x: 180, y: 160, pressure: 0.85, t: 16 },
        ],
        createdAt: 10000,
      };

      const strokeB: Stroke = {
        id: 'stk_phys_2',
        pageId: page1Id,
        notebookId: 'nb_physics',
        color: '#DC2626',
        baseWidth: 5.0,
        toolType: 'pen',
        points: [
          { x: 200, y: 300, pressure: 0.6, t: 0 },
          { x: 250, y: 350, pressure: 0.7, t: 16 },
        ],
        createdAt: 10050,
      };

      const resA = db1.commitStrokeEnd('op_phys_add_1', strokeA);
      assert.equal(resA.committed, true);
      assert.equal(resA.duplicate, false);

      // Reenvio duplicado de op_phys_add_1
      const resADup = db1.commitStrokeEnd('op_phys_add_1', strokeA);
      assert.equal(resADup.duplicate, true);

      db1.commitStrokeEnd('op_phys_add_2', strokeB);

      // Apagar strokeA
      const resErase = db1.commitStrokesErase(
        'op_phys_erase_1',
        'nb_physics',
        page1Id,
        ['stk_phys_1'],
        [strokeA]
      );
      assert.equal(resErase.committed, true);
      assert.equal(resErase.duplicate, false);

      const snapBeforeClose = db1.getPageSnapshot(page1Id);
      assert.equal(snapBeforeClose?.strokes.length, 1);
      assert.equal(snapBeforeClose?.strokes[0]!.id, 'stk_phys_2');
      db1.close();

      // 2. Simular reinicialização completa do aplicativo Desktop abrindo o mesmo arquivo SQLite
      const db2 = new NotebookDatabase(dbPath);
      const notebooksRecovered = db2.listNotebooks();
      assert.equal(notebooksRecovered.some((n) => n.id === 'nb_physics'), true);

      const snapRecovered = db2.getPageSnapshot(page1Id);
      assert.notEqual(snapRecovered, null);
      assert.equal(snapRecovered?.strokes.length, 1);
      assert.equal(snapRecovered?.strokes[0]!.id, 'stk_phys_2');
      assert.equal(snapRecovered?.canUndo, true);

      // Desfazer a remoção após reinicialização deve restaurar stk_phys_1 do SQLite!
      db2.commitUndo('op_phys_undo_after_restart', 'nb_physics', page1Id);
      const snapAfterUndo = db2.getPageSnapshot(page1Id);
      assert.equal(snapAfterUndo?.strokes.length, 2);

      // Refazer a remoção
      db2.commitRedo('op_phys_redo_after_restart', 'nb_physics', page1Id);
      const snapAfterRedo = db2.getPageSnapshot(page1Id);
      assert.equal(snapAfterRedo?.strokes.length, 1);
      assert.equal(snapAfterRedo?.strokes[0]!.id, 'stk_phys_2');

      db2.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
