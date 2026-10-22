package com.digitalnotebook.spen.input

import android.view.MotionEvent
import com.digitalnotebook.spen.engine.PageDocumentEngine
import com.digitalnotebook.spen.engine.WholeStrokeEraserSession
import com.digitalnotebook.spen.model.ActiveUiTool
import com.digitalnotebook.spen.model.EraseOperationRecord
import com.digitalnotebook.spen.model.FingerMode
import com.digitalnotebook.spen.model.InputPreferences
import com.digitalnotebook.spen.model.ScrollMode
import com.digitalnotebook.spen.model.ShapeGeometryGenerator
import com.digitalnotebook.spen.model.ShapeToolKind
import com.digitalnotebook.spen.model.Stroke
import com.digitalnotebook.spen.model.StrokePoint
import com.digitalnotebook.spen.model.ViewportTransform
import java.util.UUID
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

enum class NativeToolKind {
    STYLUS,
    ERASER,
    FINGER,
    UNKNOWN
}

enum class ResolvedPointerRole {
    STYLUS_PEN,
    STYLUS_ERASER,
    FINGER_NAVIGATION,
    IGNORED
}

enum class RouterMotionAction {
    ACTION_DOWN,
    ACTION_POINTER_DOWN,
    ACTION_MOVE,
    ACTION_POINTER_UP,
    ACTION_UP,
    ACTION_CANCEL,
    ACTION_HOVER_MOVE
}

data class HistoricalPointSample(
    val screenX: Float,
    val screenY: Float,
    val pressure: Float,
    val tilt: Float? = null,
    val orientation: Float? = null,
    val eventTimeMs: Long
)

data class PointerInputSample(
    val pointerId: Int,
    val toolKind: NativeToolKind,
    val screenX: Float,
    val screenY: Float,
    val pressure: Float,
    val tilt: Float? = null,
    val orientation: Float? = null,
    val stylusButtonPressed: Boolean = false,
    val historicalSamples: List<HistoricalPointSample> = emptyList()
)

data class RoutedMotionEvent(
    val action: RouterMotionAction,
    val actionPointerId: Int? = null,
    val downTimeMs: Long,
    val eventTimeMs: Long,
    val flagCanceled: Boolean = false,
    val pointers: List<PointerInputSample>
)

interface MotionRouterCallbacks {
    fun onProvisionalStrokeBegin(stroke: Stroke, operationId: String)
    fun onProvisionalStrokePoints(strokeId: String, seq: Int, addedPoints: List<StrokePoint>)
    fun onProvisionalStrokeCancelled(strokeId: String, operationId: String)
    fun onStrokeCommitted(stroke: Stroke, operationId: String)
    fun onStrokesErased(eraseRecord: EraseOperationRecord)
    fun onViewportUpdated(viewport: ViewportTransform)
    fun onHoverPreview(role: ResolvedPointerRole, logicalX: Float, logicalY: Float)
}

object ToolClassifier {
    /**
     * Distingue explicitamente a ferramenta de entrada antes de qualquer processamento:
     * 1. Dedo (FINGER) -> FINGER_NAVIGATION (nunca desenha nem apaga).
     * 2. Borracha nativa (ERASER) -> STYLUS_ERASER.
     * 3. S Pen (STYLUS) com botão físico lateral pressionado -> STYLUS_ERASER.
     * 4. S Pen (STYLUS) com botão solto -> STYLUS_PEN (ou STYLUS_ERASER se selecionado na UI).
     */
    fun classify(pointer: PointerInputSample, activeUiTool: ActiveUiTool): ResolvedPointerRole {
        return when (pointer.toolKind) {
            NativeToolKind.FINGER -> ResolvedPointerRole.FINGER_NAVIGATION
            NativeToolKind.ERASER -> ResolvedPointerRole.STYLUS_ERASER
            NativeToolKind.STYLUS -> {
                if (pointer.stylusButtonPressed || activeUiTool == ActiveUiTool.ERASER) {
                    ResolvedPointerRole.STYLUS_ERASER
                } else {
                    ResolvedPointerRole.STYLUS_PEN
                }
            }
            NativeToolKind.UNKNOWN -> ResolvedPointerRole.IGNORED
        }
    }
}

