package com.nscgroup.compotest;

import android.annotation.SuppressLint;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatActivity;

/**
 * EXEMPLE pour une WebView native (sans Capacitor/Cordova).
 * Reprends seulement les lignes marquées "Révisio" dans TA MainActivity existante.
 * Remplace R.id.webview et l'URL par les tiens.
 */
public class MainActivity extends AppCompatActivity {

    private WebView webView;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webview);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Révisio : permet à la page de se reconnaître comme "application" (bannière APK masquée, etc.)
        settings.setUserAgentString(settings.getUserAgentString() + " RevisioAndroid");

        // Révisio : pont JavaScript -> Android (window.Android.downloadFile)
        webView.addJavascriptInterface(new WebAppInterface(this), "Android");

        // Révisio (optionnel) : les téléchargements "classiques" (<a download>, Content-Disposition) passent aussi par DownloadManager
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) ->
                new WebAppInterface(this).downloadFile(url,
                        android.webkit.URLUtil.guessFileName(url, contentDisposition, mimetype)));

        webView.loadUrl("https://compotestsaas.onrender.com/");   // ← ton URL
    }
}
