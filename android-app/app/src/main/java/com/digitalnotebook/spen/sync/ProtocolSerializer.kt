package com.digitalnotebook.spen.sync

import com.digitalnotebook.spen.model.Stroke
import com.digitalnotebook.spen.model.StrokePoint
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

@Serializable
data class WireEnvelope(
    val type: String,
    val timestamp: Long,
    val payload: JsonObject
)

@Serializable
data class SessionStartClientPayload(
    val role: String = "client",
    val pairingToken: String,
    val deviceId: String,
    val deviceName: String,
    val clientVersion: String = "1.0.0"
)

@Serializable
data class SessionResumePayload(
    val sessionId: String,
    val sessionResumeToken: String,
    val deviceId: String,
    val lastAckedOperationId: String? = null
)

@Serializable
data class StrokeBeginPayload(
    val operationId: String,
    val strokeId: String,
    val notebookId: String,
    val pageId: String,
    val color: String,
    val baseWidth: Float,
    val toolType: String = "pen",
    val startPoint: StrokePoint
)

@Serializable
data class StrokePointsPayload(
    val strokeId: String,
    val pageId: String,
    val seq: Int,
    val points: List<StrokePoint>
)

@Serializable
data class StrokeEndPayload(
    val operationId: String,
    val notebookId: String,
    val pageId: String,
    val cancelled: Boolean = false,
    val stroke: Stroke
)

@Serializable
data class StrokesErasePayload(
    val operationId: String,
    val notebookId: String,
    val pageId: String,
    val targetStrokeIds: List<String>,
    val removedStrokes: List<Stroke>
)

@Serializable
data class OperationUndoRedoPayload(
    val operationId: String,
    val notebookId: String,
    val pageId: String,
    val targetOperationId: String? = null
)

@Serializable
data class PageSelectPayload(
    val operationId: String,
    val notebookId: String,
    val pageId: String
)

@Serializable
data class OperationAckPayload(
    val operationId: String,
    val pageId: String,
    val status: String,
    val duplicate: Boolean,
    val serverTimestamp: Long
)

@Serializable
data class SessionErrorPayload(
    val code: String,
    val message: String,
    val relatedOperationId: String? = null,
    val fatal: Boolean = false
)

@Serializable
data class ServerPageMetadata(
    val id: String,
    val notebookId: String = "nb_default",
    val title: String = "Página 1",
    val width: Float = 1000.0f,
    val height: Float = 1414.2135f
)

@Serializable
data class ServerNotebookSummary(
    val id: String,
    val title: String,
    val pages: List<ServerPageMetadata> = emptyList()
)

@Serializable
data class ServerPageSnapshot(
    val metadata: ServerPageMetadata,
    val strokes: List<Stroke> = emptyList(),
    val canUndo: Boolean = false,
    val canRedo: Boolean = false
)

@Serializable
data class ServerSessionSyncPayload(
    val activeNotebookId: String = "nb_default",
    val activePageId: String = "page_default_1",
    val notebooks: List<ServerNotebookSummary> = emptyList(),
    val activePage: ServerPageSnapshot? = null
)

object ProtocolSerializer {
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    inline fun <reified T> encodeMessage(type: String, payload: T, timestamp: Long = System.currentTimeMillis()): String {
        val payloadObj = json.encodeToJsonElement(payload) as JsonObject
        val envelope = WireEnvelope(type = type, timestamp = timestamp, payload = payloadObj)
        return json.encodeToString(envelope)
    }

    fun decodeEnvelope(raw: String): WireEnvelope {
        return json.decodeFromString(raw)
    }

    inline fun <reified T> decodePayload(envelope: WireEnvelope): T {
        return json.decodeFromJsonElement(envelope.payload)
    }
}
