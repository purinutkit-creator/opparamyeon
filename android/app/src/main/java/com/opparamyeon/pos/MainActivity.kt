package com.opparamyeon.pos

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * The POS website in a full-screen WebView. The page talks to the device through `window.OppaBridge`:
 * the customer display goes on the built-in second screen (iMin / Sunmi / any Android with a presentation display)
 * instead of the second screen mirroring the cashier's screen.
 */
class MainActivity : AppCompatActivity() {
    lateinit var web: WebView
    private var customer: CustomerPresentation? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null
    private val ui = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        web = WebView(this)
        setContentView(web)
        setupWebView(web)
        web.addJavascriptInterface(Bridge(this), "OppaBridge")
        web.webChromeClient = object : WebChromeClient() {
            // camera for the clock-in selfie and the barcode scanner
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) request.grant(request.resources)
                    else { pendingPermission = request; requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA) }
                }
            }
            // <input type=file> (staff photos, product pictures)
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try { startActivityForResult(params.createIntent(), REQ_FILE); true } catch (e: Exception) { fileCallback = null; false }
            }
        }
        val start = intent?.dataString ?: getPreferences(Context.MODE_PRIVATE).getString("url", null) ?: BuildConfig.POS_URL
        web.loadUrl(start)
        hideSystemBars()
        // the second screen can be plugged in / come up after the app started
        val displays = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        displays.registerDisplayListener(object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(id: Int) { reopenCustomer() }
            override fun onDisplayRemoved(id: Int) { if (customer?.display?.displayId == id) { customer?.dismiss(); customer = null } }
            override fun onDisplayChanged(id: Int) {}
        }, ui)
    }

    fun setupWebView(w: WebView) {
        val s = w.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        s.userAgentString = s.userAgentString + " OppaPOSApp/1"
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                if (view === web && url.startsWith("http")) getPreferences(Context.MODE_PRIVATE).edit().putString("url", url).apply()
            }
        }
    }

    /** The built-in customer screen (a "presentation" display), if the device has one. */
    fun secondDisplay(): Display? {
        val dm = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        return dm.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION).firstOrNull()
            ?: dm.displays.firstOrNull { it.displayId != Display.DEFAULT_DISPLAY }
    }

    fun showCustomer(url: String): Boolean {
        val d = secondDisplay() ?: return false
        getPreferences(Context.MODE_PRIVATE).edit().putString("customer_url", url).apply()
        customer?.dismiss()
        customer = CustomerPresentation(this, d, url).also {
            try { it.show() } catch (e: WindowManager.InvalidDisplayException) { customer = null; return false }
        }
        return true
    }

    fun closeCustomer() { customer?.dismiss(); customer = null; getPreferences(Context.MODE_PRIVATE).edit().remove("customer_url").apply() }
    fun hasCustomer(): Boolean = customer != null
    private fun reopenCustomer() { if (customer == null) getPreferences(Context.MODE_PRIVATE).getString("customer_url", null)?.let { showCustomer(it) } }

    override fun onResume() { super.onResume(); hideSystemBars(); reopenCustomer() }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CAMERA) {
            val p = pendingPermission; pendingPermission = null
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) p?.grant(p.resources) else p?.deny()
        }
    }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    override fun onDestroy() { customer?.dismiss(); super.onDestroy() }

    companion object { const val REQ_FILE = 11; const val REQ_CAMERA = 12 }
}
