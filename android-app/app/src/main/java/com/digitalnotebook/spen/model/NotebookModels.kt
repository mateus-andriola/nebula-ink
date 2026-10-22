package com.digitalnotebook.spen.model

import kotlinx.serialization.Serializable
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

const val DEFAULT_PAGE_WIDTH = 1000.0f
const val DEFAULT_PAGE_HEIGHT = 1414.2135f
const val DEFAULT_SPATIAL_CELL_SIZE = 50.0f

@Serializable
data class StrokePoint(
    val x: Float,
    val y: Float,
    val pressure: Float,
    val tiltX: Float? = null,
    val tiltY: Float? = null,
    val orientation: Float? = null,
    val t: Long
)

@Serializable
data class Stroke(
    val id: String,
    val pageId: String,
    val notebookId: String,
    val color: String,
    val baseWidth: Float,
    val toolType: String = "pen",
    val points: List<StrokePoint>,
    val createdAt: Long
)

data class BoundingBox(
    val minX: Float,
    val minY: Float,
    val maxX: Float,
    val maxY: Float
)

data class ViewportTransform(
    val scale: Float = 1.0f,
    val panX: Float = 0.0f,
    val panY: Float = 0.0f,
    val minScale: Float = 0.25f,
    val maxScale: Float = 5.0f
) {
    fun screenToLogical(screenX: Float, screenY: Float): Pair<Float, Float> {
        val safeScale = if (scale > 0.0001f) scale else 1.0f
        return Pair(
            (screenX - panX) / safeScale,
            (screenY - panY) / safeScale
        )
    }

    fun logicalToScreen(logicalX: Float, logicalY: Float): Pair<Float, Float> {
        return Pair(
            logicalX * scale + panX,
            logicalY * scale + panY
        )
    }

    fun applyPinchZoom(
        scaleFactor: Float,
        focalScreenX: Float,
        focalScreenY: Float,
        panDeltaX: Float = 0f,
        panDeltaY: Float = 0f
    ): ViewportTransform {
        val newScale = max(minScale, min(maxScale, scale * scaleFactor))
        val (logicalFocalX, logicalFocalY) = screenToLogical(focalScreenX, focalScreenY)
        val newPanX = focalScreenX - logicalFocalX * newScale + panDeltaX
        val newPanY = focalScreenY - logicalFocalY * newScale + panDeltaY
        return copy(scale = newScale, panX = newPanX, panY = newPanY)
    }
}

enum class FingerMode(val wireValue: String) {
    BOTH("both"),
    VERTICAL("vertical"),
    HORIZONTAL("horizontal"),
    NONE("none");

    companion object {
        fun fromWire(value: String): FingerMode =
            entries.firstOrNull { it.wireValue.equals(value, ignoreCase = true) } ?: BOTH
    }
}

enum class ScrollMode(val wireValue: String) {
    FREE("free"),
    AXIS_LOCKED("axisLocked");

    companion object {
        fun fromWire(value: String): ScrollMode =
            entries.firstOrNull { it.wireValue.equals(value, ignoreCase = true) } ?: FREE
    }
}

enum class ActiveUiTool {
    PEN,
    ERASER
}

enum class ShapeToolKind(val label: String, val icon: String) {
    NONE("Livre", "✒"),
    LINE("Reta", "╱"),
    QUADRILATERAL("Quadrilátero", "▭"),
    CIRCLE("Círculo", "◯"),
    CYLINDER("Cilindro", "⌭"),
    POLYGON_N("Polígono N", "⬡")
}

object ShapeGeometryGenerator {
    private const val DEFAULT_SHAPE_PRESSURE = 0.55f

    private fun roundCoord(v: Float): Float = (v * 1000f).roundToInt() / 1000f

    private fun makePoint(x: Float, y: Float, t: Long): StrokePoint {
        return StrokePoint(
            x = roundCoord(x),
            y = roundCoord(y),
            pressure = DEFAULT_SHAPE_PRESSURE,
            t = t
        )
    }

    private fun interpolateSegment(
        ax: Float,
        ay: Float,
        bx: Float,
        by: Float,
        includeStart: Boolean,
        elapsedMs: Long,
        out: MutableList<StrokePoint>
    ) {
        val dist = hypot(bx - ax, by - ay)
        val steps = max(2, min(48, (dist / 8.0f).toInt() + 1))
        val startIdx = if (includeStart) 0 else 1
        for (i in startIdx..steps) {
            val ratio = i.toFloat() / steps.toFloat()
            val px = ax + (bx - ax) * ratio
            val py = ay + (by - ay) * ratio
            out.add(makePoint(px, py, elapsedMs))
        }
    }

