import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SITE = (process.env.SITE_URL || "https://animeflow.site").replace(/\/$/, "");
const MIN_POP = Number(process.env.MIN_POPULARITY || 1500);
const WINDOW_MIN = Number(process.env.WINDOW_MINUTES || 90);
const STATE_FILE = process.env.STATE_FILE || "state.json";
const DRY = process.env.DRY_RUN === "1";
const HOOK = process.env.DISCORD_WEBHOOK_URL || "";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; } };
const saveState = s => writeFileSync(STATE_FILE, JSON.stringify(s));

async function discord(payload) {
  if (DRY) { console.log("[DRY] ->", JSON.stringify(payload).slice(0, 300)); return true; }
  for (let i = 0; i < 4; i++) {
    const r = await fetch(HOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep(((j.retry_after || 2) + 0.5) * 1000); continue; }
    if (!r.ok) { console.error("Discord", r.status); return false; }
    await sleep(1200);
    return true;
  }
  return false;
}

const Q = `query($gt:Int,$lt:Int,$p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage}
airingSchedules(airingAt_greater:$gt,airingAt_lesser:$lt,sort:TIME){id airingAt episode
media{id isAdult format countryOfOrigin popularity episodes title{romaji english} coverImage{extraLarge} bannerImage}}}}`;

export async function fetchAired(now) {
  const out = [];
  for (let p = 1; p <= 4; p++) {
    const r = await fetch("https://graphql.anilist.co", { method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: Q, variables: { gt: now - WINDOW_MIN * 60, lt: now, p } }) });
    if (!r.ok) throw new Error("AniList " + r.status);
    const j = await r.json(); if (j.errors) throw new Error(j.errors[0].message);
    out.push(...j.data.Page.airingSchedules);
    if (!j.data.Page.pageInfo.hasNextPage) break;
  }
  return out.filter(s => { const m = s.media;
    return m && !m.isAdult && m.countryOfOrigin === "JP" && ["TV", "TV_SHORT", "ONA"].includes(m.format) && m.popularity >= MIN_POP; });
}

export function episodeEmbed(s) {
  const m = s.media, name = m.title.english || m.title.romaji;
  const last = m.episodes && s.episode === m.episodes;
  return { embeds: [{
    title: `🎬 ${name} — Épisode ${s.episode}${last ? " (final)" : ""}`,
    url: `${SITE}/#/anime/${m.id}/${s.episode}`,
    description: "Un nouvel épisode vient de sortir ! 🍿\nRetrouve-le sur **AnimeFlow** dès qu'il est ajouté.",
    color: 0xee1d37, thumbnail: m.coverImage?.extraLarge ? { url: m.coverImage.extraLarge } : undefined,
    footer: { text: "AnimeFlow • Sorties" }, timestamp: new Date(s.airingAt * 1000).toISOString() }] };
}

const dec = t => t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, " ").trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? m[1] : ""; };

export function parseRss(xml) {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(m => { const x = m[0];
    const img = (x.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="image/i) || x.match(/<media:(?:content|thumbnail)[^>]+url="([^"]+)"/i) || x.match(/<img[^>]+src="([^"]+)"/i) || [])[1];
    return { title: dec(tag(x, "title")), link: dec(tag(x, "link")), desc: dec(tag(x, "description")).slice(0, 280), img }; })
    .filter(i => i.title && /^https?:\/\//.test(i.link));
}

export async function main() {
  if (!DRY && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(HOOK)) throw new Error("DISCORD_WEBHOOK_URL manquant ou invalide");
  const now = Math.floor(Date.now() / 1000);
  const st = loadState() || { ep: {}, news: {} };
  st.seeded = st.seeded || {};
  let total = 0;
  const keep = 14 * 86400;
  for (const k of ["ep", "news"]) for (const id in st[k]) if (now - st[k][id] > keep) delete st[k][id];

  try {
    for (const s of await fetchAired(now)) {
      if (st.ep[s.id]) continue;
      if (await discord(episodeEmbed(s))) st.ep[s.id] = now;
    }
  } catch (e) { console.error("Épisodes :", e.message); }

  let feeds = []; try { feeds = JSON.parse(readFileSync(new URL("./feeds.json", import.meta.url), "utf8")); } catch {}
  for (const f of feeds) {
    try {
      const r = await fetch(f.url, { headers: { "User-Agent": "AnimeFlowBot/1.0" } });
      if (!r.ok) { console.error("Flux", f.name, r.status); continue; }
      const items = parseRss(await r.text()).slice(0, 15).reverse();
      const seed = !st.seeded[f.url];
      let posted = 0;
      for (const it of items) {
        if (st.news[it.link]) continue;
        if (seed) { st.news[it.link] = now; continue; }
        if (posted >= 8 || total >= 25) break;
                const ok = await discord({ embeds: [{ title: "📰 " + it.title.slice(0, 250), url: SITE, description: (it.desc ? it.desc + "\n\n" : "") + `[📖 Lire l'article](${it.link})`,
          color: 0x7c3aed, image: it.img ? { url: it.img } : undefined, footer: { text: `${f.name} • Actus AnimeFlow` } }] });
        if (ok) { st.news[it.link] = now; posted++; total++; }
      }
      if (items.length) st.seeded[f.url] = true;
    } catch (e) { console.error("Flux", f.name, e.message); }
  }
  saveState(st);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
