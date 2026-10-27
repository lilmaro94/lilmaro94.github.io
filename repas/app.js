import { CATALOG, RECIPES } from "./recipes.js";

const DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm";
const MODEL = "claude-opus-5-5";
const STORE_KEY = "mon-hellofresh-v1";
const NUMBER_WORDS = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };

/* ---------- État ---------- */

const defaultState = () => ({
  profile: {
    people: 2, budget: 70, slots: ["soir"], diet: "omnivore", maxTime: 45,
    likes: "", avoid: [], phone: "", apiKey: "", livePrices: false,
  },
  plan: null,          // { days: [{ day, people, meals: [{ slot, recipeId, name, emoji, time, ingredients: [{name, qty, unit}] }] }] }
  aiShopping: null,    // liste renvoyée par l'IA (prix trouvés sur auchan.fr)
  checked: {},
  status: "draft",     // draft | validated | ordered
  chat: [],
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { ...defaultState(), ...saved, profile: { ...defaultState().profile, ...saved.profile } };
    }
  } catch { /* stockage indisponible : on repart de zéro */ }
  return defaultState();
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignoré */ }
}

/* ---------- Utilitaires ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const euro = (n) => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function formatQty(qty, unit) {
  if (unit === "g") return qty >= 1000 ? `${+(qty / 1000).toFixed(2)} kg` : `${Math.round(qty)} g`;
  if (unit === "ml") return qty >= 1000 ? `${+(qty / 1000).toFixed(2)} L` : `${Math.round(qty)} ml`;
  const n = Math.max(1, Math.ceil(qty - 0.05));
  return `${n} pièce${n > 1 ? "s" : ""}`;
}

function packLabel(size, unit) {
  if (unit !== "pièce") return formatQty(size, unit);
  return size > 1 ? `lot de ${size}` : "";
}

function unitPrice(item, qty) {
  return item.unit === "pièce" ? item.price * qty : (item.price * qty) / 1000;
}

function recipeCostPerPerson(r) {
  return Object.entries(r.ing).reduce((sum, [name, qty]) => sum + (CATALOG[name] ? unitPrice(CATALOG[name], qty) : 0), 0);
}

/* ---------- Moteur local (sans IA) ---------- */

function recipeAllowed(r, profile, extraAvoid = []) {
  const { diet, maxTime } = profile;
  if (diet === "vege" && !r.tags.includes("vege")) return false;
  if (diet === "pesco" && r.tags.includes("viande")) return false;
  if (diet === "flexi" && r.tags.includes("viande") && Math.random() < 0.5) return false;
  if (r.time > maxTime) return false;
  const hay = norm(r.name + " " + Object.keys(r.ing).join(" ") + " " + r.tags.join(" "));
  return ![...profile.avoid, ...extraAvoid].some((a) => a && hay.includes(norm(a)));
}

function likeScore(r, likes) {
  const words = norm(likes).split(/[\s,;]+/).filter((w) => w.length > 2);
  const hay = norm(r.name + " " + r.tags.join(" ") + " " + Object.keys(r.ing).join(" "));
  return words.reduce((s, w) => s + (hay.includes(w) ? 2 : 0), 0);
}