    fun generateShapePoints(
        shape: ShapeToolKind,
        x0: Float,
        y0: Float,
        x1: Float,
        y1: Float,
        polygonSides: Int,
        elapsedMs: Long
    ): List<StrokePoint> {
        val pts = ArrayList<StrokePoint>(128)
        val dx = x1 - x0
        val dy = y1 - y0
        val dragDist = hypot(dx, dy)
        if (dragDist < 1.5f) {
            pts.add(makePoint(x0, y0, 0L))
            pts.add(makePoint(x1, y1, elapsedMs))
            return pts
        }

        when (shape) {
            ShapeToolKind.NONE -> {
                pts.add(makePoint(x0, y0, 0L))
                pts.add(makePoint(x1, y1, elapsedMs))
            }

            ShapeToolKind.LINE -> {
                interpolateSegment(x0, y0, x1, y1, includeStart = true, elapsedMs = elapsedMs, out = pts)
            }

            ShapeToolKind.QUADRILATERAL -> {
                interpolateSegment(x0, y0, x1, y0, includeStart = true, elapsedMs = elapsedMs, out = pts)
                interpolateSegment(x1, y0, x1, y1, includeStart = false, elapsedMs = elapsedMs, out = pts)
                interpolateSegment(x1, y1, x0, y1, includeStart = false, elapsedMs = elapsedMs, out = pts)
                interpolateSegment(x0, y1, x0, y0, includeStart = false, elapsedMs = elapsedMs, out = pts)
            }

            ShapeToolKind.CIRCLE -> {
                val cx = (x0 + x1) * 0.5f
                val cy = (y0 + y1) * 0.5f
                val radius = max(2.0f, dragDist * 0.5f)
                val steps = 72
                for (i in 0..steps) {
                    val angle = (2.0 * PI * i) / steps
                    val px = cx + (radius * cos(angle)).toFloat()
                    val py = cy + (radius * sin(angle)).toFloat()
                    pts.add(makePoint(px, py, elapsedMs))
                }
            }

            ShapeToolKind.CYLINDER -> {
                val minX = min(x0, x1)
                val maxX = max(x0, x1)
                val minY = min(y0, y1)
                val maxY = max(y0, y1)
                val w = max(12.0f, maxX - minX)
                val h = max(16.0f, maxY - minY)
                val cx = (minX + maxX) * 0.5f
                val rx = w * 0.5f
                val ry = min(h * 0.22f, w * 0.30f).coerceAtLeast(4.0f)
                val topCy = minY + ry
                val botCy = max(topCy + 4.0f, maxY - ry)
                val ellipseSteps = 48

                // 1. Elipse superior completa (0 .. 2*PI), terminando na direita (cx + rx, topCy)
                for (i in 0..ellipseSteps) {
                    val angle = (2.0 * PI * i) / ellipseSteps
                    val px = cx + (rx * cos(angle)).toFloat()
                    val py = topCy + (ry * sin(angle)).toFloat()
                    pts.add(makePoint(px, py, elapsedMs))
                }

                // 2. Parede lateral direita descendo até (cx + rx, botCy)
                interpolateSegment(
                    cx + rx,
                    topCy,
                    cx + rx,
                    botCy,
                    includeStart = false,
                    elapsedMs = elapsedMs,
                    out = pts
                )

                // 3. Elipse inferior completa (0 .. 2*PI) + meia volta (0 .. PI) até a esquerda (cx - rx, botCy)
                val botTotalSteps = ellipseSteps + (ellipseSteps / 2)
                for (i in 1..botTotalSteps) {
                    val angle = (2.0 * PI * i) / ellipseSteps
                    val px = cx + (rx * cos(angle)).toFloat()
                    val py = botCy + (ry * sin(angle)).toFloat()
                    pts.add(makePoint(px, py, elapsedMs))
                }

                // 4. Parede lateral esquerda subindo de (cx - rx, botCy) até (cx - rx, topCy)
                interpolateSegment(
                    cx - rx,
                    botCy,
                    cx - rx,
                    topCy,
                    includeStart = false,
                    elapsedMs = elapsedMs,
                    out = pts
                )
            }

            ShapeToolKind.POLYGON_N -> {
                val n = polygonSides.coerceIn(3, 24)
                val cx = (x0 + x1) * 0.5f
                val cy = (y0 + y1) * 0.5f
                val radius = max(3.0f, dragDist * 0.5f)
                val startAngle = -PI / 2.0
                val vertices = ArrayList<Pair<Float, Float>>(n + 1)
                for (i in 0..n) {
                    val angle = startAngle + (2.0 * PI * (i % n)) / n
                    val vx = cx + (radius * cos(angle)).toFloat()
                    val vy = cy + (radius * sin(angle)).toFloat()
                    vertices.add(Pair(vx, vy))
                }
                for (i in 0 until n) {
                    val (ax, ay) = vertices[i]
                    val (bx, by) = vertices[i + 1]
                    interpolateSegment(
                        ax,
                        ay,
                        bx,
                        by,
                        includeStart = (i == 0),
                        elapsedMs = elapsedMs,
                        out = pts
                    )
                }
            }
        }

        return pts
    }
}

data class InputPreferences(
    val fingerMode: FingerMode = FingerMode.BOTH,
    val scrollMode: ScrollMode = ScrollMode.FREE,
    val palmRejection: Boolean = true,
    val pinchZoom: Boolean = true
)

@Serializable
data class GridSettings(
    val enabled: Boolean = true,
    val spacing: Float = 25f,
    val color: String = "#94A3B8",
    val opacity: Float = 0.45f,
    val includeInPdf: Boolean = true
)

@Serializable
data class EraseOperationRecord(
    val operationId: String,
    val notebookId: String,
    val pageId: String,
    val targetStrokeIds: List<String>,
    val removedStrokes: List<Stroke>,
    val timestamp: Long
)

enum class ConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    AWAITING_APPROVAL,
    CONNECTED_SYNCED,
    CONNECTED_SYNCING,
    RECONNECTING,
    ERROR
}
