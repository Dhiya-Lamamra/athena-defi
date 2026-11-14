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
//  SUJET : Explorateur de vulnérabilités de cybersécurité (CVE)
//  Source : NVD (National Vulnerability Database) du NIST, API publique
//  Doc : https://nvd.nist.gov/developers/vulnerabilities
// =====================================================================

const TOOL_NAME = "chercher_vulnerabilites";

const TOOL_CONFIG = {
  title: "Explorer les vulnérabilités (CVE)",
  description:
    "Recherche de vraies vulnérabilités de cybersécurité (CVE) dans la base publique NVD du NIST, " +
    "filtrées par fournisseur (vendor), produit, sévérité CVSS et date de publication, puis les " +
    "affiche dans un widget interactif. À utiliser dès que l'utilisateur parle de vulnérabilités, " +
    "failles, CVE ou de la sécurité d'un logiciel ou d'un fournisseur (ex. Microsoft, Apache, Cisco).",
  inputSchema: {
    fournisseur: z
      .string()
      .max(60)
      .default("")
      .describe("Fournisseur (vendor), ex. microsoft, apache, cisco. Vide = tous"),
    produit: z
      .string()
      .max(60)
      .default("")
      .describe("Produit, ex. windows, tomcat, chrome. Vide = tous"),
    severite: z
      .enum(["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"])
      .default("ALL")
      .describe("Sévérité CVSS v3 : ALL, CRITICAL, HIGH, MEDIUM ou LOW"),
    jours: z
      .number()
      .int()
      .min(1)
      .max(120)
      .default(30)
      .describe("Vulnérabilités publiées dans les N derniers jours (max 120)"),
  },
};

const CONTROLES = [
  { name: "fournisseur", label: "Fournisseur", type: "text", placeholder: "ex. microsoft" },
  { name: "produit", label: "Produit", type: "text", placeholder: "ex. windows" },
  {
    name: "severite",
    label: "Sévérité",
    options: [
      { value: "ALL", label: "Toutes" },
      { value: "CRITICAL", label: "Critique" },
      { value: "HIGH", label: "Élevée" },
      { value: "MEDIUM", label: "Moyenne" },
      { value: "LOW", label: "Faible" },
    ],
  },
  {
    name: "jours",
    label: "Publiées depuis",
    type: "number",
    options: [
      { value: 7, label: "7 jours" },
      { value: 30, label: "30 jours" },
      { value: 90, label: "90 jours" },
      { value: 120, label: "120 jours" },
    ],
  },
];

const CATEGORIES = [
  { nom: "CRITICAL", label: "Critique", couleur: "#991b1b" },
  { nom: "HIGH", label: "Élevée", couleur: "#dc2626" },
  { nom: "MEDIUM", label: "Moyenne", couleur: "#d97706" },
  { nom: "LOW", label: "Faible", couleur: "#16a34a" },
  { nom: "NONE", label: "Non évaluée", couleur: "#6b7280" },
];
const LIBELLE = Object.fromEntries(CATEGORIES.map((c) => [c.nom, c.label]));

const NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const MAX_RESULTATS = 100;

// Format de date attendu par la NVD : 2026-11-14T17:30:00.000 (UTC)
const dateNvd = (d) => d.toISOString().replace("Z", "");

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Mémoire (cache) pour que les interactions du widget soient rapides
let nvdEnPanneJusqua = 0; // si la NVD vient d'échouer, on ne la réessaie pas pendant 5 min
let kevCache = { quand: 0, json: null }; // catalogue KEV gardé 10 min
const severiteCache = new Map(); // sévérité CVSS déjà récupérée par CVE

