# Explorateur de vulnérabilités de cybersécurité (Athena AI + MCP)

Un agent **Athena AI** qui explore de **vraies vulnérabilités (CVE)** de la base publique
**NVD (National Vulnerability Database) du NIST**, à travers un **serveur MCP**, et les affiche
dans un **widget interactif** intégré à la conversation.

## Source de données

- **API :** NVD CVE API 2.0 (publique, sans clé) — <https://nvd.nist.gov/developers/vulnerabilities>
- **Point d'accès :** `https://services.nvd.nist.gov/rest/json/cves/2.0`
- **Filtres utilisés :** `keywordSearch` (fournisseur / produit), `cvssV3Severity`, `pubStartDate` / `pubEndDate`

## Fonctionnement

1. L'utilisateur demande par exemple « les vulnérabilités critiques de Microsoft des 30 derniers jours ».
2. Athena appelle l'outil MCP `chercher_vulnerabilites` (`fournisseur`, `produit`, `severite`, `jours`).
3. Le serveur interroge la NVD, garde les CVE les plus récentes, extrait le fournisseur et le produit
   (identifiants CPE), le score et la sévérité CVSS, puis renvoie les données (`structuredContent`).
4. Athena affiche le widget `ui://widget/donnees.html` avec ces données.

## Interactions du widget

- **Fournisseur / Produit** (champs texte) : relancent la recherche sur la NVD via `window.openai.callTool`.
- **Sévérité** et **Période de publication** (menus) : relancent la recherche sur la NVD.
- **Pastilles de sévérité** cliquables (Critique, Élevée, Moyenne, Faible) avec compteurs : filtrent la liste.
- **Recherche** texte, **tri** (score, date, nom), **clic** sur une CVE : détails (vecteur CVSS, description)
  et lien vers la fiche NVD.

## Lancer en local

```bash
npm install
npm run dev               # http://localhost:8787/mcp
npm run inspector         # tester l'outil avec MCP Inspector
ngrok http 8787 --url https://sister-express-dairy.ngrok-free.dev
```

## Structure

| Fichier | Rôle |
| --- | --- |
| `server.js` | Serveur MCP : déclare le widget (ressource `text/html+skybridge`) et l'outil, appelle la NVD |
| `public/widget.html` | Widget HTML/CSS/JS affiché dans Athena (`window.openai`) |
| `package.json` | Dépendances (`@modelcontextprotocol/sdk`, `zod`) et scripts |

## Liens

- URL MCP : <https://sister-express-dairy.ngrok-free.dev/mcp>
- Agent Athena : <https://athenachat.bot/chatbot/agent/explorateur-de-seisme4207>
