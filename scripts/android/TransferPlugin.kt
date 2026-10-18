package com.usegarret.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.CancellationSignal
import android.os.Process
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.system.Os
import android.system.OsConstants
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

@TauriPlugin
class TransferPlugin(activity: Activity) : Plugin(activity) {
    companion object {
        private val monitor = Any()
        private val lifecycle = TransferLifecycle<AppCompatActivity>()
        private var launcher: ActivityResultLauncher<Intent>? = null
        private var pendingResult: ((ActivityResult) -> Unit)? = null

        fun attachActivity(activity: AppCompatActivity, picker: ActivityResultLauncher<Intent>) {
            synchronized(monitor) {
                lifecycle.attach(activity)
                launcher = picker
            }
        }
        fun pickerResult(result: ActivityResult) {
            val callback = synchronized(monitor) { pendingResult.also { pendingResult = null } }
            callback?.invoke(result)
        }
    }
    private val context = activity.applicationContext
    private class Reply(private val invoke: Invoke) {
        private val completed = AtomicBoolean(false)
        fun resolve(value: JSObject) { if (completed.compareAndSet(false, true)) invoke.resolve(value) }
        fun reject(code: String) { if (completed.compareAndSet(false, true)) invoke.reject(code, code) }
    }
    private class Slot(val operation: String, val kind: String, val mode: String, val picker: Reply) {
        val ticket = UUID.randomUUID().toString()
        val canceled = AtomicBoolean(false)
        val closing = AtomicBoolean(false)
        val closeDrained = CountDownLatch(1)
        var phase = "picker"
        var streamReply: Reply? = null
        var uri: Uri? = null
        val streams = mutableListOf<Closeable>()
    }
    private var slot: Slot? = null
    private val canceledOperations = linkedSetOf<String>()
    private val interruptedOperations = linkedSetOf<String>()
    private val io = Executors.newSingleThreadExecutor()
    private val closer = Executors.newSingleThreadExecutor()
    private val watchdog = Executors.newSingleThreadScheduledExecutor()
    private val closingStreams = AtomicBoolean(false)

    private fun fields(invoke: Invoke, expected: Set<String>): JSONObject {
        val args = invoke.getArgs()
        require(args.keys().asSequence().toSet() == expected)
        return args
    }
    private fun uuid(value: String): String {
        require(UUID.fromString(value).toString() == value)
        return value
    }
    private fun cap(kind: String): Long = when (kind) {
        "key" -> 512L
        "archive" -> 1024L * 1024L * 1024L
        else -> throw IllegalArgumentException()
    }
    private fun number(args: JSONObject, key: String): Long {
        val value = args.get(key)
        require(value is Int || value is Long)
        return (value as Number).toLong()
    }
    private fun canceled(s: Slot): JSObject = JSObject().put("operation", s.operation).put("cancelled", true)
    private fun stop(s: Slot) {
        s.canceled.set(true)
        if (s.phase != "streaming") return
        if (s.closing.compareAndSet(false, true)) {
            closingStreams.set(true)
            watchdog.schedule({
                synchronized(monitor) {
                    if (slot === s && (s.phase == "streaming" || s.phase == "draining")) {
                        lifecycle.requireRestart()
                        s.streamReply?.reject("transfer_restart")
                    }
                }
            }, 15, TimeUnit.SECONDS)
            closer.execute {
                try {
                    val streams = synchronized(monitor) { s.streams.toList() }
                    for (stream in streams) try { stream.close() } catch (_: Exception) { }
                } finally {
                    closingStreams.set(false)
                    s.closeDrained.countDown()
                }
            }
        }
    }
    private fun deleteCreated(mode: String, uri: Uri?) {
        if (mode != "create" || uri == null) return
        try {
            closer.execute { try { DocumentsContract.deleteDocument(context.contentResolver, uri) } catch (_: Exception) { } }
        } catch (_: Exception) { }
    }
    private fun check(s: Slot) { check(!s.canceled.get()) }
    private fun <T : Closeable> tracked(s: Slot, stream: T): T {
        val admitted = synchronized(monitor) {
            if (s.canceled.get()) false else { s.streams.add(stream); true }
        }
        if (!admitted) { stream.close(); throw IllegalStateException() }
        return stream
    }