// La NVD est parfois surchargée (503) : on réessaie jusqu'à 4 fois.
async function appelNvd(params) {
  const url = `${NVD_URL}?${new URLSearchParams(params)}`;
  let derniere;
  for (let essai = 1; essai <= 2; essai++) {
    try {
      const reponse = await fetch(url, {
        headers: { "User-Agent": "athena-defi-mcp/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (reponse.ok) return { url, json: await reponse.json() };
      const msg = reponse.headers.get("message") ?? "";
      derniere = new Error(`La NVD a répondu ${reponse.status} ${msg}`.trim());
      if (reponse.status < 500 && reponse.status !== 429) throw derniere; // erreur de paramètres : inutile de réessayer
    } catch (e) {
      derniere = e;
    }
    console.log(`[NVD] essai ${essai} échoué (${derniere?.message}), nouvel essai…`);
    if (essai < 2) await pause(1000);
  }
  throw derniere;
}

// Sévérité CVSS officielle depuis le dépôt public du CVE Program (cvelistV5 sur GitHub)
async function severiteCveProgram(cveId) {
  if (severiteCache.has(cveId)) return severiteCache.get(cveId);
  const resultat = await severiteCveProgramBrut(cveId);
  if (resultat.publie) severiteCache.set(cveId, resultat);
  return resultat;
}

async function severiteCveProgramBrut(cveId) {
  const [, annee, num] = cveId.split("-");
  const dossier = `${Math.floor(Number(num) / 1000)}xxx`;
  const url = `https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/${annee}/${dossier}/${cveId}.json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return {};
    const j = await r.json();
    const blocs = [j.containers?.cna, ...(j.containers?.adp ?? [])];
    for (const b of blocs) {
      for (const m of b?.metrics ?? []) {
        const c = m.cvssV3_1 ?? m.cvssV3_0 ?? m.cvssV4_0;
        if (c?.baseScore != null) {
          return { score: c.baseScore, severite: c.baseSeverity, vecteur: c.vectorString, publie: j.cveMetadata?.datePublished };
        }
      }
    }
    return { publie: j.cveMetadata?.datePublished };
  } catch {
    return {};
  }
}

// Plan B si la NVD est indisponible : catalogue CISA KEV (vulnérabilités activement exploitées)
const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
async function donneesKev({ fournisseur = "", produit = "", severite = "ALL", jours = 30 }) {
  if (!kevCache.json || Date.now() - kevCache.quand > 10 * 60 * 1000) {
    const reponse = await fetch(KEV_URL, { signal: AbortSignal.timeout(20000) });
    if (!reponse.ok) throw new Error(`CISA KEV a répondu ${reponse.status}`);
    kevCache = { quand: Date.now(), json: await reponse.json() };
  }
  const json = kevCache.json;
  const limite = Date.now() - jours * 24 * 3600 * 1000;
  const f = fournisseur.trim().toLowerCase();
  const p = produit.trim().toLowerCase();
  const items = (json.vulnerabilities ?? [])
    .filter((v) => new Date(v.dateAdded).getTime() >= limite)
    .filter((v) => !f || v.vendorProject.toLowerCase().includes(f))
    .filter((v) => !p || v.product.toLowerCase().includes(p))
    .sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded))
    .slice(0, 60)
    .map((v) => ({
      id: v.cveID,
      nom: `${v.cveID} · ${v.vendorProject} / ${v.product}`,
      valeur: null,
      categorie: "KEV",
      date: new Date(v.dateAdded + "T00:00:00Z").toISOString(),
      lien: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
      details: {
        "Statut": "Activement exploitée (CISA KEV)",
        "Fournisseur": v.vendorProject,
        "Produit": v.product,
        "Nom": v.vulnerabilityName,
        "Rançongiciel": v.knownRansomwareCampaignUse,
        "Description": v.shortDescription,
      },
    }))
    ;
  // Enrichissement en parallèle : score et sévérité CVSS de chaque CVE
  const infos = await Promise.all(items.map((i) => severiteCveProgram(i.id)));
  items.forEach((i, k) => {
    const inf = infos[k];
    i.valeur = inf.score ?? null;
    i.categorie = inf.severite ?? "NONE";
    i.details = {
      "Sévérité": LIBELLE[i.categorie] ?? i.categorie,
      "Score CVSS": inf.score ?? "—",
      "Vecteur": inf.vecteur ?? "—",
      "Publiée le": inf.publie ? inf.publie.slice(0, 10) : "—",
      ...i.details,
    };
  });
  const filtres = items
    .filter((i) => severite === "ALL" || i.categorie === severite)
    .sort((a, b) => (b.valeur ?? -1) - (a.valeur ?? -1));
  return { url: KEV_URL, items: filtres };
}

// Fournisseur / produit lus dans les identifiants CPE (cpe:2.3:a:VENDOR:PRODUCT:...)
function fournisseurProduit(cve) {
  const cpe = (cve.configurations ?? [])
    .flatMap((c) => c.nodes ?? [])
    .flatMap((n) => n.cpeMatch ?? [])
    .map((m) => m.criteria?.split(":"))
    .find((p) => p && p.length > 4);
  if (cpe) return { vendeur: cpe[3], produit: cpe[4] };
  // Sinon : domaine de l'organisme qui a publié la CVE (ex. secure@microsoft.com)
  const dom = (cve.sourceIdentifier ?? "").split("@")[1]?.split(".").slice(-2, -1)[0];
  return { vendeur: dom ?? "inconnu", produit: "" };
}

async function recupererDonnees({ fournisseur = "", produit = "", severite = "ALL", jours = 30 }) {
  const fin = new Date();
  const debut = new Date(fin.getTime() - jours * 24 * 3600 * 1000);
  const params = {
    pubStartDate: dateNvd(debut),
    pubEndDate: dateNvd(fin),
    resultsPerPage: String(MAX_RESULTATS),
  };
  const motCle = [fournisseur, produit].map((s) => s.trim()).filter(Boolean).join(" ");
  if (motCle) params.keywordSearch = motCle;
  if (severite !== "ALL") params.cvssV3Severity = severite;

  let url, json;
  try {
    if (Date.now() < nvdEnPanneJusqua) throw new Error("NVD en panne récemment, on passe directement au plan B");
    ({ url, json } = await appelNvd(params));
  } catch (e) {
    if (Date.now() >= nvdEnPanneJusqua) nvdEnPanneJusqua = Date.now() + 5 * 60 * 1000;
    console.log(`[NVD] indisponible (${e.message}) : plan B CISA KEV`);
    const kev = await donneesKev({ fournisseur, produit, severite, jours });
    return {
      titre: "Vulnérabilités activement exploitées (CVE)",
      valeurLabel: "Score CVSS",
      source: "CISA KEV + CVE Program (NVD indisponible)",
      sourceUrl: kev.url,
      recupereLe: new Date().toISOString(),
      outil: TOOL_NAME,
      arguments: { fournisseur, produit, severite, jours },
      controles: CONTROLES,
      categories: CATEGORIES,
      total: kev.items.length,
      items: kev.items,
    };
  }
  const total = json.totalResults ?? 0;
  // La NVD renvoie les plus anciennes d'abord : on va chercher la dernière page (les plus récentes)
  if (total > MAX_RESULTATS) {
    ({ url, json } = await appelNvd({ ...params, startIndex: String(total - MAX_RESULTATS) }));
  }

  const items = (json.vulnerabilities ?? [])
    .map((v) => v.cve)
    .filter((c) => c && c.vulnStatus !== "Rejected")
    .map((c) => {
      const m =
        c.metrics?.cvssMetricV31?.[0] ?? c.metrics?.cvssMetricV30?.[0] ?? c.metrics?.cvssMetricV40?.[0];
      const cvss = m?.cvssData;
      const sev = cvss?.baseSeverity ?? "NONE";
      const { vendeur, produit: prod } = fournisseurProduit(c);
      const description = c.descriptions?.find((d) => d.lang === "en")?.value ?? "";
      return {
        id: c.id,
        nom: `${c.id} · ${vendeur}${prod ? " / " + prod : ""}`,
        valeur: cvss?.baseScore ?? null,
        categorie: sev,
        date: c.published ? new Date(c.published + "Z").toISOString() : null,
        lien: `https://nvd.nist.gov/vuln/detail/${c.id}`,
        details: {
          "Sévérité": LIBELLE[sev] ?? sev,
          "Score CVSS": cvss?.baseScore ?? "—",
          "Fournisseur": vendeur,
          "Produit": prod || "—",
          "Vecteur": cvss?.vectorString ?? "—",
          "Description": description.length > 350 ? description.slice(0, 350) + "…" : description,
        },
      };
    })
    .sort((a, b) => (b.valeur ?? -1) - (a.valeur ?? -1));

  return {
    titre: "Vulnérabilités de cybersécurité (CVE)",
    valeurLabel: "Score CVSS",
    source: "NVD — National Vulnerability Database (NIST)",
    sourceUrl: url,
    recupereLe: new Date().toISOString(),
    outil: TOOL_NAME,
    arguments: { fournisseur, produit, severite, jours },
    controles: CONTROLES,
    categories: CATEGORIES,
    total,
    items,
  };
}

function resumePourIA(data) {
  const compte = {};
  for (const i of data.items) compte[i.categorie] = (compte[i.categorie] ?? 0) + 1;
  const repartition = CATEGORIES.filter((c) => compte[c.nom])
    .map((c) => `${c.label} : ${compte[c.nom]}`)
    .join(", ");
  const top = data.items.slice(0, 3).map((i) => `${i.id} (${i.valeur ?? "?"})`).join(" ; ");
  return (
    `${data.total} vulnérabilités trouvées dans la NVD (${data.items.length} affichées). ` +
    `Répartition : ${repartition || "aucune"}. Les plus graves : ${top || "aucune"}.`
  );
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
