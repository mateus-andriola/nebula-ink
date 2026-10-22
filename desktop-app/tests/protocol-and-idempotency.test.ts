import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MESSAGE_BYTES,
  PageDocumentEngine,
  type ProtocolMessage,
  type Stroke,
  parseAndValidateProtocolMessage,
  serializeProtocolMessage,
} from '../../protocol/src/index.ts';

describe('Unidade: Serialização do Protocolo, Validação de Segurança, Desfazer/Refazer e Idempotência', () => {
  it('1. Serializa e valida todas as mensagens do protocolo WebSocket', () => {
    const sampleStroke: Stroke = {
      id: 'stk_001',
      pageId: 'page_1',
      notebookId: 'nb_1',
      color: '#111827',
      baseWidth: 4.0,
      toolType: 'pen',
      points: [
        { x: 10, y: 20, pressure: 0.5, t: 0 },
        { x: 30, y: 40, pressure: 0.8, t: 12 },
      ],
      createdAt: 1000,
    };

    const messages: ProtocolMessage[] = [
      {
        type: 'session.start',
        timestamp: 1000,
        payload: {
          role: 'client',
          pairingToken: 'tkn_valid123',
          deviceId: 's24u_1',
          deviceName: 'Galaxy S24 Ultra',
          clientVersion: '1.0.0',
        },
      },
      {
        type: 'session.resume',
        timestamp: 1001,
        payload: {
          sessionId: 'sess_1',
          sessionResumeToken: 'res_123',
          deviceId: 's24u_1',
          lastAckedOperationId: 'op_1',
        },
      },
      {
        type: 'stroke.begin',
        timestamp: 1002,
        payload: {
          operationId: 'op_b1',
          strokeId: 'stk_001',
          notebookId: 'nb_1',
          pageId: 'page_1',
          color: '#111827',
          baseWidth: 4.0,
          toolType: 'pen',
          startPoint: { x: 10, y: 20, pressure: 0.5, t: 0 },
        },
      },
      {
        type: 'stroke.points',
        timestamp: 1003,
        payload: {
          strokeId: 'stk_001',
          pageId: 'page_1',
          seq: 1,
          points: [{ x: 30, y: 40, pressure: 0.8, t: 12 }],
        },
      },
      {
        type: 'stroke.end',
        timestamp: 1004,
        payload: {
          operationId: 'op_e1',
          notebookId: 'nb_1',
          pageId: 'page_1',
          cancelled: false,
          stroke: sampleStroke,
        },
      },
      {
        type: 'strokes.erase',
        timestamp: 1005,
        payload: {
          operationId: 'op_er1',
          notebookId: 'nb_1',
          pageId: 'page_1',
          targetStrokeIds: ['stk_001'],
          removedStrokes: [sampleStroke],
        },
      },
      {
        type: 'operation.undo',
        timestamp: 1006,
        payload: {
          operationId: 'op_u1',
          notebookId: 'nb_1',
          pageId: 'page_1',
          targetOperationId: 'op_er1',
        },
      },
      {
        type: 'operation.redo',
        timestamp: 1007,
        payload: {
          operationId: 'op_r1',
          notebookId: 'nb_1',
          pageId: 'page_1',
          targetOperationId: 'op_er1',
        },
      },
      {
        type: 'page.select',
        timestamp: 1008,
        payload: {
          operationId: 'op_ps1',
          notebookId: 'nb_1',
          pageId: 'page_2',
        },
      },
      {
        type: 'operation.ack',
        timestamp: 1009,
        payload: {
          operationId: 'op_e1',
          pageId: 'page_1',
          status: 'committed',
          duplicate: false,
          serverTimestamp: 1009,
        },
      },
      {
        type: 'session.error',
        timestamp: 1010,
        payload: {
          code: 'INVALID_TOKEN',
          message: 'Token expirado',
          fatal: true,
        },
      },
    ];

    for (const msg of messages) {
      const raw = serializeProtocolMessage(msg);
      const parsed = parseAndValidateProtocolMessage(raw);
      assert.equal(parsed.valid, true, `Failed on message type ${msg.type}: ${parsed.errorReason}`);
      assert.equal(parsed.message?.type, msg.type);
    }
  });

  it('2. Rejeita mensagens acima do limite de 512KB e payloads com IDs malformados', () => {
    const oversized = 'x'.repeat(MAX_MESSAGE_BYTES + 100);
    const resOversized = parseAndValidateProtocolMessage(oversized);
    assert.equal(resOversized.valid, false);
    assert.equal(resOversized.errorCode, 'PAYLOAD_TOO_LARGE');

    const invalidIdMsg = JSON.stringify({
      type: 'page.select',
      timestamp: 1000,
      payload: {
        operationId: 'bad id with spaces and $$; DROP TABLE',
        notebookId: 'nb_1',
        pageId: 'page_1',
      },
    });
    const resInvalidId = parseAndValidateProtocolMessage(invalidIdMsg);
    assert.equal(resInvalidId.valid, false);
    assert.equal(resInvalidId.errorCode, 'INVALID_MESSAGE_FORMAT');
  });

  it('3. Garante idempotência de operações e desfazer/refazer no PageDocumentEngine', () => {
    const doc = new PageDocumentEngine({ id: 'page_1', notebookId: 'nb_1' });

    const s1: Stroke = {
      id: 'stk_1',
      pageId: 'page_1',
      notebookId: 'nb_1',
      color: '#111827',
      baseWidth: 3.5,
      toolType: 'pen',
      points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }],
      createdAt: 100,
    };
    const s2: Stroke = {
      id: 'stk_2',
      pageId: 'page_1',
      notebookId: 'nb_1',
      color: '#1D4ED8',
      baseWidth: 3.5,
      toolType: 'pen',
      points: [{ x: 50, y: 50, pressure: 0.5, t: 0 }],
      createdAt: 200,
    };

    const add1 = doc.applyAddStroke('op_add_1', s1);
    assert.equal(add1.applied, true);
    assert.equal(add1.duplicate, false);

    // Reenvio duplicado de op_add_1 deve ser ignorado com duplicate = true
    const add1Dup = doc.applyAddStroke('op_add_1', s1);
    assert.equal(add1Dup.applied, false);
    assert.equal(add1Dup.duplicate, true);
    assert.equal(doc.getStrokes().length, 1);

    doc.applyAddStroke('op_add_2', s2);
    assert.equal(doc.getStrokes().length, 2);

    // Apagar stk_1
    const er1 = doc.applyEraseStrokes('op_erase_1', ['stk_1'], [s1]);
    assert.equal(er1.applied, true);
    assert.equal(doc.getStrokes().length, 1);
    assert.equal(doc.getStrokes()[0]!.id, 'stk_2');

    // Reenvio de op_erase_1 após reconexão não apaga stk_2
    const er1Dup = doc.applyEraseStrokes('op_erase_1', ['stk_1'], [s1]);
    assert.equal(er1Dup.duplicate, true);
    assert.equal(doc.getStrokes().length, 1);
    assert.equal(doc.getStrokes()[0]!.id, 'stk_2');

    // Desfazer a remoção restaura stk_1
    const undoRes = doc.applyUndo('op_undo_1');
    assert.equal(undoRes.applied, true);
    assert.equal(doc.getStrokes().length, 2);

    // Refazer a remoção remove stk_1 novamente
    const redoRes = doc.applyRedo('op_redo_1');
    assert.equal(redoRes.applied, true);
    assert.equal(doc.getStrokes().length, 1);
    assert.equal(doc.getStrokes()[0]!.id, 'stk_2');
  });
});
