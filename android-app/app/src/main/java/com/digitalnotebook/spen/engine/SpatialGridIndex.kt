package com.digitalnotebook.spen.engine

import com.digitalnotebook.spen.model.BoundingBox
import com.digitalnotebook.spen.model.DEFAULT_SPATIAL_CELL_SIZE
import com.digitalnotebook.spen.model.Stroke
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

object StrokeGeometryMath {

    fun computePointWidth(baseWidth: Float, pressure: Float): Float {
        val clampedPressure = pressure.coerceIn(0.0f, 1.0f)
        return max(0.5f, baseWidth * (0.35f + 0.90f * clampedPressure))
    }

    fun computeBoundingBox(stroke: Stroke): BoundingBox {
        if (stroke.points.isEmpty()) {
            return BoundingBox(0f, 0f, 0f, 0f)
        }
        val first = stroke.points.first()
        var minX = first.x
        var minY = first.y
        var maxX = first.x
        var maxY = first.y
        var maxHalfWidth = computePointWidth(stroke.baseWidth, first.pressure) * 0.5f

        for (i in 1 until stroke.points.size) {
            val pt = stroke.points[i]
            if (pt.x < minX) minX = pt.x
            if (pt.y < minY) minY = pt.y
            if (pt.x > maxX) maxX = pt.x
            if (pt.y > maxY) maxY = pt.y
            val hw = computePointWidth(stroke.baseWidth, pt.pressure) * 0.5f
            if (hw > maxHalfWidth) maxHalfWidth = hw
        }

        return BoundingBox(
            minX = minX - maxHalfWidth,
            minY = minY - maxHalfWidth,
            maxX = maxX + maxHalfWidth,
            maxY = maxY + maxHalfWidth
        )
    }

    fun distancePointToSegment(
        px: Float,
        py: Float,
        ax: Float,
        ay: Float,
        bx: Float,
        by: Float
    ): Float {
        val dx = bx - ax
        val dy = by - ay
        val lenSq = dx * dx + dy * dy
        if (lenSq <= 1e-7f) {
            return hypot(px - ax, py - ay)
        }
        val t = (((px - ax) * dx + (py - ay) * dy) / lenSq).coerceIn(0.0f, 1.0f)
        val projX = ax + t * dx
        val projY = ay + t * dy
        return hypot(px - projX, py - projY)
    }

