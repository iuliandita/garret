package cc.local.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Process
import android.system.Os
import android.system.OsConstants
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
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
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

@TauriPlugin
class TransferPlugin(private val activity: Activity) : Plugin(activity) {
    private class Reply(private val invoke: Invoke) {
        private val completed = AtomicBoolean(false)
        fun resolve(value: JSObject) { if (completed.compareAndSet(false, true)) invoke.resolve(value) }
        fun reject(code: String) { if (completed.compareAndSet(false, true)) invoke.reject(code, code) }
    }
    private class Slot(val operation: String, val kind: String, val mode: String, val picker: Reply) {
        val ticket = UUID.randomUUID().toString()
        val canceled = AtomicBoolean(false)
        val closing = AtomicBoolean(false)
        var phase = "picker"
        var uri: Uri? = null
        val streams = mutableListOf<Closeable>()
    }
    private val monitor = Any()
    private var slot: Slot? = null
    private var destroyed = false
    private val io = Executors.newSingleThreadExecutor()
    private val closer = Executors.newSingleThreadExecutor()
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
        // Keep the original reply pending until its callback or stream actually drains.
        // A blocked provider must not block the Activity thread or create unbounded cancellation threads.
        if (s.closing.compareAndSet(false, true) && closingStreams.compareAndSet(false, true)) closer.execute {
            try {
                val streams = synchronized(monitor) { s.streams.toList() }
                for (stream in streams) try { stream.close() } catch (_: Exception) { }
            } finally { closingStreams.set(false) }
        }
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
                check(!destroyed && slot == null && !closingStreams.get() && !activity.isFinishing)
                slot = next; admitted = next
            }
            val intent = Intent(if (mode == "open") Intent.ACTION_OPEN_DOCUMENT else Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(if (kind == "key") "text/plain" else "application/octet-stream")
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
            if (mode == "create") intent.putExtra(Intent.EXTRA_TITLE, name)
            startActivityForResult(invoke, intent, "picked")
        } catch (_: Exception) {
            synchronized(monitor) { if (admitted != null && slot === admitted) slot = null }
            reply.reject("saf_picker_unavailable")
        }
    }

    @ActivityCallback
    fun picked(invoke: Invoke, result: ActivityResult) {
        val s = synchronized(monitor) { slot } ?: return
        // The platform has one callback slot. Never replace a canceled picker until this result drains.
        if (s.phase != "picker") return
        try {
            val original = invoke.getArgs().getString("operation")
            if (original != s.operation) return
            if (result.resultCode == Activity.RESULT_CANCELED || s.canceled.get()) {
                s.picker.resolve(canceled(s))
                synchronized(monitor) { if (slot === s) slot = null }
                return
            }
            require(result.resultCode == Activity.RESULT_OK && result.data?.clipData == null)
            val uri = result.data?.data ?: throw IllegalArgumentException()
            require(uri.scheme == "content")
            synchronized(monitor) {
                check(!destroyed && !s.canceled.get() && slot === s)
                s.uri = uri; s.phase = "ready"
            }
            s.picker.resolve(JSObject().put("operation", s.operation).put("cancelled", false).put("ticket", s.ticket))
        } catch (_: Exception) {
            s.picker.reject("saf_picker_failed")
            synchronized(monitor) { if (slot === s) slot = null }
        }
    }

    private fun stage(stageId: String, kind: String, mode: String): File {
        uuid(stageId)
        val root = File(File(activity.applicationInfo.dataDir).canonicalFile, "transfer")
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
                require(n > 0 && n.toLong() <= limit - total)
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
        try {
            val expected = mutableSetOf("operation", "ticket", "stageId", "maxBytes")
            if (writing) expected.addAll(listOf("expectedBytes", "expectedSha256"))
            val args = fields(invoke, expected)
            val operation = uuid(args.getString("operation")); val ticket = uuid(args.getString("ticket"))
            val stageId = uuid(args.getString("stageId")); val limit = number(args, "maxBytes")
            val expectedBytes = if (writing) number(args, "expectedBytes") else 0L
            val expectedHash = if (writing) args.getString("expectedSha256") else ""
            val s = synchronized(monitor) {
                val current = slot ?: throw IllegalStateException()
                check(!destroyed && current.operation == operation && current.ticket == ticket && current.phase == "ready")
                check(!current.canceled.get() && current.mode == if (writing) "create" else "open")
                require(limit in 1..cap(current.kind))
                if (writing) require(expectedBytes in 0..limit && expectedHash.matches(Regex("[0-9a-f]{64}")))
                current.phase = "streaming"; admitted = current; current
            }
            io.execute {
                try {
                    val file = stage(stageId, s.kind, s.mode)
                    val uri = s.uri ?: throw IllegalStateException()
                    val resolver = activity.contentResolver
                    check(s)
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
                            tracked(s, resolver.openOutputStream(uri, "w") ?: throw IllegalStateException()).use { output ->
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
                        check(s); check(!destroyed && slot === s)
                        reply.resolve(receipt(s, stageId, digest, writing))
                    }
                } catch (_: Exception) {
                    reply.reject(if (writing) "saf_export_unverified" else "saf_import_unverified")
                } finally {
                    synchronized(monitor) { s.streams.clear(); s.uri = null; if (slot === s) slot = null }
                }
            }
        } catch (_: Exception) {
            synchronized(monitor) { if (admitted != null && slot === admitted) slot = null }
            reply.reject(if (writing) "saf_export_unverified" else "saf_read_refused")
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
                slot?.takeIf { it.operation == operation }?.let { s ->
                    stop(s)
                    if (s.phase == "ready") slot = null
                }
            }
            reply.resolve(JSObject().put("operation", operation))
        } catch (_: Exception) { reply.reject("saf_cancel_refused") }
    }
    override fun onDestroy(activity: AppCompatActivity) {
        synchronized(monitor) {
            destroyed = true
            slot?.let { s ->
                stop(s)
                if (s.phase == "picker") { s.picker.resolve(canceled(s)); slot = null }
            }
        }
        io.shutdown()
        closer.shutdown()
    }
}
