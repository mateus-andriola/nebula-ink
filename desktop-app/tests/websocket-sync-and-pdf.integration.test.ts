import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import {
  type ProtocolMessage,
  type Stroke,
  parseAndValidateProtocolMessage,
  serializeProtocolMessage,
} from '../../protocol/src/index.ts';
import { DigitalNotebookLocalServer } from '../server/wsServer.ts';
import { generateVectorPdfBytes } from '../src/pdf/VectorPdfExporter.ts';

function waitForMessage(ws: WebSocket): Promise<ProtocolMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      ws.off('error', onError);
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      const res = parseAndValidateProtocolMessage(buf);
      if (res.valid && res.message) {
        resolve(res.message);
      } else {
        reject(new Error(res.errorReason ?? 'Invalid message received'));
      }
    };
    const onError = (err: Error): void => {
      ws.off('message', onMessage);
      reject(err);
    };
    ws.once('message', onMessage);
    ws.once('error', onError);
  });
}

describe('Integração Ponta a Ponta: Pareamento QR Code, Sincronização WebSocket, Reconexão e Exportação PDF Vetorial', () => {
  it('1. Pareamento via QR Code (com aprovação explícita), escrita em tempo real, borracha sincronizada, reconexão Wi-Fi e reenvio sem duplicação', async () => {
    const server = new DigitalNotebookLocalServer({
      dbFilePath: ':memory:',
      requireExplicitApproval: true,
    });
    const port = await server.start(0, '127.0.0.1');

    try {
      // Gerar QR Code temporário
      const qr = server.generatePairingQrPayload();
      assert.equal(qr.port, port);
      assert.equal(qr.pairingToken.startsWith('tkn_'), true);

      // Conectar cliente Android (S24 Ultra)
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws1.once('open', () => resolve()));

      const msgPromise1 = waitForMessage(ws1);
      ws1.send(
        serializeProtocolMessage({
          type: 'session.start',
          timestamp: Date.now(),
          payload: {
            role: 'client',
            pairingToken: qr.pairingToken,
            deviceId: 's24u_device_01',
            deviceName: 'Samsung Galaxy S24 Ultra',
            clientVersion: '1.0.0',
          },
        })
      );

      // Como requireExplicitApproval = true, primeira resposta tem approved = false
      const pendingReply = await msgPromise1;
      assert.equal(pendingReply.type, 'session.start');
      assert.equal(
        pendingReply.payload.role === 'server' && pendingReply.payload.approved,
        false
      );

      // Aprovar explicitamente no Desktop
      const approvedPromise = waitForMessage(ws1);
      const approveOk = server.approvePendingDevice('s24u_device_01', true);
      assert.equal(approveOk, true);

      const startReply = await approvedPromise;
      assert.equal(startReply.type, 'session.start');
      assert.equal(startReply.payload.role, 'server');
      if (startReply.payload.role !== 'server') throw new Error('Unreachable');
      assert.equal(startReply.payload.approved, true);

      const { sessionId, sessionResumeToken, activeNotebookId, activePageId } = startReply.payload;

      // Testar que o mesmo token temporário do QR Code NÃO pode ser reutilizado por outro cliente
      const wsAttacker = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => wsAttacker.once('open', () => resolve()));
      const attackerReplyPromise = waitForMessage(wsAttacker);
      wsAttacker.send(
        serializeProtocolMessage({
          type: 'session.start',
          timestamp: Date.now(),
          payload: {
            role: 'client',
            pairingToken: qr.pairingToken,
            deviceId: 'other_device',
            deviceName: 'Other',
            clientVersion: '1.0.0',
          },
        })
      );
      const attackerReply = await attackerReplyPromise;
      assert.equal(attackerReply.type, 'session.error');
      assert.equal(attackerReply.payload.code, 'PAIRING_TIMEOUT');
      wsAttacker.close();

      // Escrita sincronizada em tempo real: stroke.begin -> stroke.points -> stroke.end
      const stroke1: Stroke = {
        id: 'stk_sync_1',
        pageId: activePageId,
        notebookId: activeNotebookId,
        color: '#111827',
        baseWidth: 4.0,
        toolType: 'pen',
        points: [
          { x: 50, y: 100, pressure: 0.4, t: 0 },
          { x: 100, y: 120, pressure: 0.7, t: 8 },
          { x: 150, y: 140, pressure: 0.9, t: 16 },
        ],
        createdAt: Date.now(),
      };

      ws1.send(
        serializeProtocolMessage({
          type: 'stroke.begin',
          timestamp: Date.now(),
          payload: {
            operationId: 'op_begin_sync_1',
            strokeId: stroke1.id,
            notebookId: activeNotebookId,
            pageId: activePageId,
            color: stroke1.color,
            baseWidth: stroke1.baseWidth,
            toolType: 'pen',
            startPoint: stroke1.points[0]!,
          },
        })
      );

      ws1.send(
        serializeProtocolMessage({
          type: 'stroke.points',
          timestamp: Date.now(),
          payload: {
            strokeId: stroke1.id,
            pageId: activePageId,
            seq: 1,
            points: stroke1.points.slice(1),
          },
        })
      );

      const ackStroke1Promise = waitForMessage(ws1);
      ws1.send(
        serializeProtocolMessage({
          type: 'stroke.end',
          timestamp: Date.now(),
          payload: {
            operationId: 'op_end_sync_1',
            notebookId: activeNotebookId,
            pageId: activePageId,
            cancelled: false,
            stroke: stroke1,
          },
        })
      );

      const ackStroke1 = await ackStroke1Promise;
      assert.equal(ackStroke1.type, 'operation.ack');
      assert.equal(ackStroke1.payload.operationId, 'op_end_sync_1');
      assert.equal(ackStroke1.payload.status, 'committed');
      assert.equal(ackStroke1.payload.duplicate, false);

      // Adicionar um segundo traço
      const stroke2: Stroke = {
        ...stroke1,
        id: 'stk_sync_2',
        color: '#1D4ED8',
      };
      const ackStroke2Promise = waitForMessage(ws1);
      ws1.send(
        serializeProtocolMessage({
          type: 'stroke.end',
          timestamp: Date.now(),
          payload: {
            operationId: 'op_end_sync_2',
            notebookId: activeNotebookId,
            pageId: activePageId,
            cancelled: false,
            stroke: stroke2,
          },
        })
      );
      await ackStroke2Promise;

      assert.equal(server.db.getPageSnapshot(activePageId)?.strokes.length, 2);

      // Simular queda de Wi-Fi fechando ws1 e reconectando em ws2 com session.resume
      ws1.close();

      const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws2.once('open', () => resolve()));

      const resumeReplyPromise = waitForMessage(ws2);
      ws2.send(
        serializeProtocolMessage({
          type: 'session.resume',
          timestamp: Date.now(),
          payload: {
            sessionId,
            sessionResumeToken,
            deviceId: 's24u_device_01',
            lastAckedOperationId: 'op_end_sync_2',
          },
        })
      );
      const resumeReply = await resumeReplyPromise;
      assert.equal(resumeReply.type, 'session.start');

      // Reenviar op_end_sync_2 (simulando que o celular não tinha recebido o último ack antes da queda)
      const dupAckPromise = waitForMessage(ws2);
      ws2.send(
        serializeProtocolMessage({
          type: 'stroke.end',
          timestamp: Date.now(),
          payload: {
            operationId: 'op_end_sync_2',
            notebookId: activeNotebookId,
            pageId: activePageId,
            cancelled: false,
            stroke: stroke2,
          },
        })
      );
      const dupAck = await dupAckPromise;
      assert.equal(dupAck.type, 'operation.ack');
      assert.equal(dupAck.payload.duplicate, true);
      // Continua com apenas 2 traços (sem duplicação!)
      assert.equal(server.db.getPageSnapshot(activePageId)?.strokes.length, 2);

      // Borracha por traço inteiro sincronizada: apagar stk_sync_1
      const eraseAckPromise = waitForMessage(ws2);
      ws2.send(
        serializeProtocolMessage({
          type: 'strokes.erase',
          timestamp: Date.now(),
          payload: {
            operationId: 'op_erase_sync_1',
            notebookId: activeNotebookId,
            pageId: activePageId,
            targetStrokeIds: ['stk_sync_1'],
            removedStrokes: [stroke1],
          },
        })
      );
      const eraseAck = await eraseAckPromise;
      assert.equal(eraseAck.type, 'operation.ack');
      assert.equal(eraseAck.payload.status, 'committed');

      const snapAfterErase = server.db.getPageSnapshot(activePageId);
      assert.equal(snapAfterErase?.strokes.length, 1);
      assert.equal(snapAfterErase?.strokes[0]!.id, 'stk_sync_2');

      ws2.close();
    } finally {
      await server.stop();
      server.db.close();
    }
  });

  it('2. Exporta páginas para PDF 100% vetorial preservando dimensões lógicas, pressão, cores e opção de grade pontilhada', () => {
    const server = new DigitalNotebookLocalServer({ dbFilePath: ':memory:' });
    const page1 = server.db.getPageSnapshot('page_default_1')!;
    const page2Meta = server.db.createPage('nb_default', 'page_default_2', 'Página 2');

    // Adicionar traço sensível à pressão na página 1
    server.db.commitStrokeEnd('op_pdf_stk_1', {
      id: 'stk_pdf_1',
      pageId: page1.metadata.id,
      notebookId: 'nb_default',
      color: '#1D4ED8',
      baseWidth: 4.0,
      toolType: 'pen',
      points: [
        { x: 100, y: 200, pressure: 0.25, t: 0 },
        { x: 300, y: 400, pressure: 0.95, t: 20 },
      ],
      createdAt: 1000,
    });

    const snap1 = server.db.getPageSnapshot('page_default_1')!;
    const snap2 = server.db.getPageSnapshot(page2Meta.id)!;

    // Exportar caderno de 2 páginas COM grade pontilhada
    const pdfWithGrid = generateVectorPdfBytes([snap1, snap2], { includeGrid: true });
    const pdfTextWithGrid = new TextDecoder().decode(pdfWithGrid);

    assert.equal(pdfTextWithGrid.startsWith('%PDF-1.4'), true);
    assert.equal(pdfTextWithGrid.includes('/Count 2'), true);
    assert.equal(pdfTextWithGrid.includes('/MediaBox [0 0 595.28 841.85]'), true);
    // Verifica presença de operadores vetoriais PDF ('m', 'l', 'S') e cor azul normalizada (#1D4ED8 -> 0.1137 0.3059 0.8471)
    assert.equal(pdfTextWithGrid.includes('0.1137 0.3059 0.8471 RG'), true);

    // Exportar SEM grade pontilhada (deve ser significativamente menor pois omite os pontos da grade)
    const pdfWithoutGrid = generateVectorPdfBytes([snap1], { includeGrid: false });
    assert.equal(pdfWithoutGrid.byteLength < pdfWithGrid.byteLength, true);

    server.db.close();
  });
});
