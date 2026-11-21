package com.nscgroup.compotest;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.widget.Toast;

/**
 * Pont JavaScript -> Android, exposé à la page sous le nom "Android".
 * Côté web : window.Android.downloadFile(url, filename)
 */
public class WebAppInterface {

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public WebAppInterface(Context context) {
        this.context = context.getApplicationContext();
    }

    @JavascriptInterface
    public void downloadFile(String url, String filename) {
        // Sécurité : seules les URL http(s) sont acceptées
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            toast("Fichier introuvable, contacte l'admin");
            return;
        }
        try {
            String name = sanitizeFileName(filename, url);

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(name);
            request.setDescription("Téléchargement Révisio");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);

            String mime = mimeFromName(name);
            if (mime != null) request.setMimeType(mime);

            // Dossier "Téléchargements" public (aucune permission requise à partir d'Android 10)
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);

            DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                toast("Téléchargement indisponible sur cet appareil");
                return;
            }
            dm.enqueue(request);
            toast("Téléchargement démarré : " + name);
        } catch (Exception e) {
            toast("Échec du téléchargement : " + e.getMessage());
        }
    }

    /** Nettoie le nom (pas de / \ : * ? " < > |) ; repli sur le nom déduit de l'URL. */
    private String sanitizeFileName(String filename, String url) {
        String name = (filename == null) ? "" : filename.replaceAll("[\\\\/:*?\"<>|]+", "_").trim();
        if (name.isEmpty()) name = URLUtil.guessFileName(url, null, null);
        if (name.length() > 100) {
            int dot = name.lastIndexOf('.');
            String ext = (dot > 0 && name.length() - dot <= 6) ? name.substring(dot) : "";
            name = name.substring(0, 100 - ext.length()) + ext;
        }
        return name;
    }

    private String mimeFromName(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) return null;
        String ext = name.substring(dot + 1).toLowerCase();
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
    }

    /** @JavascriptInterface s'exécute sur un thread de fond : le Toast doit passer par le thread principal. */
    private void toast(final String message) {
        mainHandler.post(new Runnable() {
            @Override public void run() { Toast.makeText(context, message, Toast.LENGTH_LONG).show(); }
        });
    }
}
