package com.opparamyeon.pos

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * `window.OppaBridge` for the POS website (see public/shared/printers.js and openSecondScreen() in public/pos/pos.js).
 * Calls arrive on a background thread; screen work is handed to the UI thread.
 */
class Bridge(private val a: MainActivity) {
    private fun <T> onUi(block: () -> T): T? {
        var out: T? = null
        val done = CountDownLatch(1)
        a.runOnUiThread { try { out = block() } finally { done.countDown() } }
        done.await(5, TimeUnit.SECONDS)
        return out
    }

    /** Customer display on the built-in second screen. Returns false when the device has no second screen. */
    @JavascriptInterface fun openCustomerDisplay(url: String): Boolean = onUi { a.showCustomer(url) } ?: false
    @JavascriptInterface fun closeCustomerDisplay() { onUi { a.closeCustomer() } }
    @JavascriptInterface fun hasSecondScreen(): Boolean = onUi { a.secondDisplay() != null } ?: false
    @JavascriptInterface fun customerDisplayOpen(): Boolean = onUi { a.hasCustomer() } ?: false
    @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME

    /** ESC/POS bytes to a LAN (port 9100) or Bluetooth printer: {conn, address, port, data(base64)} → {ok, error} */
    @SuppressLint("MissingPermission")
    @JavascriptInterface fun print(json: String): String {
        val out = JSONObject()
        try {
            val j = JSONObject(json)
            val data = Base64.decode(j.getString("data"), Base64.DEFAULT)
            when (j.optString("conn")) {
                "lan" -> Socket().use { s ->
                    s.connect(InetSocketAddress(j.getString("address"), j.optInt("port", 9100)), 5000)
                    s.getOutputStream().apply { write(data); flush() }
                }
                "bluetooth" -> {
                    val dev = BluetoothAdapter.getDefaultAdapter().getRemoteDevice(j.getString("address"))
                    dev.createRfcommSocketToServiceRecord(SPP).use { s -> s.connect(); s.outputStream.apply { write(data); flush() } }
                }
                else -> throw IllegalArgumentException("unsupported printer connection: " + j.optString("conn"))
            }
            out.put("ok", true)
        } catch (e: Exception) {
            out.put("ok", false).put("error", e.message ?: e.toString())
        }
        return out.toString()
    }

    companion object { private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB") }
}
