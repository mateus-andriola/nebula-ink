package com.digitalnotebook.spen.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import android.view.MotionEvent
import android.view.View
import com.digitalnotebook.spen.engine.StrokeGeometryMath
import com.digitalnotebook.spen.input.MotionEventRouter
import com.digitalnotebook.spen.input.ResolvedPointerRole
import com.digitalnotebook.spen.model.DEFAULT_PAGE_HEIGHT
import com.digitalnotebook.spen.model.DEFAULT_PAGE_WIDTH
import com.digitalnotebook.spen.model.GridSettings
import com.digitalnotebook.spen.model.Stroke
import com.digitalnotebook.spen.model.ViewportTransform
import kotlin.math.roundToInt

/**
 * Android View customizada para captura de alta precisão da S Pen e renderização direta
 * acelerada por hardware (GPU) na mesma matriz de transformação da folha lógica.
 */
class SPenCanvasView(context: Context) : View(context) {

    var motionRouter: MotionEventRouter? = null

    private var committedStrokes: List<Stroke> = emptyList()
    private var provisionalStroke: Stroke? = null
    private var viewport: ViewportTransform = ViewportTransform()
    private var gridSettings: GridSettings = GridSettings()
    private var pageWidth: Float = DEFAULT_PAGE_WIDTH
    private var pageHeight: Float = DEFAULT_PAGE_HEIGHT
    private var pageBackgroundColor: Int = Color.parseColor("#0F172A")
    private var eraserRadiusLogical: Float = 14.0f

    // Hover preview da S Pen
    private var hoverRole: ResolvedPointerRole? = null
    private var hoverLogicalX: Float = 0f
    private var hoverLogicalY: Float = 0f