    @Command
    fun pick(invoke: Invoke) {
        val reply = Reply(invoke)
        var admitted: Slot? = null
        try {
            val args = fields(invoke, setOf("operation", "kind", "mode", "displayName"))
            val operation = uuid(args.getString("operation"))
            val kind = args.getString("kind"); cap(kind)
            val mode = args.getString("mode"); require(mode == "open" || mode == "create")
            val name = args.getString("displayName")
            require(name.length in 1..120 && name.none { it.isISOControl() || it == '/' || it == '\\' })
            val next = Slot(operation, kind, mode, reply)
            synchronized(monitor) {
                check(lifecycle.admissionCode() == null && slot == null && !closingStreams.get() && operation !in canceledOperations)
                check(lifecycle.owner?.let { !it.isFinishing && !it.isDestroyed } == true)
                slot = next; admitted = next
            }
            val intent = Intent(if (mode == "open") Intent.ACTION_OPEN_DOCUMENT else Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(if (mode == "open") "*/*" else if (kind == "key") "text/plain" else "application/octet-stream")
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
            if (mode == "create") intent.putExtra(Intent.EXTRA_TITLE, name)
            synchronized(monitor) {
                pendingResult = { result -> picked(next, result) }
                try {
                    checkNotNull(launcher).launch(intent)
                } catch (error: Exception) {
                    pendingResult = null
                    throw error
                }
            }
        } catch (_: Exception) {
            synchronized(monitor) { if (admitted != null && slot === admitted) slot = null }
            reply.reject(lifecycle.admissionCode() ?: "saf_picker_unavailable")
        }
    }

    private fun picked(s: Slot, result: ActivityResult) {
        // The platform has one callback slot. Never replace a canceled picker until this result drains.
        if (s.phase != "picker") return
        try {
            if (synchronized(monitor) { slot !== s }) {
                if (result.resultCode == Activity.RESULT_OK) deleteCreated(s.mode, result.data?.data)
                return
            }
            if (result.resultCode == Activity.RESULT_CANCELED || s.canceled.get()) {
                synchronized(monitor) { if (slot === s) slot = null }
                if (result.resultCode == Activity.RESULT_OK) deleteCreated(s.mode, result.data?.data)
                if (synchronized(monitor) { s.operation in interruptedOperations }) s.picker.reject("transfer_lifecycle")
                else s.picker.resolve(canceled(s))
                return
            }
            require(result.resultCode == Activity.RESULT_OK && result.data?.clipData == null)
            val uri = result.data?.data ?: throw IllegalArgumentException()
            require(uri.scheme == "content")
            synchronized(monitor) {
                check(!lifecycle.restartRequired && !s.canceled.get() && slot === s)
                s.uri = uri; s.phase = "ready"
            }
            s.picker.resolve(JSObject().put("operation", s.operation).put("cancelled", false).put("ticket", s.ticket))
        } catch (_: Exception) {
            synchronized(monitor) { if (slot === s) slot = null }
            if (result.resultCode == Activity.RESULT_OK) deleteCreated(s.mode, result.data?.data)
            s.picker.reject("saf_picker_failed")
        }
    }

    private fun stage(stageId: String, kind: String, mode: String): File {
        uuid(stageId)
        val root = File(File(context.applicationInfo.dataDir).canonicalFile, "transfer")
        val dir = File(root, stageId)
        for (folder in listOf(root, dir)) {
            val meta = Os.lstat(folder.path)
            require(OsConstants.S_ISDIR(meta.st_mode) && meta.st_uid == Process.myUid())
            require((meta.st_mode and 63) == 0 && folder.canonicalFile == folder.absoluteFile)
        }
        return File(dir, "$kind.${if (mode == "open") "in" else "out"}")
    }
    private fun privateInput(file: File): FileInputStream {
        val fd = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
        try {
            val meta = Os.fstat(fd)
            require(OsConstants.S_ISREG(meta.st_mode) && meta.st_uid == Process.myUid() && (meta.st_mode and 63) == 0)
            return FileInputStream(fd)
        } catch (error: Exception) { Os.close(fd); throw error }
    }
    private fun privateOutput(file: File): FileOutputStream {
        val fd = Os.open(file.path, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW, 384)
        return FileOutputStream(fd)
    }
    private class TransferTooLarge : Exception()
    private data class Digest(val bytes: Long, val sha256: String)
    private fun copy(s: Slot, input: InputStream, output: OutputStream?, limit: Long): Digest {
        val hash = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        try {
            while (true) {
                check(s)
                val n = input.read(buffer, 0, minOf(buffer.size.toLong(), limit - total + 1).toInt())
                if (n == -1) break
                if (n.toLong() > limit - total) throw TransferTooLarge()
                require(n > 0)
                output?.write(buffer, 0, n)
                hash.update(buffer, 0, n); total += n
            }
            check(s)
            return Digest(total, hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) })
        } finally { buffer.fill(0) }
    }
    private fun receipt(s: Slot, stageId: String, digest: Digest, verified: Boolean): JSObject =
        JSObject().put("operation", s.operation).put("stageId", stageId).put("bytes", digest.bytes)
            .put("sha256", digest.sha256).put("verified", verified)

    private fun transfer(invoke: Invoke, writing: Boolean) {
        val reply = Reply(invoke)
        var admitted: Slot? = null
        var operation: String? = null
        try {
            val expected = mutableSetOf("operation", "ticket", "stageId", "maxBytes")
            if (writing) expected.addAll(listOf("expectedBytes", "expectedSha256"))
            val args = fields(invoke, expected)
            val operationId = uuid(args.getString("operation")); operation = operationId
            val ticket = uuid(args.getString("ticket"))
            val stageId = uuid(args.getString("stageId")); val limit = number(args, "maxBytes")
            val expectedBytes = if (writing) number(args, "expectedBytes") else 0L
            val expectedHash = if (writing) args.getString("expectedSha256") else ""
            val s = synchronized(monitor) {
                val current = slot ?: throw IllegalStateException()
                check(!lifecycle.restartRequired && current.operation == operationId && current.ticket == ticket && current.phase == "ready")
                check(!current.canceled.get() && current.mode == if (writing) "create" else "open")
                require(limit in 1..cap(current.kind))
                if (writing) require(expectedBytes in 0..limit && expectedHash.matches(Regex("[0-9a-f]{64}")))
                current.phase = "streaming"; current.streamReply = reply; admitted = current; current
            }
            io.execute {
                var result: JSObject? = null
                var writeBegan = false
                var failure = if (writing) "saf_export_unverified" else "saf_import_unverified"
                try {
                    val file = stage(stageId, s.kind, s.mode)
                    val uri = s.uri ?: throw IllegalStateException()
                    val resolver = context.contentResolver
                    check(s)
                    var displayName: String? = null
                    if (!writing && s.kind == "archive") {
                        // Keep optional provider metadata under the stream cancellation watchdog.
                        val signal = CancellationSignal()
                        try {
                            tracked(s, Closeable { signal.cancel() }).use {
                                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null, signal)?.let { cursor ->
                                    tracked(s, cursor).use {
                                        if (cursor.moveToFirst()) displayName = cursor.getString(0)
                                            ?.filter { !it.isISOControl() && it != '/' && it != '\\' }?.take(120)
                                    }
                                }
                            }
                        } catch (_: Exception) { }
                        check(s)
                    }
                    val digest = if (!writing) {
                        tracked(s, privateOutput(file)).use { output ->
                            val read = tracked(s, resolver.openInputStream(uri) ?: throw IllegalStateException()).use { input ->
                                copy(s, input, output, limit)
                            }
                            output.fd.sync()
                            read
                        }
                    } else {
                        tracked(s, privateInput(file)).use { input ->
                            val before = copy(s, input, null, expectedBytes)
                            require(before.bytes == expectedBytes && before.sha256 == expectedHash)
                            input.channel.position(0)
                            check(s)
                            writeBegan = true
                            tracked(s, resolver.openOutputStream(uri, "wt") ?: throw IllegalStateException()).use { output ->
                                val sent = copy(s, input, output, expectedBytes)
                                require(sent.bytes == expectedBytes && sent.sha256 == expectedHash)
                            }
                        }
                        // use closes the writer before this independent provider readback.
                        tracked(s, resolver.openInputStream(uri) ?: throw IllegalStateException()).use { input ->
                            copy(s, input, null, expectedBytes)
                        }.also { require(it.bytes == expectedBytes && it.sha256 == expectedHash) }
                    }
                    synchronized(monitor) {
                        check(s); check(!lifecycle.restartRequired && slot === s)
                        result = receipt(s, stageId, digest, writing)
                        displayName?.let { result?.put("displayName", it) }
                    }
                } catch (error: Exception) {
                    result = null
                    if (writing && !writeBegan) failure = "transfer_not_started"
                    if (!writing && error is TransferTooLarge) {
                        failure = if (s.kind == "key") "transfer_key" else "transfer_too_large"
                    }
                    var cause: Throwable? = error
                    while (cause != null) {
                        if (cause is android.system.ErrnoException && cause.errno == OsConstants.ENOSPC) failure = "transfer_storage"
                        cause = cause.cause
                    }
                } finally {
                    // The original reply is the admission boundary, including a cancellation closer.
                    synchronized(monitor) { s.phase = "draining" }
                    val drained = !s.closing.get() || try { s.closeDrained.await(15, TimeUnit.SECONDS) } catch (_: InterruptedException) { false }
                    synchronized(monitor) {
                        if (!drained) { lifecycle.requireRestart(); failure = "transfer_restart"; result = null }
                        else if (s.operation in interruptedOperations) failure = "transfer_lifecycle"
                        if (s.canceled.get() || lifecycle.restartRequired) result = null
                        if (result == null) deleteCreated(s.mode, s.uri)
                        if (drained) {
                            s.streams.clear(); s.uri = null
                            if (slot === s) slot = null
                        }
                    }
                }
                val completed = result
                if (completed != null) reply.resolve(completed)
                else reply.reject(failure)
            }
        } catch (_: Exception) {
            synchronized(monitor) { if (admitted != null && slot === admitted) slot = null }
            val code = synchronized(monitor) {
                if (lifecycle.restartRequired) "transfer_restart"
                else if (operation in interruptedOperations) "transfer_lifecycle"
                else if (writing) "transfer_not_started" else "saf_read_refused"
            }
            reply.reject(code)
        }
    }
    @Command fun readPicked(invoke: Invoke) = transfer(invoke, false)
    @Command fun writeVerified(invoke: Invoke) = transfer(invoke, true)

    @Command
    fun cancel(invoke: Invoke) {
        val reply = Reply(invoke)
        try {
            val operation = uuid(fields(invoke, setOf("operation")).getString("operation"))
            synchronized(monitor) {
                // A cancellation may reach native code just before its picker call.
                canceledOperations.add(operation)
                if (canceledOperations.size > 128) canceledOperations.remove(canceledOperations.first())
                slot?.takeIf { it.operation == operation }?.let { s ->
                    stop(s)
                    if (s.phase == "ready") { deleteCreated(s.mode, s.uri); slot = null }
                }
            }
            reply.resolve(JSObject().put("operation", operation))
        } catch (_: Exception) { reply.reject("saf_cancel_refused") }
    }
    override fun onDestroy(activity: AppCompatActivity) {
        synchronized(monitor) {
            if (!lifecycle.detach(activity)) return
            launcher = null
            slot?.let { s ->
                interruptedOperations.add(s.operation)
                if (interruptedOperations.size > 128) interruptedOperations.remove(interruptedOperations.first())
                stop(s)
                if (s.phase == "ready") {
                    deleteCreated(s.mode, s.uri)
                    slot = null
                }
                // Keep picker/stream admission until its original callback or I/O drains.
            }
        }
        // The native bridge survives activity recreation; its executors do too.
    }
}