    fun distanceSegmentToSegment(
        p1x: Float,
        p1y: Float,
        p2x: Float,
        p2y: Float,
        q1x: Float,
        q1y: Float,
        q2x: Float,
        q2y: Float
    ): Float {
        fun ccw(ax: Float, ay: Float, bx: Float, by: Float, cx: Float, cy: Float): Float =
            (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

        val d1 = ccw(p1x, p1y, p2x, p2y, q1x, q1y)
        val d2 = ccw(p1x, p1y, p2x, p2y, q2x, q2y)
        val d3 = ccw(q1x, q1y, q2x, q2y, p1x, p1y)
        val d4 = ccw(q1x, q1y, q2x, q2y, p2x, p2y)

        if (((d1 > 0f && d2 < 0f) || (d1 < 0f && d2 > 0f)) &&
            ((d3 > 0f && d4 < 0f) || (d3 < 0f && d4 > 0f))
        ) {
            return 0f
        }

        return min(
            min(
                distancePointToSegment(p1x, p1y, q1x, q1y, q2x, q2y),
                distancePointToSegment(p2x, p2y, q1x, q1y, q2x, q2y)
            ),
            min(
                distancePointToSegment(q1x, q1y, p1x, p1y, p2x, p2y),
                distancePointToSegment(q2x, q2y, p1x, p1y, p2x, p2y)
            )
        )
    }

    fun doesEraserSegmentIntersectStroke(
        ex1: Float,
        ey1: Float,
        ex2: Float,
        ey2: Float,
        eraserRadius: Float,
        stroke: Stroke
    ): Boolean {
        val pts = stroke.points
        if (pts.isEmpty()) return false

        if (pts.size == 1) {
            val p0 = pts[0]
            val halfWidth = computePointWidth(stroke.baseWidth, p0.pressure) * 0.5f
            val dist = distancePointToSegment(p0.x, p0.y, ex1, ey1, ex2, ey2)
            return dist <= eraserRadius + halfWidth
        }

        for (i in 0 until pts.size - 1) {
            val a = pts[i]
            val b = pts[i + 1]
            val avgPressure = (a.pressure + b.pressure) * 0.5f
            val halfSegmentWidth = computePointWidth(stroke.baseWidth, avgPressure) * 0.5f
            val threshold = eraserRadius + halfSegmentWidth

            val dist = distanceSegmentToSegment(ex1, ey1, ex2, ey2, a.x, a.y, b.x, b.y)
            if (dist <= threshold) {
                return true
            }
        }
        return false
    }
}

/**
 * Índice Espacial por Grade Uniforme para localizar rapidamente traços candidatos
 * para a borracha por traço inteiro sem varrer toda a página.
 */
class SpatialGridIndex(
    cellSize: Float = DEFAULT_SPATIAL_CELL_SIZE
) {
    private val effectiveCellSize = max(10f, cellSize)
    private val cells = HashMap<Long, MutableSet<String>>()
    private val strokesById = LinkedHashMap<String, Stroke>()
    private val bboxesById = HashMap<String, BoundingBox>()

    private fun packCellKey(cx: Int, cy: Int): Long {
        return (cx.toLong() shl 32) or (cy.toLong() and 0xFFFFFFFFL)
    }

    fun clear() {
        cells.clear()
        strokesById.clear()
        bboxesById.clear()
    }

    fun insert(stroke: Stroke) {
        remove(stroke.id)
        val bbox = StrokeGeometryMath.computeBoundingBox(stroke)
        strokesById[stroke.id] = stroke
        bboxesById[stroke.id] = bbox

        val minCellX = floor(bbox.minX / effectiveCellSize).toInt()
        val maxCellX = floor(bbox.maxX / effectiveCellSize).toInt()
        val minCellY = floor(bbox.minY / effectiveCellSize).toInt()
        val maxCellY = floor(bbox.maxY / effectiveCellSize).toInt()

        for (cx in minCellX..maxCellX) {
            for (cy in minCellY..maxCellY) {
                val key = packCellKey(cx, cy)
                val bucket = cells.getOrPut(key) { LinkedHashSet() }
                bucket.add(stroke.id)
            }
        }
    }

    fun remove(strokeId: String): Stroke? {
        val existing = strokesById.remove(strokeId) ?: return null
        val bbox = bboxesById.remove(strokeId) ?: return existing

        val minCellX = floor(bbox.minX / effectiveCellSize).toInt()
        val maxCellX = floor(bbox.maxX / effectiveCellSize).toInt()
        val minCellY = floor(bbox.minY / effectiveCellSize).toInt()
        val maxCellY = floor(bbox.maxY / effectiveCellSize).toInt()

        for (cx in minCellX..maxCellX) {
            for (cy in minCellY..maxCellY) {
                val key = packCellKey(cx, cy)
                val bucket = cells[key]
                if (bucket != null) {
                    bucket.remove(strokeId)
                    if (bucket.isEmpty()) {
                        cells.remove(key)
                    }
                }
            }
        }
        return existing
    }

    fun getAllStrokes(): List<Stroke> = strokesById.values.toList()

    fun queryCandidates(
        ex1: Float,
        ey1: Float,
        ex2: Float,
        ey2: Float,
        eraserRadius: Float
    ): List<Stroke> {
        val queryMinX = min(ex1, ex2) - eraserRadius
        val queryMaxX = max(ex1, ex2) + eraserRadius
        val queryMinY = min(ey1, ey2) - eraserRadius
        val queryMaxY = max(ey1, ey2) + eraserRadius

        val minCellX = floor(queryMinX / effectiveCellSize).toInt()
        val maxCellX = floor(queryMaxX / effectiveCellSize).toInt()
        val minCellY = floor(queryMinY / effectiveCellSize).toInt()
        val maxCellY = floor(queryMaxY / effectiveCellSize).toInt()

        val candidateIds = LinkedHashSet<String>()
        for (cx in minCellX..maxCellX) {
            for (cy in minCellY..maxCellY) {
                cells[packCellKey(cx, cy)]?.let { candidateIds.addAll(it) }
            }
        }

        val candidates = ArrayList<Stroke>(candidateIds.size)
        for (id in candidateIds) {
            val bbox = bboxesById[id] ?: continue
            val stroke = strokesById[id] ?: continue
            if (bbox.maxX >= queryMinX && bbox.minX <= queryMaxX &&
                bbox.maxY >= queryMinY && bbox.minY <= queryMaxY
            ) {
                candidates.add(stroke)
            }
        }
        return candidates
    }
}
