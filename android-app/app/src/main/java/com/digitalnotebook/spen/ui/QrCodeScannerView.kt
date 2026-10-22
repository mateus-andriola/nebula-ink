package com.digitalnotebook.spen.ui

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.EnumMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

data class ParsedQrPairingData(
    val wsUrl: String,
    val pairingToken: String,
    val candidateUrls: List<String> = emptyList()
)

object PairingQrParser {
    private val lenientJson = Json { ignoreUnknownKeys = true }

    fun parse(rawContent: String): ParsedQrPairingData? {
        val trimmed = rawContent.trim()
        if (trimmed.isEmpty()) return null

        // 1. Tenta decodificar JSON gerado pelo Desktop: {"v":1,"host":"...","port":8765,"protocol":"ws","pairingToken":"tkn_..."}
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            val parsedJson = runCatching {
                val obj = lenientJson.parseToJsonElement(trimmed).jsonObject
                val protocol = obj["protocol"]?.jsonPrimitive?.content ?: "ws"
                val host = obj["host"]?.jsonPrimitive?.content ?: ""
                val port = obj["port"]?.jsonPrimitive?.intOrNull ?: 8765
                val token = obj["pairingToken"]?.jsonPrimitive?.content ?: "auto_lan"
                val candidates = obj["candidates"]?.jsonArray?.mapNotNull {
                    it.jsonPrimitive.content.takeIf { h -> h.isNotBlank() }
                }.orEmpty()

                if (host.isNotBlank()) {
                    val primaryUrl = "$protocol://$host:$port"
                    val allCandidateUrls = (listOf(primaryUrl) + candidates.map { "$protocol://$it:$port" })
                        .distinct()
                    ParsedQrPairingData(
                        wsUrl = primaryUrl,
                        pairingToken = token,
                        candidateUrls = allCandidateUrls
                    )
                } else {
                    null
                }
            }.getOrNull()

            if (parsedJson != null) return parsedJson
        }

        // 2. Tenta decodificar URI customizada digitalnotebook://pair?host=...&port=...&token=...
        if (trimmed.startsWith("digitalnotebook://", ignoreCase = true)) {
            val uri = runCatching { Uri.parse(trimmed) }.getOrNull()
            if (uri != null) {
                val host = uri.getQueryParameter("host").orEmpty()
                val port = uri.getQueryParameter("port")?.toIntOrNull() ?: 8765
                val protocol = uri.getQueryParameter("protocol") ?: "ws"
                val token = uri.getQueryParameter("token") ?: "auto_lan"
                if (host.isNotBlank()) {
                    val primaryUrl = "$protocol://$host:$port"
                    return ParsedQrPairingData(
                        wsUrl = primaryUrl,
                        pairingToken = token,
                        candidateUrls = listOf(primaryUrl)
                    )
                }
            }
        }

        // 3. Tenta decodificar URL direta ws:// ou wss:// ou http://
        if (trimmed.startsWith("ws://", ignoreCase = true) ||
            trimmed.startsWith("wss://", ignoreCase = true) ||
            trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)
        ) {
            val uri = runCatching { Uri.parse(trimmed) }.getOrNull()
            val token = uri?.getQueryParameter("token")
                ?: uri?.getQueryParameter("pairingToken")
                ?: "auto_lan"
            val normalizedWs = trimmed
                .substringBefore("?")
                .replaceFirst("http://", "ws://", ignoreCase = true)
                .replaceFirst("https://", "wss://", ignoreCase = true)
            return ParsedQrPairingData(
                wsUrl = normalizedWs,
                pairingToken = token,
                candidateUrls = listOf(normalizedWs)
            )
        }

        return null
    }
}

