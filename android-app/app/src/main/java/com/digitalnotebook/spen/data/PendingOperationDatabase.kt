package com.digitalnotebook.spen.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "pending_operations")
data class PendingOperationEntity(
    @PrimaryKey
    val operationId: String,
    val notebookId: String,
    val pageId: String,
    val messageType: String,
    val serializedEnvelopeJson: String,
    val createdAt: Long
)

@Dao
interface PendingOperationDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun enqueue(operation: PendingOperationEntity)

    @Query("SELECT * FROM pending_operations ORDER BY createdAt ASC")
    suspend fun getAllPendingOrdered(): List<PendingOperationEntity>

    @Query("SELECT COUNT(*) FROM pending_operations")
    fun observePendingCount(): Flow<Int>

    @Query("DELETE FROM pending_operations WHERE operationId = :operationId")
    suspend fun acknowledge(operationId: String)

    @Query("DELETE FROM pending_operations")
    suspend fun clearAll()
}

@Database(
    entities = [PendingOperationEntity::class],
    version = 1,
    exportSchema = false
)
abstract class PendingOperationDatabase : RoomDatabase() {
    abstract fun pendingOperationDao(): PendingOperationDao

    companion object {
        @Volatile
        private var INSTANCE: PendingOperationDatabase? = null

        fun getInstance(context: Context): PendingOperationDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    PendingOperationDatabase::class.java,
                    "digital_notebook_pending_ops.db"
                ).build().also { INSTANCE = it }
            }
        }
    }
}
