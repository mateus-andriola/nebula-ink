package com.digitalnotebook.spen

import android.os.SystemClock
import android.view.MotionEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.digitalnotebook.spen.data.PendingOperationDatabase
import com.digitalnotebook.spen.data.PendingOperationEntity
import com.digitalnotebook.spen.data.PreferencesRepository
import com.digitalnotebook.spen.engine.PageDocumentEngine
import com.digitalnotebook.spen.input.MotionEventRouter
import com.digitalnotebook.spen.input.MotionRouterCallbacks
import com.digitalnotebook.spen.input.ResolvedPointerRole
import com.digitalnotebook.spen.model.EraseOperationRecord
import com.digitalnotebook.spen.model.FingerMode
import com.digitalnotebook.spen.model.InputPreferences
import com.digitalnotebook.spen.model.ScrollMode
import com.digitalnotebook.spen.model.Stroke
import com.digitalnotebook.spen.model.StrokePoint
import com.digitalnotebook.spen.model.ViewportTransform
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SPenCanvasInstrumentedTest {

    @Test
    fun motionEventConversionAndRuntimePreferencesPersistence() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefsRepo = PreferencesRepository(context)

        // 1. Alterar preferências em execução e verificar persistência DataStore
        val customPrefs = InputPreferences(
            fingerMode = FingerMode.VERTICAL,
            scrollMode = ScrollMode.AXIS_LOCKED,
            palmRejection = true,
            pinchZoom = true
        )
        prefsRepo.updateInputPreferences(customPrefs)
        val loadedPrefs = prefsRepo.inputPreferencesFlow.first()
        assertEquals(FingerMode.VERTICAL, loadedPrefs.fingerMode)
        assertEquals(ScrollMode.AXIS_LOCKED, loadedPrefs.scrollMode)

        // 2. Testar MotionEvent real do Android (ACTION_DOWN -> ACTION_MOVE -> ACTION_UP)
        val engine = PageDocumentEngine("nb_inst", "page_inst")
        val router = MotionEventRouter(engine, object : MotionRouterCallbacks {
            override fun onProvisionalStrokeBegin(stroke: Stroke, operationId: String) {}
            override fun onProvisionalStrokePoints(strokeId: String, seq: Int, addedPoints: List<StrokePoint>) {}
            override fun onProvisionalStrokeCancelled(strokeId: String, operationId: String) {}
            override fun onStrokeCommitted(stroke: Stroke, operationId: String) {}
            override fun onStrokesErased(eraseRecord: EraseOperationRecord) {}
            override fun onViewportUpdated(viewport: ViewportTransform) {}
            override fun onHoverPreview(role: ResolvedPointerRole, logicalX: Float, logicalY: Float) {}
        })
        router.preferences = loadedPrefs

        val downTime = SystemClock.uptimeMillis()
        val props = arrayOf(MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_STYLUS
        })
        val coords = arrayOf(MotionEvent.PointerCoords().apply {
            x = 120f
            y = 240f
            pressure = 0.65f
        })

        val downEv = MotionEvent.obtain(
            downTime, downTime, MotionEvent.ACTION_DOWN, 1, props, coords,
            0, 0, 1f, 1f, 0, 0, 0, 0
        )
        router.route(MotionEventRouter.fromAndroidMotionEvent(downEv))
        downEv.recycle()

        coords[0].x = 180f
        coords[0].y = 260f
        val upEv = MotionEvent.obtain(
            downTime, downTime + 20, MotionEvent.ACTION_UP, 1, props, coords,
            0, 0, 1f, 1f, 0, 0, 0, 0
        )
        router.route(MotionEventRouter.fromAndroidMotionEvent(upEv))
        upEv.recycle()

        assertEquals(1, engine.getStrokes().size)

        // 3. Testar recuperação de operações pendentes após reinicialização via Room SQLite
        val db = PendingOperationDatabase.getInstance(context)
        val dao = db.pendingOperationDao()
        dao.clearAll()
        dao.enqueue(
            PendingOperationEntity(
                operationId = "op_recover_1",
                notebookId = "nb_inst",
                pageId = "page_inst",
                messageType = "stroke.end",
                serializedEnvelopeJson = """{"type":"stroke.end"}""",
                createdAt = 1000L
            )
        )
        val pending = dao.getAllPendingOrdered()
        assertEquals(1, pending.size)
        assertEquals("op_recover_1", pending.first().operationId)
        dao.acknowledge("op_recover_1")
        assertTrue(dao.getAllPendingOrdered().isEmpty())
    }
}
