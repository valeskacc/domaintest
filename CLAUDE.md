# Projektregeln

Notizen für die Arbeit an diesem Repository. Sie halten vor allem die Fallen fest,
in die wir schon einmal getappt sind — bitte vor Änderungen kurz querlesen.

## Was hier liegt

Vier eigenständige Cloudflare-Worker-Apps mit gemeinsamem Supabase-Backend:

| Ordner   | Adresse             | Zweck                                  |
|----------|---------------------|----------------------------------------|
| `home/`  | home.valeska.cc     | Startseite / Kachel-Übersicht          |
| `travel/`| travel.valeska.cc   | Pack-Assistent für Reisen              |
| `todo/`  | todo.valeska.cc     | To-Do- und Einkaufslisten              |
| `kauf/`  | kauf.valeska.cc     | „Kauf → 2 raus"                        |

Jede App besteht nur aus `public/index.html`, `public/app.js` und `public/sw.js`.
Kein Build-Schritt: Preact/htm/supabase-js kommen zur Laufzeit von esm.sh, das JS
läuft so im Browser, wie es im Repo steht. Also `node --check <datei>` vor jedem
Commit — mehr Prüfung gibt es nicht.

Supabase-Projekt: `qcsezegptoblkpvwhtzx` („packassistent"), Region eu-west-1.
Edge Functions: `session-broker` (App-übergreifende Anmeldung) und
`categorize-item` (KI-Kategorisierung für die Einkaufsliste; braucht das Secret
`ANTHROPIC_API_KEY`, das nur die Projekt-Inhaberin im Dashboard setzen kann).

## Ausliefern

Push auf den Arbeitsbranch löst pro geänderter App einen GitHub-Actions-Workflow
aus (`.github/workflows/deploy-<app>.yml`). Danach den Erfolg tatsächlich prüfen,
nicht annehmen. Die Angabe auf Lauf-Ebene hinkt regelmäßig 20–60 Sekunden hinterher;
die Job-Ebene (`list_workflow_jobs`) ist verlässlicher und schneller.

Nach dem Deploy: Auf dem iPhone reicht ein Neuladen oft nicht, weil ein Service
Worker die App-Hülle bedient. Dann App wirklich schließen und neu öffnen.

## Supabase

**Neue Tabellen brauchen ab dem 30. Oktober 2026 ausdrückliche Rechte.** Supabase
vergibt sie nicht mehr automatisch; ohne sie ist die Tabelle für die Apps
unerreichbar. Immer in dieselbe Migration schreiben, die die Tabelle anlegt:

```sql
grant select                         on public.<tabelle> to anon;
grant select, insert, update, delete on public.<tabelle> to authenticated;
grant select, insert, update, delete on public.<tabelle> to service_role;
```

Das ersetzt keine Zugriffsregeln: Row Level Security ist auf allen Tabellen aktiv
und bleibt das, was Daten zwischen Nutzern trennt.

**Änderungen am Katalog wirken nicht rückwirkend.** `trip_items` speichert `name`
und `category_id` als eigene Kopie. Wer einen Katalog-Eintrag umbenennt oder
umsortiert, muss die bestehenden `trip_items`-Zeilen mitziehen — sonst ändert sich
nur für künftige Reisen etwas. Dasselbe gilt für `pack_signals.category_id` bei
Positionen, die es gar nicht im Katalog gibt (die erben ihre Kategorie vom Signal).

## Travel: wie die Packliste entsteht

`generateList()` sammelt Merkmale der Reise (Anlass, Transport, Unterkunft,
Aktivitäten) als Tags ein und nimmt jede Katalog-Position auf, die **mindestens
einen** dieser Tags trägt.

Daraus folgt: **Eine UND-Bedingung lässt sich mit Tags nicht ausdrücken.** „Nur
beim Wandern MIT Übernachtung draußen" oder „nur bei Strandreisen über 5 Tage"
gehört als ausdrückliche Regel mit `ensure()` in `generateList()`, nicht in die
Tags. Ein zu breiter Tag ist die häufigste Ursache für Positionen, die überall
auftauchen.

**Gelerntes sticht Katalog-Regeln.** `applyLearning()` ergänzt Positionen ab einem
Punktestand von 3 (selbst hinzugefügt = 2, vermisst = 3, genutzt = 1) und umgeht
dabei die Tags komplett. Wer also eine Position einschränkt, sie aber vorher schon
einmal selbst hinzugefügt und als genutzt markiert hat, bekommt sie trotzdem
wieder — in dem Fall zusätzlich die widersprechenden `pack_signals` aufräumen.
Diese Falle hat uns schon zweimal erwischt (Kopfhörer Jabra, Dr. Bronner Seife).

Signale zählen nur, wenn **alle** ihre Tags auch auf die aktuelle Reise zutreffen.
Das ist Absicht: Vorher schwappten Lehren aus einer sehr speziellen Reise auf jede
andere über, die ein einziges Merkmal teilte.

## Umgang mit fremdem Text

Nutzertexte (Aufgabentitel, Artikelnamen) niemals über `innerHTML` einsetzen,
sondern aus echten Elementen zusammenbauen — siehe `linkify()` in `todo`. Listen
lassen sich per Link teilen, fremde Leute können also Text beisteuern.

## Sprache

Oberfläche, Code-Kommentare und Commit-Nachrichten auf Deutsch. Kommentare
erklären das *Warum* (welcher Fall ging schief), nicht das Offensichtliche.
