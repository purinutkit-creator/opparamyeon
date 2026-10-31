package com.opparamyeon.pos

import android.app.Presentation
import android.os.Bundle
import android.view.Display
import android.view.WindowManager
import android.webkit.WebView

/** The customer display page on the second screen (its own WebView, so it never mirrors the cashier's screen). */
class CustomerPresentation(private val host: MainActivity, display: Display, private val url: String) : Presentation(host, display) {
    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        web = WebView(context)
        host.setupWebView(web)
        setContentView(web)
        web.loadUrl(url)
    }

    override fun onStop() { web.destroy(); super.onStop() }
}