class MotionEventRouter(
    private var pageEngine: PageDocumentEngine,
    private val callbacks: MotionRouterCallbacks
) {
    var preferences: InputPreferences = InputPreferences()
        set(value) {
            field = value
            if (value.scrollMode == ScrollMode.FREE) {
                lockedAxis = null
            }
        }

    var viewport: ViewportTransform = ViewportTransform()
        private set

    var activeUiTool: ActiveUiTool = ActiveUiTool.PEN
    var activeShapeTool: ShapeToolKind = ShapeToolKind.NONE
    var polygonSides: Int = 5
    var penColor: String = "#F8FAFC"
    var penBaseWidth: Float = 3.5f

    private var eraserSession = WholeStrokeEraserSession(pageEngine.spatialIndex, 14.0f)

    // Estado provisório da S Pen (Rejeição de Palma e Cancelamento)
    private var activeStylusPointerId: Int? = null
    private var activeStylusRole: ResolvedPointerRole? = null
    private var provisionalStroke: Stroke? = null
    private var provisionalOperationId: String? = null
    private var provisionalSeq: Int = 0
    private var strokeDownTimeMs: Long = 0L
    private var shapeStartLogical: Pair<Float, Float>? = null
    private var lastStylusHoverTimeMs: Long = -10_000L

    // Estado de gestos do dedo (Pan e Pinch Zoom)
    private val activeFingerPositions = LinkedHashMap<Int, Pair<Float, Float>>()
    private val initialFingerOrigins = HashMap<Int, Pair<Float, Float>>()
    private var lockedAxis: Char? = null // 'x' ou 'y'
    private var lastPinchDistance: Float? = null
    private var lastPinchCenter: Pair<Float, Float>? = null

    fun attachPageEngine(newEngine: PageDocumentEngine) {
        cancelAllActiveInteractions()
        pageEngine = newEngine
        eraserSession = WholeStrokeEraserSession(pageEngine.spatialIndex, eraserSession.eraserRadius)
    }

    fun setEraserRadius(radius: Float) {
        eraserSession.eraserRadius = radius
    }

    fun updateViewport(newViewport: ViewportTransform) {
        viewport = newViewport
        callbacks.onViewportUpdated(viewport)
    }

    fun getProvisionalStroke(): Stroke? = provisionalStroke

    /**
     * Ponto de entrada principal para qualquer evento (Android MotionEvent convertido ou teste).
     */
    fun route(event: RoutedMotionEvent) {
        // 1. Respeitar imediatamente ACTION_CANCEL e FLAG_CANCELED (Política de Rejeição de Palma)
        if (event.action == RouterMotionAction.ACTION_CANCEL || event.flagCanceled) {
            cancelAllActiveInteractions()
            return
        }

        // 2. Identificar se há ponteiro de S Pen / Borracha
        val stylusPointer = event.pointers.firstOrNull {
            it.toolKind == NativeToolKind.STYLUS || it.toolKind == NativeToolKind.ERASER
        }

        if (event.action == RouterMotionAction.ACTION_HOVER_MOVE && stylusPointer != null) {
            lastStylusHoverTimeMs = event.eventTimeMs
            val role = ToolClassifier.classify(stylusPointer, activeUiTool)
            val (lx, ly) = viewport.screenToLogical(stylusPointer.screenX, stylusPointer.screenY)
            callbacks.onHoverPreview(role, lx, ly)
            if (preferences.palmRejection && activeFingerPositions.isNotEmpty()) {
                resetFingerState()
            }
            return
        }

        if (stylusPointer != null) {
            if (preferences.palmRejection && activeFingerPositions.isNotEmpty()) {
                resetFingerState()
            }
            handleStylusInput(event, stylusPointer)
            return
        }

        // 3. Bloquear gestos de dedo se a S Pen estiver escrevendo ou em hover recente (<150ms)
        if (activeStylusPointerId != null ||
            (preferences.palmRejection && (event.eventTimeMs - lastStylusHoverTimeMs) < 150L)
        ) {
            return
        }

        // 4. Processar navegação com dedo (Scroll / Zoom por pinça)
        handleFingerNavigation(event)
    }

    private fun handleStylusInput(event: RoutedMotionEvent, pointer: PointerInputSample) {
        val currentRole = ToolClassifier.classify(pointer, activeUiTool)
        if (currentRole != ResolvedPointerRole.STYLUS_PEN &&
            currentRole != ResolvedPointerRole.STYLUS_ERASER
        ) {
            return
        }

        when (event.action) {
            RouterMotionAction.ACTION_DOWN,
            RouterMotionAction.ACTION_POINTER_DOWN -> {
                activeStylusPointerId = pointer.pointerId
                activeStylusRole = currentRole
                strokeDownTimeMs = if (event.downTimeMs > 0) event.downTimeMs else event.eventTimeMs

                if (currentRole == ResolvedPointerRole.STYLUS_PEN) {
                    val startPt = toLogicalPoint(
                        pointer.screenX,
                        pointer.screenY,
                        pointer.pressure,
                        pointer.tilt,
                        pointer.orientation,
                        event.eventTimeMs
                    )
                    shapeStartLogical = Pair(startPt.x, startPt.y)
                    val strokeId = "stk_${UUID.randomUUID().toString().replace("-", "").take(12)}"
                    val opId = "op_${UUID.randomUUID().toString().replace("-", "").take(12)}"
                    val stroke = Stroke(
                        id = strokeId,
                        pageId = pageEngine.pageId,
                        notebookId = pageEngine.notebookId,
                        color = penColor,
                        baseWidth = penBaseWidth,
                        toolType = "pen",
                        points = listOf(startPt),
                        createdAt = event.eventTimeMs
                    )
                    provisionalStroke = stroke
                    provisionalOperationId = opId
                    provisionalSeq = 0
                    callbacks.onProvisionalStrokeBegin(stroke, opId)
                } else {
                    // Botão lateral da S Pen pressionado -> Borracha por traço inteiro imediata
                    val (lx, ly) = viewport.screenToLogical(pointer.screenX, pointer.screenY)
                    val erased = eraserSession.beginPass(lx, ly)
                    emitEraseOperationIfAny(erased, event.eventTimeMs)
                }
            }

            RouterMotionAction.ACTION_MOVE -> {
                // Caso o botão lateral da S Pen seja pressionado durante o traço, descarta o traço provisório
                // e entra em modo borracha por traço inteiro
                if (activeStylusRole == ResolvedPointerRole.STYLUS_PEN &&
                    currentRole == ResolvedPointerRole.STYLUS_ERASER
                ) {
                    val cancelledStroke = provisionalStroke
                    val cancelledOpId = provisionalOperationId
                    provisionalStroke = null
                    provisionalOperationId = null
                    if (cancelledStroke != null && cancelledOpId != null) {
                        callbacks.onProvisionalStrokeCancelled(cancelledStroke.id, cancelledOpId)
                    }
                    activeStylusRole = ResolvedPointerRole.STYLUS_ERASER
                    val (lx, ly) = viewport.screenToLogical(pointer.screenX, pointer.screenY)
                    val erased = eraserSession.beginPass(lx, ly)
                    emitEraseOperationIfAny(erased, event.eventTimeMs)
                    return
                }

                val samples = ArrayList<HistoricalPointSample>(pointer.historicalSamples.size + 1)
                samples.addAll(pointer.historicalSamples)
                samples.add(
                    HistoricalPointSample(
                        screenX = pointer.screenX,
                        screenY = pointer.screenY,
                        pressure = pointer.pressure,
                        tilt = pointer.tilt,
                        orientation = pointer.orientation,
                        eventTimeMs = event.eventTimeMs
                    )
                )

                if (activeStylusRole == ResolvedPointerRole.STYLUS_PEN) {
                    val currentProvisional = provisionalStroke ?: return
                    val shapeOrigin = shapeStartLogical
                    if (activeShapeTool != ShapeToolKind.NONE && shapeOrigin != null) {
                        val (endLx, endLy) = viewport.screenToLogical(pointer.screenX, pointer.screenY)
                        val elapsed = (event.eventTimeMs - strokeDownTimeMs).coerceAtLeast(1L)
                        val shapePoints = ShapeGeometryGenerator.generateShapePoints(
                            shape = activeShapeTool,
                            x0 = shapeOrigin.first,
                            y0 = shapeOrigin.second,
                            x1 = endLx,
                            y1 = endLy,
                            polygonSides = polygonSides,
                            elapsedMs = elapsed
                        )
                        provisionalStroke = currentProvisional.copy(points = shapePoints)
                        return
                    }
                    val newPoints = ArrayList<StrokePoint>(samples.size)
                    for (sample in samples) {
                        newPoints.add(
                            toLogicalPoint(
                                sample.screenX,
                                sample.screenY,
                                sample.pressure,
                                sample.tilt,
                                sample.orientation,
                                sample.eventTimeMs
                            )
                        )
                    }
                    val updatedStroke = currentProvisional.copy(
                        points = currentProvisional.points + newPoints
                    )
                    provisionalStroke = updatedStroke
                    provisionalSeq += 1
                    callbacks.onProvisionalStrokePoints(updatedStroke.id, provisionalSeq, newPoints)
                } else if (activeStylusRole == ResolvedPointerRole.STYLUS_ERASER) {
                    val removedInMove = ArrayList<Stroke>()
                    for (sample in samples) {
                        val (lx, ly) = viewport.screenToLogical(sample.screenX, sample.screenY)
                        val erased = eraserSession.stepTo(lx, ly)
                        if (erased.isNotEmpty()) {
                            removedInMove.addAll(erased)
                        }
                    }
                    emitEraseOperationIfAny(removedInMove, event.eventTimeMs)
                }
            }

            RouterMotionAction.ACTION_UP,
            RouterMotionAction.ACTION_POINTER_UP -> {
                if (activeStylusRole == ResolvedPointerRole.STYLUS_PEN) {
                    val currentProvisional = provisionalStroke
                    val opId = provisionalOperationId
                    val shapeOrigin = shapeStartLogical
                    provisionalStroke = null
                    provisionalOperationId = null
                    shapeStartLogical = null
                    if (currentProvisional != null && opId != null) {
                        val finalPoints = if (activeShapeTool != ShapeToolKind.NONE && shapeOrigin != null) {
                            val (endLx, endLy) = viewport.screenToLogical(pointer.screenX, pointer.screenY)
                            val elapsed = (event.eventTimeMs - strokeDownTimeMs).coerceAtLeast(1L)
                            ShapeGeometryGenerator.generateShapePoints(
                                shape = activeShapeTool,
                                x0 = shapeOrigin.first,
                                y0 = shapeOrigin.second,
                                x1 = endLx,
                                y1 = endLy,
                                polygonSides = polygonSides,
                                elapsedMs = elapsed
                            )
                        } else {
                            val endPt = toLogicalPoint(
                                pointer.screenX,
                                pointer.screenY,
                                pointer.pressure,
                                pointer.tilt,
                                pointer.orientation,
                                event.eventTimeMs
                            )
                            val lastPt = currentProvisional.points.lastOrNull()
                            if (lastPt == null ||
                                hypot(lastPt.x - endPt.x, lastPt.y - endPt.y) > 0.01f
                            ) {
                                currentProvisional.points + endPt
                            } else {
                                currentProvisional.points
                            }
                        }
                        val committed = currentProvisional.copy(points = finalPoints)
                        pageEngine.applyAddStroke(opId, committed)
                        callbacks.onStrokeCommitted(committed, opId)
                    }
                } else if (activeStylusRole == ResolvedPointerRole.STYLUS_ERASER) {
                    val (lx, ly) = viewport.screenToLogical(pointer.screenX, pointer.screenY)
                    val erased = eraserSession.stepTo(lx, ly)
                    emitEraseOperationIfAny(erased, event.eventTimeMs)
                    eraserSession.endPass()
                }
                activeStylusPointerId = null
                activeStylusRole = null
            }

            else -> Unit
        }
    }

    private fun handleFingerNavigation(event: RoutedMotionEvent) {
        val fingers = event.pointers.filter { it.toolKind == NativeToolKind.FINGER }
        if (fingers.isEmpty()) return

        when (event.action) {
            RouterMotionAction.ACTION_DOWN,
            RouterMotionAction.ACTION_POINTER_DOWN -> {
                for (fp in fingers) {
                    val pos = Pair(fp.screenX, fp.screenY)
                    activeFingerPositions[fp.pointerId] = pos
                    if (!initialFingerOrigins.containsKey(fp.pointerId)) {
                        initialFingerOrigins[fp.pointerId] = pos
                    }
                }
                lockedAxis = null
                if (fingers.size >= 2) {
                    val p1 = fingers[0]
                    val p2 = fingers[1]
                    lastPinchDistance = hypot(p2.screenX - p1.screenX, p2.screenY - p1.screenY)
                    lastPinchCenter = Pair(
                        (p1.screenX + p2.screenX) * 0.5f,
                        (p1.screenY + p2.screenY) * 0.5f
                    )
                }
            }

            RouterMotionAction.ACTION_MOVE -> {
                if (fingers.size >= 2) {
                    val p1 = fingers[0]
                    val p2 = fingers[1]
                    val currentDist = hypot(p2.screenX - p1.screenX, p2.screenY - p1.screenY)
                    val currentCenter = Pair(
                        (p1.screenX + p2.screenX) * 0.5f,
                        (p1.screenY + p2.screenY) * 0.5f
                    )
                    val prevDist = lastPinchDistance
                    val prevCenter = lastPinchCenter

                    if (preferences.pinchZoom && prevDist != null && prevDist > 5f && prevCenter != null) {
                        val scaleFactor = currentDist / prevDist
                        val (panDx, panDy) = filterPanDelta(
                            currentCenter.first - prevCenter.first,
                            currentCenter.second - prevCenter.second
                        )
                        viewport = viewport.applyPinchZoom(
                            scaleFactor = scaleFactor,
                            focalScreenX = currentCenter.first,
                            focalScreenY = currentCenter.second,
                            panDeltaX = panDx,
                            panDeltaY = panDy
                        )
                        callbacks.onViewportUpdated(viewport)
                    }

                    lastPinchDistance = currentDist
                    lastPinchCenter = currentCenter
                    for (fp in fingers) {
                        activeFingerPositions[fp.pointerId] = Pair(fp.screenX, fp.screenY)
                    }
                    return
                }

                // Scroll com 1 dedo
                val fp = fingers[0]
                val prev = activeFingerPositions[fp.pointerId]
                activeFingerPositions[fp.pointerId] = Pair(fp.screenX, fp.screenY)

                if (prev == null || preferences.fingerMode == FingerMode.NONE) return

                val rawDx = fp.screenX - prev.first
                val rawDy = fp.screenY - prev.second

                if (preferences.scrollMode == ScrollMode.AXIS_LOCKED && lockedAxis == null) {
                    val origin = initialFingerOrigins[fp.pointerId] ?: prev
                    val totalDx = abs(fp.screenX - origin.first)
                    val totalDy = abs(fp.screenY - origin.second)
                    if (totalDx > 6f || totalDy > 6f) {
                        lockedAxis = if (totalDx >= totalDy) 'x' else 'y'
                    }
                }

                val (dx, dy) = filterPanDelta(rawDx, rawDy)
                if (dx != 0f || dy != 0f) {
                    viewport = viewport.copy(
                        panX = viewport.panX + dx,
                        panY = viewport.panY + dy
                    )
                    callbacks.onViewportUpdated(viewport)
                }
            }

            RouterMotionAction.ACTION_POINTER_UP -> {
                event.actionPointerId?.let {
                    activeFingerPositions.remove(it)
                    initialFingerOrigins.remove(it)
                }
                lastPinchDistance = null
                lastPinchCenter = null
            }

            RouterMotionAction.ACTION_UP -> {
                resetFingerState()
            }

            else -> Unit
        }
    }

    private fun filterPanDelta(rawDx: Float, rawDy: Float): Pair<Float, Float> {
        if (preferences.fingerMode == FingerMode.NONE) return Pair(0f, 0f)

        var dx = rawDx
        var dy = rawDy

        when (preferences.fingerMode) {
            FingerMode.HORIZONTAL -> dy = 0f
            FingerMode.VERTICAL -> dx = 0f
            else -> Unit
        }

        if (preferences.scrollMode == ScrollMode.AXIS_LOCKED && lockedAxis != null) {
            if (lockedAxis == 'x') dy = 0f else dx = 0f
        }

        return Pair(dx, dy)
    }

    private fun toLogicalPoint(
        screenX: Float,
        screenY: Float,
        pressure: Float,
        tilt: Float?,
        orientation: Float?,
        eventTimeMs: Long
    ): StrokePoint {
        val (lx, ly) = viewport.screenToLogical(screenX, screenY)
        val clampedPressure = pressure.coerceIn(0.01f, 1.0f)
        return StrokePoint(
            x = (lx * 1000f).roundToInt() / 1000f,
            y = (ly * 1000f).roundToInt() / 1000f,
            pressure = (clampedPressure * 10000f).roundToInt() / 10000f,
            tiltX = tilt,
            orientation = orientation,
            t = (eventTimeMs - strokeDownTimeMs).coerceAtLeast(0L)
        )
    }

    private fun emitEraseOperationIfAny(erasedStrokes: List<Stroke>, timestamp: Long) {
        if (erasedStrokes.isEmpty()) return
        val opId = "op_erase_${UUID.randomUUID().toString().replace("-", "").take(12)}"
        val targetIds = erasedStrokes.map { it.id }
        pageEngine.applyEraseStrokes(opId, targetIds, erasedStrokes)
        val record = EraseOperationRecord(
            operationId = opId,
            notebookId = pageEngine.notebookId,
            pageId = pageEngine.pageId,
            targetStrokeIds = targetIds,
            removedStrokes = erasedStrokes,
            timestamp = timestamp
        )
        callbacks.onStrokesErased(record)
    }

    private fun cancelAllActiveInteractions() {
        val cancelledStroke = provisionalStroke
        val cancelledOpId = provisionalOperationId
        provisionalStroke = null
        provisionalOperationId = null
        shapeStartLogical = null
        if (cancelledStroke != null && cancelledOpId != null) {
            callbacks.onProvisionalStrokeCancelled(cancelledStroke.id, cancelledOpId)
        }
        eraserSession.endPass()
        activeStylusPointerId = null
        activeStylusRole = null
        resetFingerState()
    }

    private fun resetFingerState() {
        activeFingerPositions.clear()
        initialFingerOrigins.clear()
        lockedAxis = null
        lastPinchDistance = null
        lastPinchCenter = null
    }

    companion object {
        /**
         * Converte um android.view.MotionEvent real (com pontos históricos de 240Hz da S Pen)
         * para o modelo estruturado RoutedMotionEvent.
         */
        fun fromAndroidMotionEvent(event: MotionEvent): RoutedMotionEvent {
            val actionMasked = event.actionMasked
            val mappedAction = when (actionMasked) {
                MotionEvent.ACTION_DOWN -> RouterMotionAction.ACTION_DOWN
                MotionEvent.ACTION_POINTER_DOWN -> RouterMotionAction.ACTION_POINTER_DOWN
                MotionEvent.ACTION_MOVE -> RouterMotionAction.ACTION_MOVE
                MotionEvent.ACTION_POINTER_UP -> RouterMotionAction.ACTION_POINTER_UP
                MotionEvent.ACTION_UP -> RouterMotionAction.ACTION_UP
                MotionEvent.ACTION_CANCEL -> RouterMotionAction.ACTION_CANCEL
                MotionEvent.ACTION_HOVER_MOVE,
                MotionEvent.ACTION_HOVER_ENTER,
                MotionEvent.ACTION_HOVER_EXIT -> RouterMotionAction.ACTION_HOVER_MOVE
                else -> RouterMotionAction.ACTION_MOVE
            }

            val isFlagCanceled = (event.flags and MotionEvent.FLAG_CANCELED) != 0
            val stylusButtonPressed =
                (event.buttonState and MotionEvent.BUTTON_STYLUS_PRIMARY) != 0 ||
                (event.buttonState and MotionEvent.BUTTON_SECONDARY) != 0

            val pointerCount = event.pointerCount
            val historySize = event.historySize
            val pointers = ArrayList<PointerInputSample>(pointerCount)

            for (pIndex in 0 until pointerCount) {
                val nativeTool = when (event.getToolType(pIndex)) {
                    MotionEvent.TOOL_TYPE_STYLUS -> NativeToolKind.STYLUS
                    MotionEvent.TOOL_TYPE_ERASER -> NativeToolKind.ERASER
                    MotionEvent.TOOL_TYPE_FINGER -> NativeToolKind.FINGER
                    else -> NativeToolKind.UNKNOWN
                }

                val historical = ArrayList<HistoricalPointSample>(historySize)
                if (mappedAction == RouterMotionAction.ACTION_MOVE && historySize > 0) {
                    for (h in 0 until historySize) {
                        historical.add(
                            HistoricalPointSample(
                                screenX = event.getHistoricalX(pIndex, h),
                                screenY = event.getHistoricalY(pIndex, h),
                                pressure = event.getHistoricalPressure(pIndex, h),
                                tilt = event.getHistoricalAxisValue(MotionEvent.AXIS_TILT, pIndex, h),
                                orientation = event.getHistoricalAxisValue(MotionEvent.AXIS_ORIENTATION, pIndex, h),
                                eventTimeMs = event.getHistoricalEventTime(h)
                            )
                        )
                    }
                }

                pointers.add(
                    PointerInputSample(
                        pointerId = event.getPointerId(pIndex),
                        toolKind = nativeTool,
                        screenX = event.getX(pIndex),
                        screenY = event.getY(pIndex),
                        pressure = event.getPressure(pIndex),
                        tilt = event.getAxisValue(MotionEvent.AXIS_TILT, pIndex),
                        orientation = event.getAxisValue(MotionEvent.AXIS_ORIENTATION, pIndex),
                        stylusButtonPressed = stylusButtonPressed,
                        historicalSamples = historical
                    )
                )
            }

            val actionPointerId = if (
                actionMasked == MotionEvent.ACTION_POINTER_DOWN ||
                actionMasked == MotionEvent.ACTION_POINTER_UP
            ) {
                event.getPointerId(event.actionIndex)
            } else {
                null
            }

            return RoutedMotionEvent(
                action = mappedAction,
                actionPointerId = actionPointerId,
                downTimeMs = event.downTime,
                eventTimeMs = event.eventTime,
                flagCanceled = isFlagCanceled,
                pointers = pointers
            )
        }
    }
}
