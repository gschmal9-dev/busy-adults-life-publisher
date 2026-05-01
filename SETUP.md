# Setup-Anleitung — 15 Minuten

## **Schritt 1: GitHub Repo erstellen** (2 Min)

1. Geh zu [github.com/new](https://github.com/new)
2. **Repository name:** `busy-adults-life-publisher`
3. **Visibility:** ✅ **Private** (wichtig — Token landen sonst öffentlich)
4. ❌ NICHT "Add a README file" anklicken (haben wir schon)
5. ❌ NICHT ".gitignore" oder "license" hinzufügen
6. Klick **"Create repository"**

Du landest auf der Repo-Seite mit ein paar Git-Befehlen. Ignorier die — wir machen's anders.

---

## **Schritt 2: Repo lokal pushen** (3 Min)

Öffne PowerShell **als normaler User** (nicht admin) und führ aus:

```powershell
cd "C:\Users\gschm\Desktop\claude\busy-adults-life-publisher"
git init -b main
git add .
git commit -m "Initial commit: cloud publisher with 10 shorts + workflow"
git remote add origin https://github.com/gschmal9-dev/busy-adults-life-publisher.git
git push -u origin main
```

Der Push dauert 2-5 Min wegen der ~345MB MP4s. Bei Fehlern siehe **Troubleshooting** unten.

---

## **Schritt 3: 3 Secrets hinzufügen** (3 Min)

Geh im Browser zu:
**`https://github.com/gschmal9-dev/busy-adults-life-publisher/settings/secrets/actions`**

Klick **"New repository secret"** und lege diese 3 an:

### **Secret 1: META_ACCESS_TOKEN**
Name: `META_ACCESS_TOKEN`
Wert: (aus deiner `.env` von "Busy adults life" — die lange Zeile nach `META_ACCESS_TOKEN=`)

### **Secret 2: IG_USER_ID**
Name: `IG_USER_ID`
Wert: `17841480639457014`

### **Secret 3: ANTHROPIC_API_KEY**
Name: `ANTHROPIC_API_KEY`
Wert: (aus deiner `.env` — die Zeile nach `ANTHROPIC_API_KEY=`)

---

## **Schritt 4: Test-Run** (2 Min)

1. Geh zu **`https://github.com/gschmal9-dev/busy-adults-life-publisher/actions`**
2. Links sehen "Daily Instagram Publisher" → klicken
3. Rechts: **"Run workflow"** Button (grau-grün)
4. Setze **dry_run = true** (nur Test, ohne wirklich zu posten)
5. Klick **"Run workflow"**
6. Warte ~30 Sek → klick auf den neuen Run, schau die Logs
7. Sollte zeigen: Caption generiert + Upload zu tmpfiles.org erfolgreich

Wenn das funktioniert → ✅ alles startklar.

---

## **Schritt 5: Lokale Windows-Tasks deaktivieren** (1 Min)

Damit nicht doppelt gepostet wird, lokale Tasks ausschalten:

```powershell
schtasks /Change /TN "BusyAdultsLife Catchup 4" /Disable
schtasks /Change /TN "BusyAdultsLife Catchup 5" /Disable
schtasks /Change /TN "BusyAdultsLife Catchup 6" /Disable
schtasks /Change /TN "BusyAdultsLife Catchup 7" /Disable
schtasks /Change /TN "BusyAdultsLife Catchup 8" /Disable
schtasks /Change /TN "BusyAdultsLife Catchup 9" /Disable
schtasks /Change /TN "BusyAdultsLife Catchup 10" /Disable
```

(Die Daily-Task ist schon deaktiviert.)

---

## **Schritt 6: Echten Catch-up starten** (1 Min)

Ab jetzt postet GitHub Actions automatisch täglich 09:00 + 15:00 (CEST).

Wenn du den Backlog **schneller** posten willst:
- Geh zu **Actions → Daily Instagram Publisher → Run workflow**
- Setze **force = true** (bypass 5h dedup)
- Klick **"Run workflow"**
- Postet sofort den nächsten Reel

So kannst du z.B. alle 3-4h einen anstoßen bis Backlog leer ist.

---

## **Token-Refresh (alle 60 Tage)**

Dein Meta-Token läuft am **2026-06-25** ab. Vorher:

```powershell
cd "C:\Users\gschm\Desktop\claude\Busy adults life"
node extend-meta-token.js
```

→ Neuer 60-Tage-Token wird in lokaler `.env` gespeichert.
Dann Secret in GitHub aktualisieren:
**Settings → Secrets → META_ACCESS_TOKEN → Update**

---

## **Troubleshooting**

### Push hängt / dauert ewig
Bei 345MB ist 2-5 Min normal. Bei Fehler "file too large":
- Einzelne MP4s sind alle < 65MB → unter 100MB Limit ✅
- Repo total 345MB → unter 1GB Limit ✅
- Sollte gehen ohne Git LFS

### Push schlägt mit Authentication-Fehler fehl
GitHub akzeptiert seit 2021 kein Passwort mehr — du brauchst entweder:
- **Personal Access Token** (PAT) → [github.com/settings/tokens](https://github.com/settings/tokens) → "Generate new token (classic)" → Scope `repo` → kopieren → bei Push als Passwort eingeben
- Oder **GitHub CLI** installieren: `winget install GitHub.cli` → `gh auth login`
- Oder **GitHub Desktop** App: einfach Drag-and-drop

### Workflow fehlt nach Push
- Settings → Actions → General → "Allow all actions and reusable workflows" muss aktiv sein

### Workflow läuft, aber Posting schlägt fehl
- Logs lesen unter Actions → der fehlgeschlagene Run
- Häufigste Ursachen:
  - Token expired → frischen über `extend-meta-token.js` und Secret updaten
  - Falsche `IG_USER_ID` → muss `17841480639457014` sein

---

## **Was ist mit "Wusstest du schon" Channel?**

Das hier ist isoliert für **Busy Adults Life**. Die `IG_USER_ID` Secret zeigt nur auf @busyadultslife.
Wenn du Wusstest-du-schon auch in die Cloud willst → eigenes Repo mit deren `IG_USER_ID` und Videos.