function pickRecipe(profile, exclude = new Set(), keyword = "") {
  let pool = RECIPES.filter((r) => recipeAllowed(r, profile) && !exclude.has(r.id));
  if (keyword) {
    const k = norm(keyword);
    const hits = RECIPES.filter((r) => norm(r.name).includes(k) || r.tags.includes(k));
    if (hits.length) pool = hits;
  }
  if (!pool.length) pool = RECIPES.filter((r) => !exclude.has(r.id));
  const mealsPerWeek = 7 * profile.slots.length;
  const targetPerPerson = profile.budget / Math.max(1, mealsPerWeek * profile.people);
  const scored = pool.map((r) => {
    const cost = recipeCostPerPerson(r);
    const overBudget = Math.max(0, cost - targetPerPerson) * 3;
    return { r, score: likeScore(r, profile.likes) - overBudget + Math.random() * 2.5 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].r;
}

function mealFromRecipe(r, slot, people) {
  return {
    slot, recipeId: r.id, name: r.name, emoji: r.emoji, time: r.time,
    ingredients: Object.entries(r.ing).map(([name, qty]) => ({ name, qty: qty * people, unit: CATALOG[name]?.unit ?? "pièce" })),
  };
}

function generatePlan(profile) {
  const used = new Set();
  return {
    days: DAYS.map((day) => ({
      day, people: profile.people,
      meals: profile.slots.map((slot) => {
        const r = pickRecipe(profile, used);
        used.add(r.id);
        return mealFromRecipe(r, slot, profile.people);
      }),
    })),
  };
}

function usedRecipeIds() {
  return new Set(state.plan.days.flatMap((d) => d.meals.map((m) => m.recipeId)).filter(Boolean));
}

function swapMeal(dayObj, slot, keyword = "") {
  const exclude = usedRecipeIds();
  dayObj.meals.forEach((m, i) => {
    if (slot && m.slot !== slot) return;
    const r = pickRecipe(state.profile, exclude, keyword);
    exclude.add(r.id);
    dayObj.meals[i] = mealFromRecipe(r, m.slot, dayObj.people);
  });
}

function setPeople(dayObj, people) {
  const ratio = people / dayObj.people;
  dayObj.people = people;
  dayObj.meals.forEach((m) => m.ingredients.forEach((ing) => { ing.qty *= ratio; }));
}

// Remplace les repas les plus chers par des recettes moins chères jusqu'à tenir le budget.
function fitBudget() {
  let swapped = 0;
  const tried = new Set();
  while (swapped < 10 && shoppingTotal(buildShopping()) > state.profile.budget) {
    const meals = state.plan.days.flatMap((d) => d.meals.map((m, i) => ({ d, m, i })))
      .filter(({ m }) => !tried.has(m.name))
      .map((x) => ({ ...x, cost: x.m.ingredients.reduce((s, ing) => s + (CATALOG[ing.name] ? unitPrice(CATALOG[ing.name], ing.qty) : 0), 0) / x.d.people }));
    if (!meals.length) break;
    meals.sort((a, b) => b.cost - a.cost);
    const { d, m, i, cost } = meals[0];
    tried.add(m.name);
    const used = usedRecipeIds();
    const cheaper = RECIPES.filter((r) => !used.has(r.id) && recipeAllowed(r, state.profile) && recipeCostPerPerson(r) < cost * 0.8)
      .sort((a, b) => recipeCostPerPerson(a) - recipeCostPerPerson(b))[0];
    if (!cheaper) continue;
    d.meals[i] = mealFromRecipe(cheaper, m.slot, d.people);
    tried.add(cheaper.name);
    swapped++;
  }
  return swapped;
}

/* ---------- Liste de courses ---------- */

function buildShopping() {
  if (!state.plan) return [];
  const aiIndex = new Map((state.aiShopping ?? []).map((s) => [norm(s.name), s]));
  const totals = new Map();
  for (const d of state.plan.days) {
    for (const m of d.meals) {
      for (const ing of m.ingredients) {
        const key = norm(ing.name) + "|" + ing.unit;
        const cur = totals.get(key) ?? { name: ing.name, unit: ing.unit, qty: 0 };
        cur.qty += ing.qty;
        totals.set(key, cur);
      }
    }
  }
  const list = [];
  for (const it of totals.values()) {
    const cat = CATALOG[it.name];
    const ai = aiIndex.get(norm(it.name));
    if (ai && ai.qty > 0) {
      // Prix trouvé par l'IA : on le ramène à la quantité réelle, par paquets entiers.
      const packs = Math.max(1, Math.ceil(it.qty / ai.qty - 0.05));
      list.push({ ...it, rayon: ai.rayon, product: ai.product, source: ai.source, packs, packLabel: packLabel(ai.qty, ai.unit), price: ai.price * packs });
    } else if (cat) {
      const packs = Math.max(1, Math.ceil(it.qty / cat.pack - 0.05));
      list.push({ ...it, rayon: cat.rayon, product: "", source: "estimation", packs, packLabel: packLabel(cat.pack, cat.unit), price: unitPrice(cat, packs * cat.pack) });
    } else {
      list.push({ ...it, rayon: "Divers", product: "", source: "estimation", packs: 1, packLabel: "", price: 0 });
    }
  }
  const order = ["Fruits & légumes", "Boucherie", "Poissonnerie", "Frais", "Boulangerie", "Épicerie", "Divers"];
  list.sort((a, b) => (order.indexOf(a.rayon) + 99) % 99 - (order.indexOf(b.rayon) + 99) % 99 || a.name.localeCompare(b.name, "fr"));
  return list;
}

const shoppingTotal = (list) => list.reduce((s, i) => s + i.price, 0);
const auchanSearch = (name) => `https://www.auchan.fr/recherche?text=${encodeURIComponent(name)}`;

/* ---------- Interprétation des messages (mode local) ---------- */

function parseNumber(str) {
  const m = str.match(/\b(\d{1,2})\b/);
  if (m) return +m[1];
  for (const [w, n] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${w}\\b`).test(str)) return n;
  return null;
}

function daysIn(str) {
  if (/\b(tous les jours|toute la semaine|chaque jour)\b/.test(str)) return [...DAYS];
  if (/\bweek-?end\b/.test(str)) return ["samedi", "dimanche"];
  return DAYS.filter((d) => new RegExp(`\\b${d}s?\\b`).test(str));
}

function slotIn(str) {
  if (/\b(midi|dejeuner|dej)\b/.test(str)) return "midi";
  if (/\b(soir|diner)\b/.test(str)) return "soir";
  return "";
}

function recipeKeyword(str) {
  const k = str.match(/\b(?:en|par|des|du|de la|un|une|mets|plutot|envie de|je veux)\s+([a-z\- ]{3,30})/);
  if (!k) return "";
  const words = k[1].trim().split(/\s+/);
  for (const w of words) {
    if (DAYS.includes(w) || ["midi", "soir", "le", "la", "les", "pour"].includes(w)) continue;
    if (RECIPES.some((r) => norm(r.name).includes(w) || r.tags.includes(w))) return w;
  }
  return "";
}

function localHandle(text) {
  const t = norm(text);
  const notes = [];

  if (/\b(nouvelle semaine|regenere|refais tout|recommence|genere|prepare)\b/.test(t) || !state.plan) {
    state.plan = generatePlan(state.profile);
    state.aiShopping = null;
    state.checked = {};
    state.status = "draft";
    return weekSummary("Voilà ta semaine 👇");
  }

  if (/\b(valide|c'?est bon|go|parfait|ca marche)\b/.test(t) && !/\b(change|remplace)\b/.test(t)) {
    state.status = "validated";
    return `✅ Liste validée ! *${euro(shoppingTotal(buildShopping()))}*.\nAppuie sur *Commander chez Auchan* pour remplir le panier.`;
  }

  const clauses = t.split(/[,;.!?\n]|\bet\b|\bpuis\b|\baussi\b/).map((c) => c.trim()).filter(Boolean);
  for (const c of clauses) {
    const days = daysIn(c);
    const slot = slotIn(c);

    const avoid = c.match(/\b(?:pas de|sans|plus de|j'?aime pas (?:les?|la)?|je deteste (?:les?|la)?)\s*([a-z ]{3,25})/);
    if (avoid && !/\b(on sera|personnes?)\b/.test(c)) {
      const term = avoid[1].trim().replace(/^(les?|la|du|des)\s+/, "").split(/\s+/)[0].replace(/s$/, "");
      if (!state.profile.avoid.includes(term)) state.profile.avoid.push(term);
      let swapped = 0;
      for (const d of state.plan.days) {
        d.meals.forEach((m, i) => {
          if (norm(m.name + " " + m.ingredients.map((x) => x.name).join(" ")).includes(term)) {
            const r = pickRecipe(state.profile, usedRecipeIds());
            d.meals[i] = mealFromRecipe(r, m.slot, d.people);
            swapped++;
          }
        });
      }
      notes.push(`🚫 Noté : plus de *${term}*${swapped ? ` (${swapped} repas remplacé${swapped > 1 ? "s" : ""})` : ""}.`);
      continue;
    }

    const budget = c.match(/\bbudget\D{0,6}(\d{2,4})/);
    if (budget) {
      state.profile.budget = +budget[1];
      const swapped = fitBudget();
      notes.push(`💶 Budget fixé à *${euro(state.profile.budget)}*${swapped ? ` : ${swapped} repas remplacé${swapped > 1 ? "s" : ""} par moins cher` : ""}.`);
      continue;
    }

    const peopleCtx = /\b(on sera|on est|nous serons|nous sommes|seront|pour)\b/.test(c) || /\b(personnes?|pers|couverts?)\b/.test(c);
    const n = peopleCtx ? parseNumber(c) : null;
    if (n) {
      const targets = days.length ? days : DAYS;
      for (const d of state.plan.days) if (targets.includes(d.day)) setPeople(d, n);
      if (!days.length) state.profile.people = n;
      notes.push(`👥 *${n} personnes* ${days.length ? days.map(cap).join(", ") : "toute la semaine"} : quantités ajustées.`);
      continue;
    }

    if (days.length && /\b(change|remplace|autre|pas envie|refais|modifie|mets|plutot|envie)\b/.test(c)) {
      const kw = recipeKeyword(c);
      for (const d of state.plan.days) {
        if (!days.includes(d.day)) continue;
        swapMeal(d, slot, kw);
        notes.push(`🔄 ${cap(d.day)} : ${d.meals.filter((m) => !slot || m.slot === slot).map((m) => `${m.emoji} ${m.name}`).join(" / ")}`);
      }
      continue;
    }

    if (/\b(liste|courses)\b/.test(c)) {
      notes.push(shoppingMessage());
      continue;
    }
    if (/\b(menu|semaine|recap)\b/.test(c)) {
      notes.push(weekSummary("Ton menu 👇"));
      continue;
    }
  }

  if (!notes.length) {
    return "Je n'ai pas tout compris 🤔 Essaie par exemple :\n• _change mardi_\n• _on sera 4 jeudi_\n• _pas de poisson_\n• _mets des tacos vendredi_\n• _budget 60_\n\n💡 Ajoute une clé API Claude dans *Profil* pour me parler librement.";
  }
  if (state.status !== "draft") state.status = "draft";
  const total = shoppingTotal(buildShopping());
  notes.push(`🛒 Nouveau total : *${euro(total)}*${total > state.profile.budget ? ` ⚠️ (budget ${euro(state.profile.budget)})` : ""}`);
  return notes.join("\n");
}

function weekSummary(title) {
  const lines = [title, ""];
  for (const d of state.plan.days) {
    lines.push(`*${cap(d.day)}*${d.people !== state.profile.people ? ` (${d.people} pers.)` : ""}`);
    for (const m of d.meals) lines.push(`${m.emoji} ${state.profile.slots.length > 1 ? cap(m.slot) + " : " : ""}${m.name}`);
  }
  const total = shoppingTotal(buildShopping());
  lines.push("", `🛒 Courses : *${euro(total)}* pour ${state.profile.budget ? `un budget de ${euro(state.profile.budget)}` : "la semaine"}`);
  lines.push("Dis-moi ce qui ne te plaît pas, ou réponds *valide* 👌");
  return lines.join("\n");
}

function shoppingMessage() {
  const list = buildShopping();
  const lines = ["🛒 *Liste de courses*"];
  let rayon = "";
  for (const i of list) {
    if (i.rayon !== rayon) { rayon = i.rayon; lines.push("", `_${rayon}_`); }
    lines.push(`• ${i.name} — ${formatQty(i.qty, i.unit)}${i.price ? ` (${euro(i.price)})` : ""}`);
  }
  lines.push("", `Total : *${euro(shoppingTotal(list))}*`);
  return lines.join("\n");
}

/* ---------- Mode IA (Claude) ---------- */

const ING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "qty", "unit"],
  properties: { name: { type: "string" }, qty: { type: "number" }, unit: { type: "string", enum: ["g", "ml", "pièce"] } },
};

const AI_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["reply", "budget", "avoidAdd", "plan", "shopping"],
  properties: {
    reply: { type: "string", description: "Réponse courte façon WhatsApp, en français, formatage *gras* et _italique_ autorisé." },
    budget: { type: "number", description: "Budget hebdo en euros (inchangé sauf demande)." },
    avoidAdd: { type: "array", items: { type: "string" }, description: "Nouveaux ingrédients/aliments à exclure désormais." },
    plan: {
      type: "array", description: "Les 7 jours, lundi → dimanche.",
      items: {
        type: "object", additionalProperties: false, required: ["day", "people", "meals"],
        properties: {
          day: { type: "string", enum: DAYS },
          people: { type: "integer" },
          meals: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["slot", "name", "emoji", "time", "ingredients"],
              properties: {
                slot: { type: "string", enum: ["midi", "soir"] },
                name: { type: "string" }, emoji: { type: "string" }, time: { type: "integer" },
                ingredients: { type: "array", items: ING_SCHEMA, description: "Quantités TOTALES pour le nombre de personnes du jour." },
              },
            },
          },
        },
      },
    },
    shopping: {
      type: "array", description: "Un produit Auchan par ingrédient de la semaine (même nom que dans les recettes).",
      items: {
        type: "object", additionalProperties: false, required: ["name", "qty", "unit", "rayon", "price", "product", "source"],
        properties: {
          name: { type: "string" },
          qty: { type: "number", description: "Contenance d'UN paquet du produit." },
          unit: { type: "string", enum: ["g", "ml", "pièce"] },
          rayon: { type: "string", enum: ["Fruits & légumes", "Boucherie", "Poissonnerie", "Frais", "Boulangerie", "Épicerie", "Divers"] },
          price: { type: "number", description: "Prix d'UN paquet en euros." },
          product: { type: "string", description: "Nom du produit Auchan, ex. 'Auchan Pâtes penne 500g'." },
          source: { type: "string", enum: ["auchan.fr", "estimation"] },
        },
      },
    },
  },
};

function systemPrompt() {
  return `Tu es "Chef", l'assistant repas d'un foyer français, qui discute comme sur WhatsApp.
Ton job : composer les repas de la semaine, ajuster selon les messages ("change mardi", "on sera 4 jeudi", "pas de poisson"), et tenir la liste de courses Auchan à jour.
Règles :
- Respecte le régime, les exclusions, le temps de préparation max et vise le budget hebdo de la liste de courses.
- Ne modifie que ce qui est demandé ; garde le reste du planning identique.
- Les quantités d'ingrédients d'un repas sont totales pour le nombre de personnes du jour.
- Dans "shopping", une ligne par ingrédient utilisé dans la semaine, avec un paquet réaliste vendu chez Auchan et son prix.
${state.profile.livePrices ? "- Utilise la recherche web sur auchan.fr pour trouver les vrais prix des produits principaux ; mets source=\"auchan.fr\" quand le prix vient d'une page Auchan, \"estimation\" sinon." : "- Les prix sont des estimations réalistes des prix Auchan (source=\"estimation\")."}
- "reply" : 1 à 6 lignes, chaleureux, emojis bienvenus, termine par le total des courses.`;
}

function userPrompt(text) {
  const p = state.profile;
  const compactPlan = state.plan?.days.map((d) => ({
    day: d.day, people: d.people,
    meals: d.meals.map((m) => ({ slot: m.slot, name: m.name, emoji: m.emoji, time: m.time, ingredients: m.ingredients.map((i) => ({ ...i, qty: Math.round(i.qty * 10) / 10 })) })),
  }));
  const history = state.chat.slice(-10).map((m) => `${m.from === "me" ? "Moi" : "Chef"} : ${m.text}`).join("\n");
  return `## Profil
- Personnes par défaut : ${p.people}
- Budget courses semaine : ${p.budget} €
- Repas à prévoir : ${p.slots.join(" + ")}
- Régime : ${p.diet}
- Temps max : ${p.maxTime} min
- Goûts : ${p.likes || "—"}
- À éviter : ${p.avoid.join(", ") || "—"}

## Planning actuel
${compactPlan ? JSON.stringify(compactPlan) : "Aucun : génère une semaine complète."}

## Derniers échanges
${history || "—"}

## Nouveau message
${text}`;
}

let sdkPromise;
async function callClaude(text) {
  sdkPromise ??= import(SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  const client = new Anthropic({ apiKey: state.profile.apiKey, dangerouslyAllowBrowser: true });

  const messages = [{ role: "user", content: userPrompt(text) }];
  const params = {
    model: MODEL,
    max_tokens: 64000,
    system: systemPrompt(),
    output_config: { effort: "medium", format: { type: "json_schema", schema: AI_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages,
  };
  if (state.profile.livePrices) {
    params.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 10, allowed_domains: ["auchan.fr"] }];
  }

  let msg;
  for (let turn = 0; turn < 5; turn++) {
    msg = await client.beta.messages.stream(params).finalMessage();
    if (msg.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: msg.content });
  }
  if (msg.stop_reason === "refusal") throw new Error("La demande a été refusée par le modèle.");
  if (msg.stop_reason === "max_tokens") throw new Error("Réponse trop longue, réessaie avec une demande plus simple.");

  // Le JSON final est le texte écrit après le dernier résultat de recherche.
  let lastTool = -1;
  msg.content.forEach((b, i) => { if (b.type.endsWith("tool_result") || b.type === "server_tool_use") lastTool = i; });
  const json = msg.content.slice(lastTool + 1).filter((b) => b.type === "text").map((b) => b.text).join("");
  const data = JSON.parse(json);

  state.plan = { days: data.plan.map((d) => ({ ...d, meals: d.meals.map((m) => ({ ...m, recipeId: null })) })) };
  state.aiShopping = data.shopping;
  state.profile.budget = data.budget || state.profile.budget;
  for (const a of data.avoidAdd) if (!state.profile.avoid.includes(a)) state.profile.avoid.push(a);
  state.status = /\bvalid/.test(norm(text)) ? "validated" : "draft";
  return data.reply;
}

/* ---------- Conversation ---------- */

async function send(text) {
  text = text.trim();
  if (!text) return;
  pushMsg("me", text);
  setTyping(true);
  let reply;
  try {
    reply = state.profile.apiKey ? await callClaude(text) : localHandle(text);
  } catch (err) {
    console.error(err);
    reply = `⚠️ Oups, l'IA n'a pas pu répondre (${err.message}).\nJe passe en mode local :\n\n${localHandle(text)}`;
  }
  setTyping(false);
  pushMsg("bot", reply);
  save();
  renderAll();
}

function pushMsg(from, text) {
  state.chat.push({ from, text, ts: Date.now() });
  if (state.chat.length > 80) state.chat = state.chat.slice(-80);
  save();
  renderChat();
}

function setTyping(on) {
  $("#status").textContent = on ? "écrit…" : "en ligne";
  $("#typing").hidden = !on;
  $("#send").disabled = on;
  if (on) scrollChat();
}

/* ---------- Rendu ---------- */

function waFormat(text) {
  return escapeHtml(text)
    .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
    .replace(/(^|\s)_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
}

function renderChat() {
  const box = $("#messages");
  box.innerHTML = state.chat.map((m) => {
    const time = new Date(m.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    return `<div class="bubble ${m.from}"><div>${waFormat(m.text)}</div><span class="meta">${time}${m.from === "me" ? ' <span class="ticks">✓✓</span>' : ""}</span></div>`;
  }).join("");
  scrollChat();
}

function scrollChat() {
  const box = $("#messages");
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

function renderWeek() {
  const el = $("#week");
  if (!state.plan) {
    el.innerHTML = `<div class="empty"><p>Pas encore de menu.</p><button class="btn primary" data-say="Prépare mes repas de la semaine">Préparer ma semaine</button></div>`;
    return;
  }
  el.innerHTML = state.plan.days.map((d) => `
    <article class="day">
      <header>
        <h3>${cap(d.day)}</h3>
        <div class="people" role="group" aria-label="Personnes ${d.day}">
          <button class="icon" data-people="${d.day}" data-delta="-1" aria-label="Une personne de moins">−</button>
          <span>${d.people} 👤</span>
          <button class="icon" data-people="${d.day}" data-delta="1" aria-label="Une personne de plus">+</button>
        </div>
      </header>
      ${d.meals.map((m) => `
        <div class="meal">
          <span class="emoji" aria-hidden="true">${m.emoji}</span>
          <div class="meal-body">
            <strong>${escapeHtml(m.name)}</strong>
            <small>${state.profile.slots.length > 1 ? cap(m.slot) + " · " : ""}${m.time} min · ${m.ingredients.length} ingrédients</small>
          </div>
          <button class="icon swap" data-swap="${d.day}" data-slot="${m.slot}" aria-label="Changer ce repas" title="Changer">🔄</button>
        </div>`).join("")}
    </article>`).join("");
}

function renderShopping() {
  const el = $("#shopping");
  const list = buildShopping();
  if (!list.length) {
    el.innerHTML = `<div class="empty"><p>La liste apparaîtra avec ton menu.</p></div>`;
    return;
  }
  let rayon = "";
  let html = "";
  for (const i of list) {
    if (i.rayon !== rayon) {
      if (rayon) html += "</ul>";
      rayon = i.rayon;
      html += `<h3 class="rayon">${rayon}</h3><ul class="items">`;
    }
    const key = norm(i.name);
    html += `<li class="${state.checked[key] ? "done" : ""}">
      <label><input type="checkbox" data-check="${escapeHtml(key)}" ${state.checked[key] ? "checked" : ""}>
        <span class="item-name">${escapeHtml(i.name)}<small>${formatQty(i.qty, i.unit)}${i.product || i.packLabel ? ` · ${i.packs} × ${escapeHtml(i.product || i.packLabel)}` : ""}</small></span>
      </label>
      <span class="price">${i.price ? euro(i.price) : "—"}${i.source === "auchan.fr" ? '<em class="src">auchan.fr</em>' : ""}</span>
    </li>`;
  }
  el.innerHTML = html + "</ul>" +
    `<p class="note">${state.aiShopping?.some((s) => s.source === "auchan.fr") ? "Prix relevés sur auchan.fr par l'IA ; les autres sont estimés." : "Prix estimés d'après les tarifs Auchan habituels. Active « vrais prix » dans Profil pour les relever en ligne."}</p>`;
}

function renderBar() {
  const list = buildShopping();
  const total = shoppingTotal(list);
  const { budget } = state.profile;
  const pct = budget ? Math.min(100, (total / budget) * 100) : 0;
  $("#total").textContent = euro(total);
  $("#budget").textContent = `/ ${euro(budget)}`;
  const meter = $("#meter > span");
  meter.style.width = pct + "%";
  meter.classList.toggle("over", total > budget);
  const btn = $("#validate");
  btn.disabled = !state.plan;
  btn.textContent = state.status === "draft" ? "Valider la liste" : "Commander chez Auchan";
  btn.classList.toggle("go", state.status !== "draft");
  $("#state-pill").textContent = { draft: "Brouillon", validated: "Validée ✓", ordered: "Panier envoyé 🛒" }[state.status];
}

function renderProfile() {
  const f = $("#profile");
  const p = state.profile;
  f.people.value = p.people;
  f.budget.value = p.budget;
  f.diet.value = p.diet;
  f.maxTime.value = p.maxTime;
  f.likes.value = p.likes;
  f.avoid.value = p.avoid.join(", ");
  f.phone.value = p.phone;
  f.apiKey.value = p.apiKey;
  f.livePrices.checked = p.livePrices;
  f.querySelectorAll('input[name="slots"]').forEach((c) => { c.checked = p.slots.includes(c.value); });
  $("#mode").textContent = p.apiKey ? "IA Claude" : "mode local";
}

function renderAll() {
  renderWeek();
  renderShopping();
  renderBar();
  renderProfile();
}

/* ---------- Commande ---------- */

function exportText() {
  const lines = ["*🍽️ Menu de la semaine*", ""];
  for (const d of state.plan.days) {
    lines.push(`*${cap(d.day)}* (${d.people} pers.)`);
    for (const m of d.meals) lines.push(`${m.emoji} ${m.name}`);
  }
  lines.push("", shoppingMessage());
  return lines.join("\n");
}

function openOrder() {
  const list = buildShopping().filter((i) => !state.checked[norm(i.name)]);
  $("#order-list").innerHTML = list.map((i) => `
    <li><a href="${auchanSearch(i.product || i.name)}" target="_blank" rel="noopener">
      <span>${escapeHtml(i.name)} <small>× ${i.packs}</small></span><span>${i.price ? euro(i.price) : ""} ↗</span></a></li>`).join("");
  $("#order-total").textContent = euro(shoppingTotal(list));
  $("#order").showModal();
}

/* ---------- Événements ---------- */

function bind() {
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#input");
    const v = input.value;
    input.value = "";
    send(v);
  });

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, [data-say]");
    if (!t) return;
    if (t.dataset.say) { send(t.dataset.say); showView("chat"); return; }
    if (t.dataset.view) { showView(t.dataset.view); return; }
    if (t.dataset.swap) {
      const d = state.plan.days.find((x) => x.day === t.dataset.swap);
      swapMeal(d, t.dataset.slot);
      state.status = "draft";
      pushMsg("bot", `🔄 ${cap(d.day)} : ${d.meals.map((m) => `${m.emoji} ${m.name}`).join(" / ")}`);
      save(); renderAll();
      return;
    }
    if (t.dataset.people) {
      const d = state.plan.days.find((x) => x.day === t.dataset.people);
      const n = Math.max(1, Math.min(12, d.people + +t.dataset.delta));
      if (n !== d.people) { setPeople(d, n); state.status = "draft"; save(); renderAll(); }
    }
  });

  $("#shopping").addEventListener("change", (e) => {
    const key = e.target.dataset.check;
    if (!key) return;
    if (e.target.checked) state.checked[key] = true; else delete state.checked[key];
    save(); renderShopping();
  });

  $("#validate").addEventListener("click", () => {
    if (state.status === "draft") {
      state.status = "validated";
      pushMsg("me", "Je valide ✅");
      pushMsg("bot", `Top ! Liste validée : *${euro(shoppingTotal(buildShopping()))}*.\nJ'ouvre la commande Auchan 🛒`);
      save(); renderAll();
    }
    openOrder();
  });

  $("#order-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(exportText()); $("#order-copy").textContent = "Copié ✓"; } catch { /* presse-papiers bloqué */ }
  });
  $("#order-wa").addEventListener("click", () => {
    const phone = state.profile.phone.replace(/\D/g, "");
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(exportText())}`, "_blank", "noopener");
  });
  $("#order-done").addEventListener("click", () => {
    state.status = "ordered";
    pushMsg("bot", "🛒 Panier Auchan rempli. Bon appétit cette semaine ! Dis *nouvelle semaine* quand tu veux recommencer.");
    save(); renderAll();
    $("#order").close();
  });
  $("#share-wa").addEventListener("click", () => {
    if (!state.plan) return;
    const phone = state.profile.phone.replace(/\D/g, "");
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(exportText())}`, "_blank", "noopener");
  });

  $("#profile").addEventListener("change", (e) => {
    const f = e.currentTarget;
    const p = state.profile;
    const oldPeople = p.people;
    p.people = Math.max(1, +f.people.value || 1);
    p.budget = Math.max(0, +f.budget.value || 0);
    p.diet = f.diet.value;
    p.maxTime = +f.maxTime.value;
    p.likes = f.likes.value;
    p.avoid = f.avoid.value.split(",").map((s) => s.trim()).filter(Boolean);
    p.phone = f.phone.value;
    p.apiKey = f.apiKey.value.trim();
    p.livePrices = f.livePrices.checked;
    const slots = [...f.querySelectorAll('input[name="slots"]:checked')].map((c) => c.value);
    p.slots = slots.length ? slots : ["soir"];
    if (state.plan && p.people !== oldPeople) {
      for (const d of state.plan.days) if (d.people === oldPeople) setPeople(d, p.people);
    }
    save(); renderAll();
  });

  $("#reset").addEventListener("click", () => {
    if (!confirm("Effacer le menu, la liste et la conversation ?")) return;
    const profile = state.profile;
    state = { ...defaultState(), profile };
    save(); renderChat(); renderAll(); greet();
  });
}

function showView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false"));
  try { sessionStorage.setItem("view", view); } catch { /* ignoré */ }
}

function greet() {
  if (state.chat.length) return;
  pushMsg("bot", "Salut 👋 Je suis ton *Chef perso*.\nJe prépare tes repas de la semaine, je fais la liste de courses avec les prix Auchan, et tu me dis ce qui ne te va pas.\n\nRéponds *go* ou appuie sur _Préparer ma semaine_ pour commencer !");
}

bind();
renderChat();
renderAll();
greet();
let initialView = "chat";
try { initialView = sessionStorage.getItem("view") || "chat"; } catch { /* ignoré */ }
showView(initialView);
