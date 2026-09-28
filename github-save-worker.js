/**
 * github-save-worker.js
 *
 * Cloudflare Worker : reçoit data.json depuis GitHub Pages et le met à jour
 * dans le dépôt GitHub.
 *
 * SECRET À CONFIGURER DANS CLOUDFLARE :
 *   GH_TOKEN = token GitHub (Fine-grained)
 *
 * Le token n'est jamais envoyé au navigateur.
 */

const OWNER = "cmdashcod";
const REPO = "CM";
const BRANCH = "main";
const PATH = "data.json";

/*
 * IMPORTANT :
 * Remplacez cette origine par l'URL exacte de votre GitHub Pages.
 */
const ALLOWED_ORIGIN = "https://cmdashcod.github.io/CM/";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    }
  });
}

function base64EncodeUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    if (origin !== ALLOWED_ORIGIN) {
      return json({ ok: false, message: "Origin non autorisée." }, 403, origin);
    }

    if (request.method !== "POST") {
      return json({ ok: false, message: "Méthode non autorisée." }, 405, origin);
    }

    if (!env.GH_TOKEN) {
      return json({ ok: false, message: "Secret GH_TOKEN non configuré sur le Worker." }, 500, origin);
    }

    try {
      const raw = await request.text();

      // Limite de sécurité côté Worker.
      if (new TextEncoder().encode(raw).length > 90 * 1024 * 1024) {
        return json({ ok: false, message: "data.json dépasse 90 Mo." }, 413, origin);
      }

      const payload = JSON.parse(raw);

      if (!payload || !Array.isArray(payload.records)) {
        return json({ ok: false, message: "Payload invalide : records[] manquant." }, 400, origin);
      }

      // Protection basique contre un appel accidentel / contenu trop volumineux.
      if (payload.records.length > 500000) {
        return json({ ok: false, message: "Nombre de lignes supérieur à la limite autorisée." }, 413, origin);
      }

      const githubHeaders = {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${env.GH_TOKEN}`,
        "X-GitHub-Api-Version": "2026-03-10"
      };

      const apiUrl =
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`;

      // 1. Récupérer le SHA actuel.
      const getRes = await fetch(apiUrl, {
        method: "GET",
        headers: githubHeaders
      });

      if (!getRes.ok) {
        const detail = await getRes.text();
        return json({
          ok: false,
          message: `GitHub GET HTTP ${getRes.status}`,
          detail
        }, getRes.status, origin);
      }

      const current = await getRes.json();

      if (!current.sha) {
        return json({
          ok: false,
          message: "SHA de data.json introuvable."
        }, 500, origin);
      }

      // 2. Réécrire data.json.
      const content = base64EncodeUtf8(JSON.stringify(payload));

      const putRes = await fetch(apiUrl, {
        method: "PUT",
        headers: {
          ...githubHeaders,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: "Update data.json depuis le dashboard",
          content,
          sha: current.sha,
          branch: BRANCH
        })
      });

      const result = await putRes.json().catch(() => ({}));

      if (!putRes.ok) {
        return json({
          ok: false,
          message: result.message || `GitHub PUT HTTP ${putRes.status}`
        }, putRes.status, origin);
      }

      return json({
        ok: true,
        message: "data.json mis à jour dans GitHub.",
        rows: payload.records.length,
        commit: result.commit?.sha || null
      }, 200, origin);

    } catch (error) {
      return json({
        ok: false,
        message: error?.message || String(error)
      }, 500, origin);
    }
  }
};
