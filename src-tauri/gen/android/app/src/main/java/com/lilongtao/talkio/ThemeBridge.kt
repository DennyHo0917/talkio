package com.lilongtao.talkio

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.view.View
import android.view.Window
import android.view.WindowInsetsController
import android.webkit.JavascriptInterface

/** Applies the web theme to Android system-bar colors and icon appearance. */
class ThemeBridge(private val activity: Activity) {
  @JavascriptInterface
  fun setSystemBars(dark: Boolean) {
    activity.runOnUiThread {
      val window = activity.window
      val barColor = if (dark) Color.BLACK else Color.WHITE
      window.statusBarColor = barColor
      window.navigationBarColor = barColor
      if (Build.VERSION.SDK_INT >= 29) {
        window.isNavigationBarContrastEnforced = false
      }

      if (Build.VERSION.SDK_INT >= 30) {
        val lightBars = if (dark) 0 else (
          WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
            WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
          )
        val lightBarsMask =
          WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
            WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(lightBars, lightBarsMask)
      } else {
        var flags = window.decorView.systemUiVisibility
        flags = flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
        if (Build.VERSION.SDK_INT >= 26) {
          flags = flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
        }
        if (!dark) {
          flags = flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
          if (Build.VERSION.SDK_INT >= 26) {
            flags = flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
          }
        }
        window.decorView.systemUiVisibility = flags
      }
    }
  }
}
