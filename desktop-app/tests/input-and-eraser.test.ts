import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type EraseOperationRecord,
  NotebookInputController,
  SpatialGridIndex,
  type Stroke,
  type ViewportTransform,
  classifyPointerRole,
  createDefaultViewport,
  logicalToScreen,
  screenToLogical,
} from '../../protocol/src/index.ts';

describe('Unidade & Instrumentação: Roteamento MotionEvent, S Pen, Dedo, Rejeição de Palma e Borracha por Traço Inteiro', () => {
  it('1. Diferencia explicitamente stylus, eraser, botão físico da S Pen e finger antes do processamento', () => {
    assert.equal(
      classifyPointerRole(
        {
          pointerId: 0,
          toolType: 'stylus',
          screenX: 10,
          screenY: 10,
          pressure: 0.5,
          stylusButtonPressed: false,
        },
        'pen'
      ),
      'stylus_pen'
    );

    // Botão lateral da S Pen pressionado -> ativa borracha por traço inteiro mesmo quando a UI está em modo 'pen'
    assert.equal(
      classifyPointerRole(
        {
          pointerId: 0,
          toolType: 'stylus',
          screenX: 10,
          screenY: 10,
          pressure: 0.5,
          stylusButtonPressed: true,
        },
        'pen'
      ),
      'stylus_eraser'
    );

    // Ferramenta nativa TOOL_TYPE_ERASER -> borracha
    assert.equal(
      classifyPointerRole(
        {
          pointerId: 0,
          toolType: 'eraser',
          screenX: 10,
          screenY: 10,
          pressure: 0.5,
          stylusButtonPressed: false,
        },
        'pen'
      ),
      'stylus_eraser'
    );

    // Dedo -> apenas navegação (jamais desenha nem apaga, mesmo se a ferramenta na UI for borracha)
    assert.equal(
      classifyPointerRole(
        {
          pointerId: 1,
          toolType: 'finger',
          screenX: 10,
          screenY: 10,
          pressure: 0.5,
          stylusButtonPressed: false,
        },
        'eraser'
      ),
      'finger_gesture'
    );
  });

  it('2. Converte coordenadas de tela e lógicas com precisão e preserva pontos históricos da S Pen', () => {
    const spatialIndex = new SpatialGridIndex();
    const committed: Stroke[] = [];
    let currentVp: ViewportTransform = {
      ...createDefaultViewport(),
      scale: 2.0,
      panX: 100,
      panY: 50,
    };

    const controller = new NotebookInputController({
      notebookId: 'nb_1',
      pageId: 'page_1',
      spatialIndex,
      viewport: currentVp,
      callbacks: {
        onStrokeCommit: (stroke) => committed.push(stroke),
        onViewportChanged: (vp) => {
          currentVp = vp;
        },
      },
    });

    // Verificar inversibilidade screenToLogical <-> logicalToScreen
    const logicalPt = screenToLogical(300, 250, currentVp);
    assert.equal(logicalPt.x, 100);
    assert.equal(logicalPt.y, 100);
    const backToScreen = logicalToScreen(logicalPt.x, logicalPt.y, currentVp);
    assert.equal(backToScreen.x, 300);
    assert.equal(backToScreen.y, 250);

    // Desenhar com S Pen incluindo amostras históricas (240Hz)
    controller.handleMotionEvent({
      action: 'ACTION_DOWN',
      downTimeMs: 1000,
      eventTimeMs: 1000,
      pointers: [
        {
          pointerId: 0,
          toolType: 'stylus',
          screenX: 300,
          screenY: 250,
          pressure: 0.3,
          tiltX: 10,
          tiltY: -5,
          stylusButtonPressed: false,
        },
      ],
    });

    controller.handleMotionEvent({
      action: 'ACTION_MOVE',
      downTimeMs: 1000,
      eventTimeMs: 1012,
      pointers: [
        {
          pointerId: 0,
          toolType: 'stylus',
          screenX: 360,
          screenY: 250,
          pressure: 0.9,
          stylusButtonPressed: false,
          historicalSamples: [
            { screenX: 320, screenY: 250, pressure: 0.5, eventTimeMs: 1004 },
            { screenX: 340, screenY: 250, pressure: 0.7, eventTimeMs: 1008 },
          ],
        },
      ],
    });

    controller.handleMotionEvent({
      action: 'ACTION_UP',
      downTimeMs: 1000,
      eventTimeMs: 1016,
      pointers: [
        {
          pointerId: 0,
          toolType: 'stylus',
          screenX: 360,
          screenY: 250,
          pressure: 0.9,
          stylusButtonPressed: false,
        },
      ],
    });

    assert.equal(committed.length, 1);
    const stroke = committed[0]!;
    assert.equal(stroke.points.length, 4); // 1 down + 2 historical + 1 move
    assert.equal(stroke.points[0]!.x, 100);
    assert.equal(stroke.points[1]!.x, 110);
    assert.equal(stroke.points[2]!.x, 120);
    assert.equal(stroke.points[3]!.x, 130);
    assert.equal(stroke.points[0]!.pressure, 0.3);
    assert.equal(stroke.points[3]!.pressure, 0.9);
  });

  it('3. Rejeição de palma: descarta traços provisórios em ACTION_CANCEL e FLAG_CANCELED sem virar tinta', () => {
    const spatialIndex = new SpatialGridIndex();
    const committed: Stroke[] = [];
    const cancelledIds: string[] = [];

    const controller = new NotebookInputController({
      notebookId: 'nb_1',
      pageId: 'page_1',
      spatialIndex,
      callbacks: {
        onStrokeCommit: (s) => committed.push(s),
        onProvisionalStrokeCancel: (id) => cancelledIds.push(id),
      },
    });

    // Inicia traço provisório
    controller.handleMotionEvent({
      action: 'ACTION_DOWN',
      downTimeMs: 500,
      eventTimeMs: 500,
      pointers: [
        {
          pointerId: 0,
          toolType: 'stylus',
          screenX: 50,
          screenY: 60,
          pressure: 0.5,
          stylusButtonPressed: false,
        },
      ],
    });
    assert.notEqual(controller.getProvisionalStroke(), null);

    // Recebe evento com FLAG_CANCELED = true
    controller.handleMotionEvent({
      action: 'ACTION_MOVE',
      downTimeMs: 500,
      eventTimeMs: 510,
      flagCanceled: true,
      pointers: [
        {
          pointerId: 0,
          toolType: 'stylus',
          screenX: 80,
          screenY: 90,
          pressure: 0.5,
          stylusButtonPressed: false,
        },
      ],
    });

    assert.equal(controller.getProvisionalStroke(), null);
    assert.equal(committed.length, 0);
    assert.equal(cancelledIds.length, 1);
    assert.equal(spatialIndex.getAllStrokes().length, 0);
  });

  it('4. Botão físico da S Pen: apaga o traço inteiro atingido, preserva traços próximos fora do raio e não duplica operações na mesma passagem', () => {
    const spatialIndex = new SpatialGridIndex();
    const committed: Stroke[] = [];
    const eraseOps: EraseOperationRecord[] = [];

    const controller = new NotebookInputController({
      notebookId: 'nb_1',
      pageId: 'page_1',
      spatialIndex,
      eraserRadius: 10,
      callbacks: {
        onStrokeCommit: (s) => committed.push(s),
        onStrokesErased: (op) => eraseOps.push(op),
      },
    });

    // Desenhar 2 traços:
    // Traço 1: Longo horizontal em Y = 100 (de X = 50 até X = 400)
    controller.handleMotionEvent({
      action: 'ACTION_DOWN',
      downTimeMs: 100,
      eventTimeMs: 100,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 50, screenY: 100, pressure: 0.5, stylusButtonPressed: false }],
    });
    controller.handleMotionEvent({
      action: 'ACTION_MOVE',
      downTimeMs: 100,
      eventTimeMs: 110,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 400, screenY: 100, pressure: 0.5, stylusButtonPressed: false }],
    });
    controller.handleMotionEvent({
      action: 'ACTION_UP',
      downTimeMs: 100,
      eventTimeMs: 120,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 400, screenY: 100, pressure: 0.5, stylusButtonPressed: false }],
    });

    // Traço 2: Paralelo próximo em Y = 125 (distância de 25px > raio 10 + meia espessura ~1.4)
    controller.handleMotionEvent({
      action: 'ACTION_DOWN',
      downTimeMs: 200,
      eventTimeMs: 200,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 50, screenY: 125, pressure: 0.5, stylusButtonPressed: false }],
    });
    controller.handleMotionEvent({
      action: 'ACTION_MOVE',
      downTimeMs: 200,
      eventTimeMs: 210,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 400, screenY: 125, pressure: 0.5, stylusButtonPressed: false }],
    });
    controller.handleMotionEvent({
      action: 'ACTION_UP',
      downTimeMs: 200,
      eventTimeMs: 220,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 400, screenY: 125, pressure: 0.5, stylusButtonPressed: false }],
    });

    assert.equal(spatialIndex.getAllStrokes().length, 2);
    const stroke1Id = committed[0]!.id;
    const stroke2Id = committed[1]!.id;

    // Agora pressionar o botão lateral da S Pen (stylusButtonPressed = true) e tocar apenas na ponta do Traço 1 (X=60, Y=100)
    controller.handleMotionEvent({
      action: 'ACTION_DOWN',
      downTimeMs: 300,
      eventTimeMs: 300,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 60, screenY: 100, pressure: 0.6, stylusButtonPressed: true }],
    });
    // Continuar movendo sobre o Traço 1 (X=150, Y=100) na mesma passagem
    controller.handleMotionEvent({
      action: 'ACTION_MOVE',
      downTimeMs: 300,
      eventTimeMs: 310,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 150, screenY: 100, pressure: 0.6, stylusButtonPressed: true }],
    });
    controller.handleMotionEvent({
      action: 'ACTION_UP',
      downTimeMs: 300,
      eventTimeMs: 320,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 150, screenY: 100, pressure: 0.6, stylusButtonPressed: true }],
    });

    // Verifica:
    // - Nenhum novo traço foi criado enquanto o botão estava pressionado
    assert.equal(committed.length, 2);
    // - O Traço 1 inteiro foi removido
    // - O Traço 2 próximo (Y=125) permaneceu intacto
    const remaining = spatialIndex.getAllStrokes();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.id, stroke2Id);
    // - Exatamente 1 operação de remoção gerada para o Traço 1
    assert.equal(eraseOps.length, 1);
    assert.deepEqual(eraseOps[0]!.targetStrokeIds, [stroke1Id]);

    // Ao soltar o botão lateral da S Pen, o próximo toque restaura a escrita normal imediatamente
    controller.handleMotionEvent({
      action: 'ACTION_DOWN',
      downTimeMs: 400,
      eventTimeMs: 400,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 80, screenY: 200, pressure: 0.5, stylusButtonPressed: false }],
    });
    controller.handleMotionEvent({
      action: 'ACTION_UP',
      downTimeMs: 400,
      eventTimeMs: 410,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 120, screenY: 200, pressure: 0.5, stylusButtonPressed: false }],
    });
    assert.equal(committed.length, 3);
    assert.equal(spatialIndex.getAllStrokes().length, 2);
  });

  it('5. Navegação com dedo (fingerMode, scrollMode, pinchZoom) atualiza em tempo real sem alterar geometria dos traços', () => {
    const spatialIndex = new SpatialGridIndex();
    const committed: Stroke[] = [];

    const controller = new NotebookInputController({
      notebookId: 'nb_1',
      pageId: 'page_1',
      spatialIndex,
      callbacks: {
        onStrokeCommit: (s) => committed.push(s),
      },
    });

    // Criar um traço de referência em (100, 200) -> (150, 250)
    controller.handleMotionEvent({
      action: 'ACTION_DOWN',
      downTimeMs: 10,
      eventTimeMs: 10,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 100, screenY: 200, pressure: 0.5, stylusButtonPressed: false }],
    });
    controller.handleMotionEvent({
      action: 'ACTION_UP',
      downTimeMs: 10,
      eventTimeMs: 20,
      pointers: [{ pointerId: 0, toolType: 'stylus', screenX: 150, screenY: 250, pressure: 0.5, stylusButtonPressed: false }],
    });
    const originalPointsJson = JSON.stringify(committed[0]!.points);

    // Testar fingerMode = 'vertical' em execução (deve bloquear panX e permitir panY)
    controller.updatePreferences({ fingerMode: 'vertical', scrollMode: 'free' });
    controller.handleMotionEvent({
      action: 'ACTION_DOWN',
      downTimeMs: 100,
      eventTimeMs: 100,
      pointers: [{ pointerId: 1, toolType: 'finger', screenX: 200, screenY: 200, pressure: 0.5, stylusButtonPressed: false }],
    });
    controller.handleMotionEvent({
      action: 'ACTION_MOVE',
      downTimeMs: 100,
      eventTimeMs: 116,
      pointers: [{ pointerId: 1, toolType: 'finger', screenX: 280, screenY: 260, pressure: 0.5, stylusButtonPressed: false }],
    });
    controller.handleMotionEvent({
      action: 'ACTION_UP',
      downTimeMs: 100,
      eventTimeMs: 130,
      pointers: [{ pointerId: 1, toolType: 'finger', screenX: 280, screenY: 260, pressure: 0.5, stylusButtonPressed: false }],
    });

    assert.equal(controller.getViewport().panX, 0);
    assert.equal(controller.getViewport().panY, 60);

    // Testar pinça com 2 dedos (pinchZoom = true): distância dobra de 100px para 200px -> scale dobra de 1.0 para 2.0
    controller.updatePreferences({ fingerMode: 'both', pinchZoom: true });
    controller.handleMotionEvent({
      action: 'ACTION_POINTER_DOWN',
      downTimeMs: 200,
      eventTimeMs: 200,
      pointers: [
        { pointerId: 1, toolType: 'finger', screenX: 100, screenY: 100, pressure: 0.5, stylusButtonPressed: false },
        { pointerId: 2, toolType: 'finger', screenX: 200, screenY: 100, pressure: 0.5, stylusButtonPressed: false },
      ],
    });
    controller.handleMotionEvent({
      action: 'ACTION_MOVE',
      downTimeMs: 200,
      eventTimeMs: 216,
      pointers: [
        { pointerId: 1, toolType: 'finger', screenX: 50, screenY: 100, pressure: 0.5, stylusButtonPressed: false },
        { pointerId: 2, toolType: 'finger', screenX: 250, screenY: 100, pressure: 0.5, stylusButtonPressed: false },
      ],
    });
    controller.handleMotionEvent({
      action: 'ACTION_UP',
      downTimeMs: 200,
      eventTimeMs: 230,
      pointers: [],
    });

    assert.equal(controller.getViewport().scale, 2.0);
    // A geometria original do traço permanece 100% inalterada
    assert.equal(JSON.stringify(spatialIndex.getAllStrokes()[0]!.points), originalPointsJson);
  });
});
