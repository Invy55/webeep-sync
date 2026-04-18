# Tecnicismi

Documento un po' veloce che spiega le modifiche tecniche di funzionamento apportate al progetto originale, per chi fosse interessato a capire come funziona.
---

## Login

Il login parte dallo Shibboleth di WeBeep:

```
https://webeep.polimi.it/auth/shibboleth/index.php
```

Da lì Polimi gestisce il flusso SSO (reindirizzamenti SAML, AunicaLogin, SPID/CIE, ecc.) esattamente come nel browser. Noi ascoltiamo l'evento `did-finish-load` (che fira ogni volta che una pagina finisce di caricare) e quando l'URL corrisponde alla dashboard di WeBeep (`.../my/`) consideriamo il login completato.

A quel punto vengono estratte due cose dalla pagina già caricata:

**MoodleSession** viene letto dai cookie di Electron:
```js
session.defaultSession.cookies.get({ name: "MoodleSession", domain: "webeep.polimi.it" })
```

**sesskey** viene letto dalla variabile globale `M.cfg` creata da Moodle nella pagina (se non ti fidi apri webeep in un browser, apri la console e digita `M.cfg` per vedere cosa contiene):
```js
webContents.executeJavaScript("JSON.stringify(M.cfg)")  // contiene sesskey e sessiontimeout
```
Questi sono salvati nel `safeStorage` invece del vecchio wstoken. Esempio (c'è anche il nome utente che adesso estraiamo dall'html della pagina `.../my/`, elemento `<span class="rui-fullname">NOME COGNOME</span>`): 

```json
{ "moodleSession": "...", "sesskey": "...", "expiresAt": 1714567890000, "username": "Mario Rossi" }
```

(`username` viene omesso dal JSON se non trovato nell'HTML.)

Al riavvio dell'app se la sessione salvata è scaduta viene tentato un **silent refresh**: nome fancy per dire che in una finestra nascosta facciamo lo stesso procedimento. Se i cookie SSO salvati nel browser sono ancora validi, il flusso SAML si completa da solo senza interazione utente e viene estratta una sessione WeBeep nuova. Se invece la navigazione si blocca su `aunicalogin.jsp`, i cookie SSO sono scaduti e viene aperta la finestra di login visibile.

Il `sesskey` è legato alla sessione e cambia a ogni login. Il `MoodleSession` è il cookie di autenticazione che va aggiunto a ogni richiesta HTTP a WeBeep.

---

## API Moodle

Tutte le chiamate API usano l'endpoint AJAX di Moodle che usa WeBeep:

```
POST https://webeep.polimi.it/lib/ajax/service.php?sesskey=<sesskey>
```

Il corpo è un array JSON con questa struttura:

```json
[{ "index": 0, "methodname": "nome_funzione", "args": { ... } }]
```

La risposta è anch'essa un array; si estrae `result[0].data`. Se `result[0].error` è presente, si controlla `errorcode`: se è `sessionexpired` o `invalidsesskey`, si tenta prima un silent refresh e poi si riprova la chiamata.

Il vecchio endpoint `/webservice/rest/server.php` con wstoken non viene più usato perché Polimi ha disabilitato il flusso di autenticazione dell'app mobile da cui dipendeva.

**Ottenere i corsi** usa `core_course_get_enrolled_courses_by_timeline_classification`:

```json
{ "classification": "all", "limit": 0, "offset": 0 }
```

Restituisce un array di corsi con `id` e `fullname`.

**Ottenere i file di un corso** usa `core_courseformat_get_state`:

```json
{ "courseid": 12345 }
```

Questa funzione restituisce il payload come stringa JSON, quindi va fatto un `JSON.parse` sul risultato. Il contenuto ha due array: `cm` (i moduli del corso) e `section` (le sezioni con i titoli). Ogni elemento di `cm` ha `modname`, `name`, `url`, `sectionid` e `uservisible`.

I moduli con `uservisible = false` o senza `url` vengono saltati. Per gli altri:

**resource / risorsa**: viene fatta una richiesta HEAD all'URL del modulo. Il redirect finale porta all'URL `pluginfile.php` del file. Da lì si leggono `Last-Modified` e `Content-Type` per ricavare data di modifica ed estensione. La dimensione non è disponibile via HEAD senza scaricare il file, quindi viene lasciata a 0 e recuperata in seguito durante il download.

**folder / cartella**: viene scaricata la pagina HTML del modulo con una GET. I link dei file sono estratti con questa regex:

```
/href="(https?:\/\/[^"]*pluginfile\.php[^"]*forcedownload=1[^"]*)"/g
```

Per ogni link trovato viene fatta una richiesta HEAD per leggere `Last-Modified` e ricavare la data di modifica. La dimensione viene lasciata a 0 e recuperata in modo lazy durante il download, come per le risorse.

Gli URL dei file dentro una cartella contengono il percorso relativo delle sottocartelle. Per esempio:

```
/pluginfile.php/1516135/mod_folder/content/0/Prima%20sessione/lab_FdA_script.m
```

La struttura è sempre `/pluginfile.php/{contextId}/{component}/{filearea}/{itemid}/{percorso relativo}`. I primi 5 segmenti sono fissi; tutto il resto è il percorso del file dentro la cartella, sottocartelle incluse. Questo viene usato per ricostruire la struttura di directory sul disco.

**Notifiche** usa `message_popup_get_popup_notifications`. Come effetto collaterale, `useridto` nella prima notifica viene salvato come ID utente (necessario per `markAllNotificationsAsRead`). L'alternativa vecchia era `core_webservice_get_site_info`, che non è disponibile via AJAX.

---

## Download

**Come viene ottenuta la dimensione dei file**

La dimensione non viene mai calcolata durante la scansione: per tutti i file (resource e cartelle) viene lasciata a 0 e recuperata in modo lazy.

1. **Durante il download** (filesize = 0): viene avviata una seconda GET in parallelo al download principale, con l'header `Range: bytes=0-0`. Questo è un meccanismo HTTP standard per richiedere solo una porzione del file: il server risponde con 206 Partial Content invece di 200, e include `Content-Range: bytes 0-0/12345` dove il numero dopo lo slash è la dimensione totale. La connessione viene chiusa subito dopo aver letto quell'header, senza scaricare niente di utile. Il risultato viene usato per aggiornare la barra di avanzamento in tempo reale.

2. **Dopo il download, se la dimensione è ancora 0**: si legge dal file appena scritto su disco con `fs.stat`.

Tutte le richieste a `pluginfile.php` richiedono il cookie `MoodleSession` nell'header. Il cookie viene riagganciato a ogni redirect con un hook `beforeRedirect`, perché `got` di default non propaga i cookie personalizzati tra redirect.
