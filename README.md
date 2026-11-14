# Agent Athena AI : serveur MCP + widget interactif

Un agent Athena AI qui récupère de **vraies données publiques** à travers un serveur MCP
et les affiche dans un **widget interactif** intégré à la conversation.

## Source de données

- **API :** USGS Earthquake Hazards Program (publique, sans clé)
- **Point d'accès :** `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_{periode}.geojson`

## Fonctionnement

1. L'utilisateur pose une question à l'agent dans Athena.
2. Athena appelle l'outil MCP `chercher_seismes`.
3. Le serveur interroge l'API publique et renvoie les données (`structuredContent`).
4. Athena affiche le widget `ui://widget/donnees.html` avec ces données.
5. Le widget est interactif : menus qui rappellent l'outil (`window.openai.callTool`),
   recherche, tri, mini-carte cliquable et détails au clic.

## Lancer en local

```bash
npm install
npm start                 # http://localhost:8787/mcp
npm run inspector         # tester l'outil avec MCP Inspector
ngrok http 8787           # URL publique HTTPS -> ajouter /mcp
```

## Structure

| Fichier | Rôle |
| --- | --- |
| `server.js` | Serveur MCP : déclare le widget (ressource) et l'outil, appelle l'API |
| `public/widget.html` | Widget HTML/CSS/JS affiché dans Athena |
| `package.json` | Dépendances (`@modelcontextprotocol/sdk`, `zod`) et scripts |

## Liens

- URL MCP : `https://VOTRE-DOMAINE.ngrok-free.app/mcp`
- Agent Athena : `https://athenachat.bot/...`
