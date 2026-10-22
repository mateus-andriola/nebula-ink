package com.digitalnotebook.spen

import com.digitalnotebook.spen.engine.PageDocumentEngine
import com.digitalnotebook.spen.input.HistoricalPointSample
import com.digitalnotebook.spen.input.MotionEventRouter
import com.digitalnotebook.spen.input.MotionRouterCallbacks
import com.digitalnotebook.spen.input.NativeToolKind
import com.digitalnotebook.spen.input.PointerInputSample
import com.digitalnotebook.spen.input.ResolvedPointerRole
import com.digitalnotebook.spen.input.RoutedMotionEvent
import com.digitalnotebook.spen.input.RouterMotionAction
import com.digitalnotebook.spen.input.ToolClassifier
import com.digitalnotebook.spen.model.ActiveUiTool
import com.digitalnotebook.spen.model.EraseOperationRecord
import com.digitalnotebook.spen.model.FingerMode
import com.digitalnotebook.spen.model.InputPreferences
import com.digitalnotebook.spen.model.ScrollMode
import com.digitalnotebook.spen.model.Stroke
import com.digitalnotebook.spen.model.StrokePoint
import com.digitalnotebook.spen.model.ViewportTransform
import com.digitalnotebook.spen.sync.ProtocolSerializer
import com.digitalnotebook.spen.sync.StrokeEndPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MotionEventRouterAndEraserTest {

    private class RecordingCallbacks : MotionRouterCallbacks {
        val committedStrokes = mutableListOf<Stroke>()
        val cancelledIds = mutableListOf<String>()
        val eraseRecords = mutableListOf<EraseOperationRecord>()
        var lastViewport = ViewportTransform()

        override fun onProvisionalStrokeBegin(stroke: Stroke, operationId: String) {}
        override fun onProvisionalStrokePoints(strokeId: String, seq: Int, addedPoints: List<StrokePoint>) {}
        override fun onProvisionalStrokeCancelled(strokeId: String, operationId: String) {
            cancelledIds.add(strokeId)
        }
        override fun onStrokeCommitted(stroke: Stroke, operationId: String) {
            committedStrokes.add(stroke)
        }
        override fun onStrokesErased(eraseRecord: EraseOperationRecord) {
            eraseRecords.add(eraseRecord)
        }
        override fun onViewportUpdated(viewport: ViewportTransform) {
            lastViewport = viewport
        }
        override fun onHoverPreview(role: ResolvedPointerRole, logicalX: Float, logicalY: Float) {}
    }

    @Test
    fun `tool classifier differentiates stylus, eraser, button pressed, and finger`() {
        val stylusNormal = PointerInputSample(0, NativeToolKind.STYLUS, 100f, 100f, 0.5f, stylusButtonPressed = false)
        val stylusButton = PointerInputSample(0, NativeToolKind.STYLUS, 100f, 100f, 0.5f, stylusButtonPressed = true)
        val nativeEraser = PointerInputSample(0, NativeToolKind.ERASER, 100f, 100f, 0.5f)
        val finger = PointerInputSample(0, NativeToolKind.FINGER, 100f, 100f, 0.5f)

        assertEquals(ResolvedPointerRole.STYLUS_PEN, ToolClassifier.classify(stylusNormal, ActiveUiTool.PEN))
        assertEquals(ResolvedPointerRole.STYLUS_ERASER, ToolClassifier.classify(stylusButton, ActiveUiTool.PEN))
        assertEquals(ResolvedPointerRole.STYLUS_ERASER, ToolClassifier.classify(nativeEraser, ActiveUiTool.PEN))
        assertEquals(ResolvedPointerRole.FINGER_NAVIGATION, ToolClassifier.classify(finger, ActiveUiTool.PEN))
    }

    @Test
    fun `s pen draws with historical points and finger only scrolls without drawing`() {
        val engine = PageDocumentEngine("nb_1", "page_1")
        val cb = RecordingCallbacks()
        val router = MotionEventRouter(engine, cb)

        // 1. Escrita com S Pen + amostras históricas
        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_DOWN,
                downTimeMs = 1000L,
                eventTimeMs = 1000L,
                pointers = listOf(PointerInputSample(0, NativeToolKind.STYLUS, 50f, 50f, 0.4f))
            )
        )
        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_MOVE,
                downTimeMs = 1000L,
                eventTimeMs = 1016L,
                pointers = listOf(
                    PointerInputSample(
                        pointerId = 0,
                        toolKind = NativeToolKind.STYLUS,
                        screenX = 150f,
                        screenY = 50f,
                        pressure = 0.8f,
                        historicalSamples = listOf(
                            HistoricalPointSample(80f, 50f, 0.5f, eventTimeMs = 1004L),
                            HistoricalPointSample(120f, 50f, 0.7f, eventTimeMs = 1010L)
                        )
                    )
                )
            )
        )
        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_UP,
                downTimeMs = 1000L,
                eventTimeMs = 1020L,
                pointers = listOf(PointerInputSample(0, NativeToolKind.STYLUS, 150f, 50f, 0.8f))
            )
        )

        assertEquals(1, engine.getStrokes().size)
        assertEquals(4, engine.getStrokes().first().points.size) // 1 down + 2 historical + 1 move

        // 2. Dedo faz scroll mas nunca desenha nem modifica coordenadas originais
        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_DOWN,
                downTimeMs = 2000L,
                eventTimeMs = 2000L,
                pointers = listOf(PointerInputSample(1, NativeToolKind.FINGER, 200f, 200f, 0.5f))
            )
        )
        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_MOVE,
                downTimeMs = 2000L,
                eventTimeMs = 2016L,
                pointers = listOf(PointerInputSample(1, NativeToolKind.FINGER, 250f, 230f, 0.5f))
            )
        )
        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_UP,
                downTimeMs = 2000L,
                eventTimeMs = 2032L,
                pointers = listOf(PointerInputSample(1, NativeToolKind.FINGER, 250f, 230f, 0.5f))
            )
        )

        assertEquals(1, engine.getStrokes().size)
        assertEquals(50f, cb.lastViewport.panX, 0.01f)
        assertEquals(30f, cb.lastViewport.panY, 0.01f)
        assertEquals(50f, engine.getStrokes().first().points.first().x, 0.01f)
    }

    @Test
    fun `palm rejection discards provisional stroke on ACTION_CANCEL or FLAG_CANCELED`() {
        val engine = PageDocumentEngine("nb_1", "page_1")
        val cb = RecordingCallbacks()
        val router = MotionEventRouter(engine, cb)

        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_DOWN,
                downTimeMs = 1000L,
                eventTimeMs = 1000L,
                pointers = listOf(PointerInputSample(0, NativeToolKind.STYLUS, 100f, 100f, 0.5f))
            )
        )
        assertNotNull(router.getProvisionalStroke())

        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_MOVE,
                downTimeMs = 1000L,
                eventTimeMs = 1010L,
                flagCanceled = true,
                pointers = listOf(PointerInputSample(0, NativeToolKind.STYLUS, 120f, 120f, 0.5f))
            )
        )

        assertNull(router.getProvisionalStroke())
        assertTrue(engine.getStrokes().isEmpty())
        assertEquals(1, cb.cancelledIds.size)
    }

    @Test
    fun `s pen side button erases whole intersected stroke without affecting nearby strokes or triggering undo`() {
        val engine = PageDocumentEngine("nb_1", "page_1")
        val cb = RecordingCallbacks()
        val router = MotionEventRouter(engine, cb)
        router.setEraserRadius(10f)

        // Criar 2 traços: Traço A em Y=100 (X=50..300) e Traço B em Y=140 (X=50..300, fora do raio 10)
        val strokeA = Stroke(
            id = "stk_A",
            pageId = "page_1",
            notebookId = "nb_1",
            color = "#111827",
            baseWidth = 4f,
            points = listOf(
                StrokePoint(50f, 100f, 0.5f, t = 0),
                StrokePoint(300f, 100f, 0.5f, t = 10)
            ),
            createdAt = 1000L
        )
        val strokeB = Stroke(
            id = "stk_B",
            pageId = "page_1",
            notebookId = "nb_1",
            color = "#1D4ED8",
            baseWidth = 4f,
            points = listOf(
                StrokePoint(50f, 140f, 0.5f, t = 0),
                StrokePoint(300f, 140f, 0.5f, t = 10)
            ),
            createdAt = 1010L
        )
        engine.applyAddStroke("op_add_A", strokeA)
        engine.applyAddStroke("op_add_B", strokeB)
        assertEquals(2, engine.getStrokes().size)

        // Passar a S Pen com o botão lateral pressionado apenas sobre X=120, Y=100 (atingindo stk_A)
        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_DOWN,
                downTimeMs = 2000L,
                eventTimeMs = 2000L,
                pointers = listOf(
                    PointerInputSample(0, NativeToolKind.STYLUS, 120f, 100f, 0.6f, stylusButtonPressed = true)
                )
            )
        )
        // Continuar arrastando sobre o mesmo traço stk_A (X=180, Y=100) não deve gerar segunda operação
        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_MOVE,
                downTimeMs = 2000L,
                eventTimeMs = 2010L,
                pointers = listOf(
                    PointerInputSample(0, NativeToolKind.STYLUS, 180f, 100f, 0.6f, stylusButtonPressed = true)
                )
            )
        )
        router.route(
            RoutedMotionEvent(
                action = RouterMotionAction.ACTION_UP,
                downTimeMs = 2000L,
                eventTimeMs = 2020L,
                pointers = listOf(
                    PointerInputSample(0, NativeToolKind.STYLUS, 180f, 100f, 0.6f, stylusButtonPressed = true)
                )
            )
        )

        // Apenas stk_A foi removido integralmente; stk_B permanece intacto; exatamente 1 operação gerada
        assertEquals(1, engine.getStrokes().size)
        assertEquals("stk_B", engine.getStrokes().first().id)
        assertEquals(1, cb.eraseRecords.size)
        assertEquals(listOf("stk_A"), cb.eraseRecords.first().targetStrokeIds)

        // Desfazer restaura stk_A; Refazer remove stk_A novamente; Reenvio idempotente não afeta stk_B
        engine.applyUndo("op_undo_1")
        assertEquals(2, engine.getStrokes().size)
        engine.applyRedo("op_redo_1")
        assertEquals(1, engine.getStrokes().size)
        assertEquals("stk_B", engine.getStrokes().first().id)
    }

    @Test
    fun `protocol serializer encodes and decodes stroke end envelope accurately`() {
        val stroke = Stroke(
            id = "stk_test_1",
            pageId = "page_default_1",
            notebookId = "nb_default",
            color = "#111827",
            baseWidth = 3.5f,
            points = listOf(StrokePoint(10f, 20f, 0.75f, t = 0)),
            createdAt = 123456L
        )
        val raw = ProtocolSerializer.encodeMessage(
            type = "stroke.end",
            payload = StrokeEndPayload(
                operationId = "op_test_1",
                notebookId = "nb_default",
                pageId = "page_default_1",
                cancelled = false,
                stroke = stroke
            ),
            timestamp = 123456L
        )
        val decoded = ProtocolSerializer.decodeEnvelope(raw)
        assertEquals("stroke.end", decoded.type)
        val payload = ProtocolSerializer.decodePayload<StrokeEndPayload>(decoded)
        assertEquals("op_test_1", payload.operationId)
        assertEquals("stk_test_1", payload.stroke.id)
        assertEquals(0.75f, payload.stroke.points.first().pressure, 0.001f)
    }
}
