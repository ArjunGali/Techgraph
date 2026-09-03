# PG Management release build.
#
# The app is a Capacitor WebView shell: the business logic lives in the web
# bundle and the API, so there is very little Java to obfuscate. What must
# survive shrinking is anything the bridge reaches by reflection — plugin
# classes, their annotated methods, and the JavaScript interface.

-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public <methods>;
}

# Anything exposed to the WebView through addJavascriptInterface.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-keep class com.pgmanagement.app.** { *; }

# Cordova plugins bridged through Capacitor.
-keep class org.apache.cordova.** { *; }

# Keep line numbers so a crash report from a signed build is still readable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
