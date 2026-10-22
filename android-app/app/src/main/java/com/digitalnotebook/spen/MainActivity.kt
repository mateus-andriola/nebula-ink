package com.digitalnotebook.spen

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.lifecycle.lifecycleScope
import com.digitalnotebook.spen.data.PendingOperationDatabase
import com.digitalnotebook.spen.data.PreferencesRepository
import com.digitalnotebook.spen.sync.SyncWebSocketClient
import com.digitalnotebook.spen.ui.NotebookScreen
import com.digitalnotebook.spen.ui.PairingQrParser

class MainActivity : ComponentActivity() {

    private lateinit var preferencesRepository: PreferencesRepository
    private lateinit var pendingDatabase: PendingOperationDatabase
    private lateinit var syncClient: SyncWebSocketClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        preferencesRepository = PreferencesRepository(applicationContext)
        pendingDatabase = PendingOperationDatabase.getInstance(applicationContext)
        syncClient = SyncWebSocketClient(
            scope = lifecycleScope,
            pendingDao = pendingDatabase.pendingOperationDao()
        )

        handlePairingDeepLink(intent)

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                NotebookScreen(
                    preferencesRepository = preferencesRepository,
                    pendingDao = pendingDatabase.pendingOperationDao(),
                    syncClient = syncClient
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairingDeepLink(intent)
    }

    private fun handlePairingDeepLink(intent: Intent?) {
        val dataString = intent?.dataString ?: return
        val parsed = PairingQrParser.parse(dataString) ?: return
        syncClient.connectWithPairingToken(
            wsUrl = parsed.wsUrl,
            token = parsed.pairingToken,
            extraCandidates = parsed.candidateUrls
        )
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isFinishing) {
            syncClient.disconnect()
        }
    }
}