    private val viewportBgPaint = Paint().apply {
        style = Paint.Style.FILL
        color = Color.parseColor("#020617")
    }

    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    private val pageShadowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.parseColor("#000000")
    }

    private val pageBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.parseColor("#0F172A")
    }

    private val pageBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.5f
        color = Color.parseColor("#334155")
    }

    private val hoverPreviewPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.0f
        color = Color.parseColor("#EF4444")
    }

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        setWillNotDraw(false)
    }

    fun setCommittedStrokes(strokes: List<Stroke>) {
        committedStrokes = strokes
        invalidate()
    }

    /**
     * Atualiza a lista de traços confirmados e limpa o traço provisório.
     * Como a renderização ocorre diretamente no Canvas acelerado por GPU na mesma
     * transformação da folha, nenhum traço é cortado por limites de Bitmap intermediário.
     */
    fun appendCommittedStrokeIncrementally(stroke: Stroke, updatedList: List<Stroke>) {
        committedStrokes = updatedList
        provisionalStroke = null
        invalidate()
    }

    fun setProvisionalStroke(stroke: Stroke?) {
        provisionalStroke = stroke
        invalidate()
    }

    fun setViewportTransform(newViewport: ViewportTransform) {
        if (viewport != newViewport) {
            viewport = newViewport
            invalidate()
        }
    }

    fun setGridConfiguration(newGrid: GridSettings) {
        if (gridSettings != newGrid) {
            gridSettings = newGrid
            invalidate()
        }
    }

    fun setPageDimensions(width: Float, height: Float) {
        val safeW = if (width > 100f) width else DEFAULT_PAGE_WIDTH
        val safeH = if (height > 100f) height else DEFAULT_PAGE_HEIGHT
        if (pageWidth != safeW || pageHeight != safeH) {
            pageWidth = safeW
            pageHeight = safeH
            invalidate()
        }
    }

    fun setHoverPreview(role: ResolvedPointerRole?, logicalX: Float, logicalY: Float, eraserRadius: Float) {
        hoverRole = role
        hoverLogicalX = logicalX
        hoverLogicalY = logicalY
        eraserRadiusLogical = eraserRadius
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w > 0 && h > 0) {
            updateEdgeGestureExclusion(w, h)
            if (oldw == 0 && oldh == 0) {
                val fitScale = (w.toFloat() / pageWidth).coerceIn(0.25f, 3.0f)
                val fittedViewport = viewport.copy(scale = fitScale, panX = 0f, panY = 0f)
                viewport = fittedViewport
                motionRouter?.updateViewport(fittedViewport)
            }
        }
    }

    private fun updateEdgeGestureExclusion(w: Int, h: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val edgePx = (28f * resources.displayMetrics.density).roundToInt().coerceAtLeast(32)
            systemGestureExclusionRects = listOf(
                Rect(0, 0, edgePx, h),
                Rect((w - edgePx).coerceAtLeast(0), 0, w, h),
                Rect(0, (h - edgePx).coerceAtLeast(0), w, h)
            )
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        parent?.requestDisallowInterceptTouchEvent(true)
        val router = motionRouter ?: return super.onTouchEvent(event)
        val routed = MotionEventRouter.fromAndroidMotionEvent(event)
        router.route(routed)
        provisionalStroke = router.getProvisionalStroke()
        invalidate()
        return true
    }

    override fun onGenericMotionEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_HOVER_MOVE ||
            event.actionMasked == MotionEvent.ACTION_HOVER_ENTER ||
            event.actionMasked == MotionEvent.ACTION_HOVER_EXIT
        ) {
            val router = motionRouter ?: return super.onGenericMotionEvent(event)
            val routed = MotionEventRouter.fromAndroidMotionEvent(event)
            router.route(routed)
            return true
        }
        return super.onGenericMotionEvent(event)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        val viewW = width.toFloat()
        val viewH = height.toFloat()
        if (viewW <= 0f || viewH <= 0f) return

        // Restringe estritamente o desenho aos limites reais desta View para nunca vazar sobre a barra superior
        val rootSave = canvas.save()
        canvas.clipRect(0f, 0f, viewW, viewH)

        // 1. Fundo da área de visualização (Dark Mode)
        canvas.drawRect(0f, 0f, viewW, viewH, viewportBgPaint)

        // 2. Transformação única da Página Lógica (Folha + Grade + Traços Confirmados + Traço Provisório)
        canvas.save()
        canvas.translate(viewport.panX, viewport.panY)
        canvas.scale(viewport.scale, viewport.scale)

        // Sombra sutil e folha escura da página lógica (Vertical ou Horizontal)
        canvas.drawRect(4f, 6f, pageWidth + 4f, pageHeight + 6f, pageShadowPaint)
        pageBgPaint.color = pageBackgroundColor
        canvas.drawRect(0f, 0f, pageWidth, pageHeight, pageBgPaint)
        pageBorderPaint.strokeWidth = 1.5f / viewport.scale
        canvas.drawRect(0f, 0f, pageWidth, pageHeight, pageBorderPaint)

        if (gridSettings.enabled) {
            drawDottedGrid(canvas)
        }

        // 3. Traços confirmados desenhados diretamente na mesma transformação da folha (sem corte de Bitmap)
        for (stroke in committedStrokes) {
            drawSingleStroke(canvas, stroke)
        }

        // 4. Traço provisório de baixa latência (em andamento)
        val activeStroke = provisionalStroke
        if (activeStroke != null) {
            drawSingleStroke(canvas, activeStroke)
        }

        // 5. Indicador de Hover da S Pen / Raio da Borracha por Traço Inteiro
        val currentHover = hoverRole
        if (currentHover == ResolvedPointerRole.STYLUS_ERASER) {
            hoverPreviewPaint.strokeWidth = 1.5f / viewport.scale
            canvas.drawCircle(hoverLogicalX, hoverLogicalY, eraserRadiusLogical, hoverPreviewPaint)
        }

        canvas.restore()
        canvas.restoreToCount(rootSave)
    }

    private fun drawDottedGrid(canvas: Canvas) {
        val spacing = gridSettings.spacing.coerceIn(10f, 100f)
        val gridHex = if (gridSettings.color.equals("#CBD5E1", ignoreCase = true) ||
            gridSettings.color.equals("#E2E8F0", ignoreCase = true)
        ) {
            "#475569"
        } else {
            gridSettings.color
        }
        val baseColor = runCatching { Color.parseColor(gridHex) }.getOrDefault(Color.parseColor("#475569"))
        val alpha = (gridSettings.opacity.coerceIn(0.05f, 1.0f) * 255).toInt()
        gridPaint.color = Color.argb(
            alpha,
            Color.red(baseColor),
            Color.green(baseColor),
            Color.blue(baseColor)
        )

        val dotRadius = 1.3f
        var y = spacing
        while (y < pageHeight) {
            var x = spacing
            while (x < pageWidth) {
                canvas.drawCircle(x, y, dotRadius, gridPaint)
                x += spacing
            }
            y += spacing
        }
    }

    private fun resolveDarkCanvasStrokeColor(hex: String): Int {
        val normalized = hex.trim().uppercase()
        if (normalized == "#111827" || normalized == "#000000" || normalized == "#0F172A") {
            return Color.parseColor("#F8FAFC")
        }
        return runCatching { Color.parseColor(hex) }.getOrDefault(Color.parseColor("#F8FAFC"))
    }

    private fun drawSingleStroke(canvas: Canvas, stroke: Stroke) {
        val pts = stroke.points
        if (pts.isEmpty()) return

        strokePaint.color = resolveDarkCanvasStrokeColor(stroke.color)

        if (pts.size == 1) {
            val p0 = pts[0]
            val w = StrokeGeometryMath.computePointWidth(stroke.baseWidth, p0.pressure)
            strokePaint.style = Paint.Style.FILL
            canvas.drawCircle(p0.x, p0.y, w * 0.5f, strokePaint)
            strokePaint.style = Paint.Style.STROKE
            return
        }

        // Renderiza cada segmento preservando a variação de espessura por pressão da S Pen
        for (i in 0 until pts.size - 1) {
            val a = pts[i]
            val b = pts[i + 1]
            val avgPressure = (a.pressure + b.pressure) * 0.5f
            strokePaint.strokeWidth = StrokeGeometryMath.computePointWidth(stroke.baseWidth, avgPressure)
            canvas.drawLine(a.x, a.y, b.x, b.y, strokePaint)
        }
    }
}
