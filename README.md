# WeBeep Sync - Resistance edition

Polimi ha sospeso le API moodle da cui WeBeep Sync (e Moodle Mobile) dipendeva, motivando la scelta in questo modo:

> *"L'utilizzo dei token è stato temporaneamente sospeso a seguito del riscontro di un uso non conforme ai termini di servizio. Stiamo attualmente analizzando la situazione prima di procedere con un'eventuale riabilitazione completa."*

I token sono stati sospesi per alcuni studenti, il criterio sconosciuto. L'app ha smesso di funzionare. Molti hanno lasciato perdere.

Questo fork no.

L'autenticazione è stata riscritta da zero. L'app usa direttamente la sessione web di Moodle, esattamente come fa il browser. Per trovare i file traversa i corsi e le cartelle come fa l'interfaccia web. È la soluzione più compatibile con il loro sistema. Funziona finché funziona il sito.

I termini di servizio di WeBeep ([consultabili qui](https://webeep.polimi.it/admin/tool/policy/viewall.php)) non contengono nulla che proibisca esplicitamente di accedere ai propri materiali didattici in modo automatizzato. WeBeep Sync non tocca dati altrui, non fa nulla che un browser non potrebbe fare a mano. Polimi ha sospeso i token per via di un abuso non meglio specificato e non ha dichiarato di essere contro questo progetto. (L'unica clausola vagamente applicabile vieta l'uso del sito *"al di fuori delle finalità di supporto alla didattica"*: scaricare i file dei propri corsi rientra esattamente in questa finalità. Esiste anche un divieto contro attività che danneggino o sovraccarichino il sito, decisamente non applicabile a un sync individuale, specialmente per come era implementato prima.)

---

## Cosa è cambiato tecnicamente

- **Autenticazione**: rimpiazzata l'API REST wstoken con sessione cookie + sesskey. Il login cattura `MoodleSession` e `sesskey` direttamente dalla pagina Moodle dopo il completamento dell'SSO. Le sessioni vengono salvate cifrate e rinnovate silenziosamente quando possibile.
- **Ricerca file nei corsi**: rimpiazzato `core_course_get_contents` (ajax:false, solo wstoken) con `core_courseformat_get_state` (ajax:true). I file singoli vengono risolti tramite redirect following con richieste HEAD; le cartelle tramite parsing della pagina e range request per ottenere dimensione (e data di modifica).
- **Lista corsi**: rimpiazzato `core_enrol_get_users_courses` (ajax:false, richiede userid) con `core_course_get_enrolled_courses_by_timeline_classification` (ajax:true, nessun userid necessario).
- **Nomi dei file**: i file risorsa vengono nominati con il nome visualizzato su Moodle + estensione derivata dal Content-Type, rispettando il comportamento originale dell'app.
- **Progresso UI**: le dimensioni sconosciute mostrano `??` e vengono risolte in tempo reale durante il download. La barra di progresso totale appare non appena la dimensione totale è nota.

---

## Note

Non conosco TypeScript, e non mi sembrava il caso di studiare un intero linguaggio per un progetto che si spera sia solo temporaneo. Il codice è stato scritto da [Claude Code](https://claude.ai/code), sotto la mia attenta direzione e su mie istruzioni. L'analisi del traffico di rete, della logica di moodle e webeep, la progettazione del nuovo flow di login e download e la stesura di questo README sono interamente miei. L'ai è solo uno strumento, non un creatore.

---

## Progetto originale

Questo è un fork di [toto04/webeep-sync](https://github.com/toto04/webeep-sync) di Tommaso Morganti. Il README originale, i link per il download e la documentazione completa si trovano lì. Se cerchi la release stabile o vuoi capire cosa fa l'app di base, trovi tutto lì.
