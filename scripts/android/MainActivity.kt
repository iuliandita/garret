package cc.local.app

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
    private var writingView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val occupied = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime()
            )
            view.setPadding(occupied.left, occupied.top, occupied.right, occupied.bottom)
            WindowInsetsCompat.CONSUMED
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = writingView
                if (view == null) {
                    moveTaskToBack(true)
                    return
                }
                view.evaluateJavascript("window.__mobileWriting === true") { writing ->
                    if (writing == "true") {
                        view.evaluateJavascript("window.dispatchEvent(new Event('mobile-back'))", null)
                    } else {
                        moveTaskToBack(true)
                    }
                }
            }
        })
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        writingView = webView
    }

    override fun onPause() {
        // A courtesy drain, never a promise that Android delays process death.
        writingView?.evaluateJavascript("window.dispatchEvent(new Event('mobile-background'))", null)
        super.onPause()
    }

    override fun onDestroy() {
        writingView = null
        super.onDestroy()
    }
}
