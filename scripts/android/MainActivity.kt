package cc.local.app

import android.os.Bundle
import android.content.res.Configuration
import android.graphics.Color
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
    private var writingView: WebView? = null
    private val appearance by lazy { getSharedPreferences("appearance", MODE_PRIVATE) }

    private fun applyAppearance() {
        val dark = when (appearance.getString("theme", "system")) {
            "dark" -> true
            "light" -> false
            else -> resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        }
        val background = Color.parseColor(if (dark) "#17171a" else "#fbfaf8")
        window.decorView.setBackgroundColor(background)
        findViewById<View>(android.R.id.content)?.setBackgroundColor(background)
        window.statusBarColor = background
        window.navigationBarColor = background
        val bars = WindowCompat.getInsetsController(window, window.decorView)
        bars.isAppearanceLightStatusBars = !dark
        bars.isAppearanceLightNavigationBars = !dark
    }

    private inner class AppearanceBridge {
        @JavascriptInterface fun current(): String = appearance.getString("theme", "system") ?: "system"

        @JavascriptInterface fun set(value: String) {
            if (value != "light" && value != "dark") return
            appearance.edit().putString("theme", value).apply()
            runOnUiThread { applyAppearance() }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        applyAppearance()
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
        webView.addJavascriptInterface(AppearanceBridge(), "garretAppearance")
    }

    override fun onResume() {
        super.onResume()
        applyAppearance()
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
