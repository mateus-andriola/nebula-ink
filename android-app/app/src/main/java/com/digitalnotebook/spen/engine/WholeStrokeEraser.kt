package com.digitalnotebook.spen.engine

import com.digitalnotebook.spen.model.Stroke
import kotlin.math.max

/**
 * Gerenciador de passagem da Borracha por Traço Inteiro (WholeStrokeEraserSession).
 *
 * Regras atendidas:
 * 1. Detecta todos os traços que intersectam a área de contato da borracha.
 * 2. Remove o objeto inteiro quando qualquer segmento é atingido.
 * 3. Preserva traços próximos fora do raio de contato + espessura do segmento.
 * 4. Evita que o mesmo traço gere operações de remoção duplicadas durante uma única passagem.
 */
class WholeStrokeEraserSession(
    private val spatialIndex: SpatialGridIndex,
    initialRadius: Float = 14.0f
) {
    var eraserRadius: Float = max(1.0f, initialRadius)
        set(value) {
            field = max(1.0f, value)
        }

    private val erasedInCurrentPass = HashSet<String>()
    private var lastX: Float? = null
    private var lastY: Float? = null

    fun beginPass(x: Float, y: Float): List<Stroke> {
        erasedInCurrentPass.clear()
        lastX = x
        lastY = y
        return stepTo(x, y)
    }

    fun stepTo(x: Float, y: Float): List<Stroke> {
        val prevX = lastX ?: x
        val prevY = lastY ?: y
        lastX = x
        lastY = y

        val candidates = spatialIndex.queryCandidates(prevX, prevY, x, y, eraserRadius)
        if (candidates.isEmpty()) return emptyList()

        val newlyErased = ArrayList<Stroke>()
        for (stroke in candidates) {
            if (erasedInCurrentPass.contains(stroke.id)) continue

            val intersects = StrokeGeometryMath.doesEraserSegmentIntersectStroke(
                ex1 = prevX,
                ey1 = prevY,
                ex2 = x,
                ey2 = y,
                eraserRadius = eraserRadius,
                stroke = stroke
            )
            if (intersects) {
                erasedInCurrentPass.add(stroke.id)
                val removed = spatialIndex.remove(stroke.id)
                if (removed != null) {
                    newlyErased.add(removed)
                }
            }
        }
        return newlyErased
    }

    fun endPass() {
        lastX = null
        lastY = null
        erasedInCurrentPass.clear()
    }
}

sealed class ReversibleOperation(open val operationId: String) {
    data class AddStroke(
        override val operationId: String,
        val stroke: Stroke
    ) : ReversibleOperation(operationId)

    data class EraseStrokes(
        override val operationId: String,
        val targetStrokeIds: List<String>,
        val removedStrokes: List<Stroke>
    ) : ReversibleOperation(operationId)
}

/**
 * Motor de estado de página com suporte a Desfazer/Refazer e Idempotência por operationId.
 */
class PageDocumentEngine(
    val notebookId: String,
    val pageId: String
) {
    val spatialIndex = SpatialGridIndex()
    private val strokesOrder = ArrayList<String>()
    private val strokesMap = LinkedHashMap<String, Stroke>()
    private val processedOperationIds = HashSet<String>()
    private val undoStack = ArrayList<ReversibleOperation>()
    private val redoStack = ArrayList<ReversibleOperation>()

    fun hasProcessed(operationId: String): Boolean = processedOperationIds.contains(operationId)

    fun applyAddStroke(operationId: String, stroke: Stroke): Boolean {
        if (processedOperationIds.contains(operationId)) {
            return false // Operação duplicada (idempotente)
        }
        processedOperationIds.add(operationId)
        insertStrokeInternal(stroke)
        undoStack.add(ReversibleOperation.AddStroke(operationId, stroke))
        redoStack.clear()
        return true
    }

    fun applyEraseStrokes(
        operationId: String,
        targetStrokeIds: List<String>,
        removedStrokesFallback: List<Stroke> = emptyList()
    ): List<Stroke> {
        if (processedOperationIds.contains(operationId)) {
            return emptyList() // Idempotente: não apaga traços diferentes em reenvios
        }
        processedOperationIds.add(operationId)

        val fallbackById = removedStrokesFallback.associateBy { it.id }
        val removed = ArrayList<Stroke>()

        for (id in targetStrokeIds) {
            val stroke = strokesMap[id] ?: fallbackById[id]
            if (stroke != null) {
                removed.add(stroke)
            }
            removeStrokeInternal(id)
        }

        if (removed.isNotEmpty()) {
            undoStack.add(
                ReversibleOperation.EraseStrokes(
                    operationId = operationId,
                    targetStrokeIds = targetStrokeIds,
                    removedStrokes = removed
                )
            )
            redoStack.clear()
        }
        return removed
    }

    fun applyUndo(operationId: String, targetOperationId: String? = null): ReversibleOperation? {
        if (processedOperationIds.contains(operationId)) return null
        processedOperationIds.add(operationId)

        if (undoStack.isEmpty()) return null
        val index = if (targetOperationId != null) {
            undoStack.indexOfLast { it.operationId == targetOperationId }
        } else {
            undoStack.lastIndex
        }
        if (index < 0) return null

        val op = undoStack.removeAt(index)
        when (op) {
            is ReversibleOperation.AddStroke -> removeStrokeInternal(op.stroke.id)
            is ReversibleOperation.EraseStrokes -> {
                for (stroke in op.removedStrokes) {
                    insertStrokeInternal(stroke)
                }
            }
        }
        redoStack.add(op)
        return op
    }

    fun applyRedo(operationId: String, targetOperationId: String? = null): ReversibleOperation? {
        if (processedOperationIds.contains(operationId)) return null
        processedOperationIds.add(operationId)

        if (redoStack.isEmpty()) return null
        val index = if (targetOperationId != null) {
            redoStack.indexOfLast { it.operationId == targetOperationId }
        } else {
            redoStack.lastIndex
        }
        if (index < 0) return null

        val op = redoStack.removeAt(index)
        when (op) {
            is ReversibleOperation.AddStroke -> insertStrokeInternal(op.stroke)
            is ReversibleOperation.EraseStrokes -> {
                for (id in op.targetStrokeIds) {
                    removeStrokeInternal(id)
                }
            }
        }
        undoStack.add(op)
        return op
    }

    fun canUndo(): Boolean = undoStack.isNotEmpty()
    fun canRedo(): Boolean = redoStack.isNotEmpty()

    fun getStrokes(): List<Stroke> = strokesOrder.mapNotNull { strokesMap[it] }

    fun replacePageStrokes(strokes: List<Stroke>) {
        strokesOrder.clear()
        strokesMap.clear()
        spatialIndex.clear()
        for (s in strokes) {
            insertStrokeInternal(s)
        }
    }

    private fun insertStrokeInternal(stroke: Stroke) {
        if (!strokesMap.containsKey(stroke.id)) {
            strokesOrder.add(stroke.id)
        }
        strokesMap[stroke.id] = stroke
        spatialIndex.insert(stroke)
    }

    private fun removeStrokeInternal(strokeId: String) {
        strokesMap.remove(strokeId)
        strokesOrder.remove(strokeId)
        spatialIndex.remove(strokeId)
    }
}
