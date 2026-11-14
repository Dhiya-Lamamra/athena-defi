// =====================================================================
//  Serveur MCP de départ pour un agent Athena AI
//  - expose UN outil qui récupère de vraies données publiques
//  - renvoie ces données avec un widget interactif (public/widget.html)
//
//  Le jour J, tu modifies surtout la section « PARTIE À CHANGER ».
// =====================================================================

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

// Adresse interne du widget. Change le nom du fichier .html si tu veux,
// mais garde le préfixe ui://
const WIDGET_URI = "ui://widget/donnees.html";

// On lit le widget au démarrage. Redémarre le serveur après l'avoir modifié
// (ou lance `npm run dev`, qui redémarre tout seul).
const widgetHtml = readFileSync(new URL("./public/widget.html", import.meta.url), "utf8");

// =====================================================================
//  PARTIE À CHANGER LE JOUR J
//  Exemple : séismes récents, API publique de l'USGS (sans clé).
//  Doc : https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
// =====================================================================

const TOOL_NAME = "chercher_seismes";

const TOOL_CONFIG = {
  title: "Chercher les séismes récents",
  // La description est lue par l'IA pour décider QUAND appeler l'outil.
  // Sois précis : ce que l'outil fait, et quand l'utiliser.
  description:
    "Récupère les séismes récents dans le monde (données réelles de l'USGS) " +
    "et les affiche dans un widget interactif. À utiliser quand l'utilisateur " +
    "parle de séismes, tremblements de terre ou activité sismique.",
  // Les paramètres que l'IA (ou le widget) peut envoyer, avec leurs règles.
  inputSchema: {
    periode: z
      .enum(["hour", "day", "week", "month"])
      .default("week")
      .describe("Période couverte : hour, day, week ou month"),
    magnitudeMin: z
      .number()
      .min(0)
      .max(10)
      .default(2.5)
      .describe("Magnitude minimale des séismes à garder"),
  },
};

// Les menus déroulants que le widget affiche. Quand l'utilisateur en change
// un, le widget rappelle l'outil avec la nouvelle valeur (vraie interaction).
const CONTROLES = [
  {
    name: "periode",
    label: "Période",
    options: [
      { value: "hour", label: "Dernière heure" },
      { value: "day", label: "Dernier jour" },
      { value: "week", label: "7 derniers jours" },
      { value: "month", label: "30 derniers jours" },
    ],
  },
  {
    name: "magnitudeMin",
    label: "Magnitude min.",
    type: "number",
    options: [
      { value: 0, label: "Toutes" },
      { value: 2.5, label: "2,5 et plus" },
      { value: 4.5, label: "4,5 et plus" },
      { value: 6, label: "6 et plus" },
    ],
  },
];

// Va chercher les vraies données et les met dans un format GÉNÉRIQUE que le
// widget sait afficher, quel que soit le sujet :
//   { nom, valeur, date, lien, lat, lon, details: { "Libellé": valeur } }
async function recupererDonnees({ periode = "week", magnitudeMin = 2.5 }) {
  const sourceUrl = `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_${periode}.geojson`;
  const reponse = await fetch(sourceUrl);
  if (!reponse.ok) throw new Error(`L'API USGS a répondu ${reponse.status}`);
  const json = await reponse.json();

  const items = json.features
    .filter((f) => (f.properties.mag ?? 0) >= magnitudeMin)
    .sort((a, b) => (b.properties.mag ?? 0) - (a.properties.mag ?? 0))
    .slice(0, 150) // on limite pour garder un widget rapide
    .map((f) => ({
      id: f.id,
      nom: f.properties.place ?? "Lieu inconnu",
      valeur: f.properties.mag,
      date: new Date(f.properties.time).toISOString(),
      lien: f.properties.url,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      details: {
        "Profondeur (km)": f.geometry.coordinates[2],
        "Alerte tsunami": f.properties.tsunami ? "Oui" : "Non",
        "Type": f.properties.type,
      },
    }));

  return {
    titre: "Séismes récents",
    valeurLabel: "Magnitude",
    source: "USGS Earthquake Hazards Program",
    sourceUrl,
    recupereLe: new Date().toISOString(),
    outil: TOOL_NAME,
    arguments: { periode, magnitudeMin },
    controles: CONTROLES,
    total: items.length,
    items,
  };
}

// Petit résumé en texte, lu par l'IA (pas affiché dans le widget).
function resumePourIA(data) {
  const top = data.items.slice(0, 3).map((i) => `${i.nom} (${i.valeur})`).join(" ; ");
  return `${data.total} résultats trouvés (source : ${data.source}). Les plus forts : ${top || "aucun"}.`;
}

// =====================================================================
//  FIN DE LA PARTIE À CHANGER — le reste fonctionne pour tous les sujets
// =====================================================================

function creerServeurMcp() {
  const server = new McpServer({ name: "athena-starter", version: "0.1.0" });

  // 1) Le widget, déclaré comme « ressource ». Le type text/html+skybridge
  //    indique à Athena que c'est un widget à afficher dans un iframe.
  server.registerResource(
    "widget",
    WIDGET_URI,
    {
      title: "Widget de données",
      description: "Widget interactif qui affiche les résultats de l'outil",
      mimeType: "text/html+skybridge",
      _meta: { "openai/widgetPrefersBorder": true },
    },
    async () => {
    console.log("[MCP] Athena lit le widget (resources/read)");
    return {
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: "text/html+skybridge",
        text: widgetHtml,
        _meta: { "openai/widgetPrefersBorder": true },
      },
    ],
    };
    }
  );

  // 2) L'outil. _meta["openai/outputTemplate"] relie l'outil au widget :
  //    « quand cet outil répond, affiche ce widget ».
  server.registerTool(
    TOOL_NAME,
    {
      ...TOOL_CONFIG,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        "openai/outputTemplate": WIDGET_URI,
        "openai/toolInvocation/invoking": "Récupération des données…",
        "openai/toolInvocation/invoked": "Données récupérées",
        // Permet au widget d'appeler cet outil lui-même (window.openai.callTool)
        "openai/widgetAccessible": true,
      },
    },
    async (args) => {
      console.log("[MCP] Athena appelle l'outil avec :", JSON.stringify(args));
      try {
        const data = await recupererDonnees(args);
        return {
          content: [{ type: "text", text: resumePourIA(data) }], // pour l'IA
          structuredContent: data, // pour le widget (et l'IA)
          _meta: { "openai/outputTemplate": WIDGET_URI },
        };
      } catch (err) {
        console.error(err);
        return {
          isError: true,
          content: [{ type: "text", text: `Erreur pendant la récupération : ${err.message}` }],
        };
      }
    }
  );

  return server;
}

// =====================================================================
//  Serveur HTTP : reçoit les requêtes d'Athena sur /mcp
// =====================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Pré-vérification CORS des navigateurs
  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, CORS).end();
    return;
  }

  // Page de santé : ouvre http://localhost:8787/ pour vérifier que ça tourne
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Serveur MCP en marche. Point d'accès : ${MCP_PATH}`);
    return;
  }

  if (url.pathname === MCP_PATH && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);

    // Mode « sans état » : un nouveau serveur MCP par requête. Simple et fiable.
    const server = creerServeurMcp();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Erreur MCP :", err);
      if (!res.headersSent) res.writeHead(500).end("Erreur interne du serveur");
    }
    return;
  }

  res.writeHead(404).end("Introuvable");
});

httpServer.listen(PORT, () => {
  console.log(`Serveur MCP en écoute sur http://localhost:${PORT}${MCP_PATH}`);
});