@Composable
fun QrCodeCameraScannerBox(
    onQrCodeScanned: (ParsedQrPairingData) -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasCameraPermission = granted
    }

    LaunchedEffect(Unit) {
        if (!hasCameraPermission) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    if (!hasCameraPermission) {
        Column(
            modifier = modifier
                .fillMaxWidth()
                .height(220.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF0F172A))
                .border(1.dp, Color(0xFF334155), RoundedCornerShape(12.dp))
                .padding(16.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "Permissão de câmera necessária para ler o QR Code do Desktop.",
                color = Color(0xFFCBD5E1),
                fontSize = 12.sp,
                textAlign = TextAlign.Center
            )
            Button(
                onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                modifier = Modifier.padding(top = 10.dp)
            ) {
                Text("Permitir Câmera")
            }
        }
        return
    }

    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val hasDeliveredResult = remember { AtomicBoolean(false) }

    DisposableEffect(Unit) {
        onDispose {
            analysisExecutor.shutdownNow()
        }
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(240.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color.Black)
            .border(1.5.dp, Color(0xFF38BDF8), RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center
    ) {
        AndroidView(
            factory = { ctx ->
                val previewView = PreviewView(ctx).apply {
                    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                }

                val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
                cameraProviderFuture.addListener({
                    val cameraProvider = runCatching { cameraProviderFuture.get() }.getOrNull()
                        ?: return@addListener

                    val preview = Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }

                    val reader = MultiFormatReader().apply {
                        val hints = EnumMap<DecodeHintType, Any>(DecodeHintType::class.java)
                        hints[DecodeHintType.POSSIBLE_FORMATS] = listOf(BarcodeFormat.QR_CODE)
                        hints[DecodeHintType.TRY_HARDER] = java.lang.Boolean.TRUE
                        hints[DecodeHintType.CHARACTER_SET] = "UTF-8"
                        setHints(hints)
                    }

                    val imageAnalysis = ImageAnalysis.Builder()
                        .setTargetResolution(Size(1280, 720))
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()

                    imageAnalysis.setAnalyzer(analysisExecutor) { imageProxy ->
                        if (!hasDeliveredResult.get()) {
                            val decodedText = decodeQrFromImageProxy(imageProxy, reader)
                            if (decodedText != null) {
                                val parsed = PairingQrParser.parse(decodedText)
                                if (parsed != null && hasDeliveredResult.compareAndSet(false, true)) {
                                    previewView.post {
                                        onQrCodeScanned(parsed)
                                    }
                                }
                            }
                        }
                        imageProxy.close()
                    }

                    runCatching {
                        cameraProvider.unbindAll()
                        cameraProvider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            imageAnalysis
                        )
                    }
                }, ContextCompat.getMainExecutor(ctx))

                previewView
            },
            modifier = Modifier.fillMaxSize()
        )

        // Moldura guia centralizada para apontar para o QR Code
        Box(
            modifier = Modifier
                .size(165.dp)
                .border(2.dp, Color(0xCC38BDF8), RoundedCornerShape(14.dp))
        )

        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 8.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Color(0xCC020617))
                .padding(horizontal = 10.dp, vertical = 4.dp)
        ) {
            Text(
                text = "Aponte a câmera para o QR Code no Desktop",
                color = Color(0xFFF8FAFC),
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium
            )
        }
    }
}

private fun decodeQrFromImageProxy(image: ImageProxy, reader: MultiFormatReader): String? {
    val plane = image.planes.firstOrNull() ?: return null
    val buffer = plane.buffer
    val width = image.width
    val height = image.height
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride

    if (width <= 0 || height <= 0) return null

    // Extrai o plano Y (luminância) removendo padding de rowStride para evitar distorção
    val yBytes = ByteArray(width * height)
    buffer.rewind()

    if (pixelStride == 1 && rowStride == width) {
        buffer.get(yBytes, 0, width * height)
    } else {
        val rowBuffer = ByteArray(rowStride)
        for (row in 0 until height) {
            val pos = row * rowStride
            if (pos >= buffer.limit()) break
            buffer.position(pos)
            val bytesToRead = minOf(rowStride, buffer.remaining())
            buffer.get(rowBuffer, 0, bytesToRead)
            if (pixelStride == 1) {
                System.arraycopy(rowBuffer, 0, yBytes, row * width, minOf(width, bytesToRead))
            } else {
                var col = 0
                var srcIdx = 0
                while (col < width && srcIdx < bytesToRead) {
                    yBytes[row * width + col] = rowBuffer[srcIdx]
                    col++
                    srcIdx += pixelStride
                }
            }
        }
    }

    // 1ª tentativa: orientação original (normal + invertido para monitores em modo dark)
    decodeLuminanceArray(yBytes, width, height, reader)?.let { return it }

    // 2ª tentativa: rotacionado 90 graus (caso o sensor esteja em orientação perpendicular)
    val rotated = ByteArray(width * height)
    for (y in 0 until height) {
        for (x in 0 until width) {
            rotated[x * height + (height - 1 - y)] = yBytes[y * width + x]
        }
    }
    return decodeLuminanceArray(rotated, height, width, reader)
}

private fun decodeLuminanceArray(
    luminance: ByteArray,
    width: Int,
    height: Int,
    reader: MultiFormatReader
): String? {
    val source = PlanarYUVLuminanceSource(
        luminance,
        width,
        height,
        0,
        0,
        width,
        height,
        false
    )

    // Tenta com HybridBinarizer
    runCatching {
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        return reader.decodeWithState(bitmap).text
    }.also { reader.reset() }

    // Tenta com GlobalHistogramBinarizer (ótimo para reflexos de tela de computador)
    runCatching {
        val bitmap = BinaryBitmap(GlobalHistogramBinarizer(source))
        return reader.decodeWithState(bitmap).text
    }.also { reader.reset() }

    // Tenta com luminância invertida (caso o QR tenha contraste invertido)
    runCatching {
        val invertedBitmap = BinaryBitmap(HybridBinarizer(source.invert()))
        return reader.decodeWithState(invertedBitmap).text
    }.also { reader.reset() }

    return null
}
