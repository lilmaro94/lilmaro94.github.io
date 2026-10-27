import { CATALOG, RECIPES } from "./recipes.js";
import { STORES, storeById } from "./stores.js";

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
    stores: STORES.map((s) => s.id), maxStores: 2, forcedStore: "",
  },
  plan: null,          // { days: [{ day, people, meals: [{ slot, recipeId, name, emoji, time, ingredients: [{name, qty, unit}] }] }] }
  aiShopping: null,    // offres par drive renvoyées par l'IA (prix, promos, lots)
  checked: {},
  status: "draft",     // draft | validated | ordered
  filled: {},          // drives dont le panier a été rempli
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
  if (state.status === "draft") state.filled = {};
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
  while (swapped < 10 && basket().total > state.profile.budget) {
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

const enabledStores = () => STORES.filter((s) => state.profile.stores.includes(s.id));

// Offres de chaque drive pour un besoin : prix relevé par l'IA si dispo, sinon estimation.
function offersFor(it, ai) {
  const cat = CATALOG[it.name];
  return enabledStores().map((s) => {
    const o = ai?.offers?.find((x) => x.store === s.id);
    if (o && o.qty > 0) {
      const packs = Math.max(1, Math.ceil(it.qty / o.qty - 0.05));
      return { store: s.id, packs, price: o.price * packs, product: o.product, promo: o.promo || "", source: o.source, packLabel: packLabel(o.qty, o.unit) };
    }
    if (cat) {
      const packs = Math.max(1, Math.ceil(it.qty / cat.pack - 0.05));
      return { store: s.id, packs, price: unitPrice(cat, packs * cat.pack) * s.index, product: "", promo: "", source: "estimation", packLabel: packLabel(cat.pack, cat.unit) };
    }
    return null;
  }).filter(Boolean);
}

function combos(ids, max) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length) out.push([...cur]);
    if (cur.length === max) return;
    for (let i = start; i < ids.length; i++) rec(i + 1, [...cur, ids[i]]);
  };
  rec(0, []);
  return out;
}

const cheapest = (offers, ids) => offers.filter((o) => ids.includes(o.store)).sort((a, b) => a.price - b.price)[0];

// Choisit le meilleur panier : 1 drive, ou jusqu'à `maxStores` drives en répartissant les produits.
function basket() {
  const items = buildShopping();
  const active = items.filter((i) => !state.checked[norm(i.name)]);
  const ids = enabledStores().map((s) => s.id);
  const costOf = (combo) => active.reduce((sum, i) => sum + (cheapest(i.offers, combo)?.price ?? cheapest(i.offers, ids)?.price ?? 0), 0);
  const singles = ids.map((id) => ({ id, total: costOf([id]) })).sort((a, b) => a.total - b.total);
  const { forcedStore, maxStores } = state.profile;
  const candidates = forcedStore && ids.includes(forcedStore) ? [[forcedStore]] : combos(ids, maxStores);
  let best = candidates[0] ?? [];
  let bestTotal = Infinity;
  for (const c of candidates) {
    // Un 2e drive ne vaut le déplacement que s'il fait gagner au moins 3 €.
    const t = costOf(c) + (c.length - 1) * 3;
    if (t < bestTotal) { bestTotal = t; best = c; }
  }
  for (const i of items) i.choice = cheapest(i.offers, best) ?? cheapest(i.offers, ids) ?? null;
  const byStore = best.map((id) => {
    const its = active.filter((i) => i.choice?.store === id);
    return { id, items: its, total: its.reduce((s, i) => s + i.choice.price, 0) };
  }).filter((g) => g.items.length);
  const total = active.reduce((s, i) => s + (i.choice?.price ?? 0), 0);
  const promos = active.filter((i) => i.choice?.promo).length;
  // Économie : vs le meilleur drive unique si on en fait plusieurs, sinon vs le plus cher.
  const ref = byStore.length > 1 ? singles[0] : singles.at(-1);
  return { items, byStore, total, singles, promos, ref: ref?.id, saving: (ref?.total ?? total) - total };
}

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
    const ai = aiIndex.get(norm(it.name));
    list.push({ ...it, rayon: ai?.rayon ?? CATALOG[it.name]?.rayon ?? "Divers", offers: offersFor(it, ai) });
  }
  const order = ["Fruits & légumes", "Boucherie", "Poissonnerie", "Frais", "Boulangerie", "Épicerie", "Divers"];
  list.sort((a, b) => (order.indexOf(a.rayon) + 99) % 99 - (order.indexOf(b.rayon) + 99) % 99 || a.name.localeCompare(b.name, "fr"));
  return list;
}

function basketLine(b) {
  if (!b.byStore.length) return "";
  const parts = b.byStore.map((g) => `${storeById(g.id).short} ${euro(g.total)}`).join(" + ");
  const saving = b.saving;
  return `${parts}${saving > 0.5 ? ` — *${euro(saving)}* d'économie vs ${storeById(b.ref).short}` : ""}`;
}

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
    const b = basket();
    return `✅ Liste validée ! *${euro(b.total)}*\n${basketLine(b)}\nAppuie sur *Remplir les paniers* pour préparer les drives.`;
  }

  let infoNotes = 0;
  const clauses = t.split(/[,;.!?\n]|\bet\b|\bpuis\b|\baussi\b/).map((c) => c.trim()).filter(Boolean);
  for (const c of clauses) {
    const days = daysIn(c);
    const slot = slotIn(c);

    const avoid = c.match(/\b(?:pas de|sans|plus de|j'?aime pas (?:les?|la)?|je deteste (?:les?|la)?)\s*([a-z ]{3,25})/);
    if (avoid && !storeIn(c) && !/\b(on sera|personnes?)\b/.test(c)) {
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

    const store = storeIn(c);
    if (store && /\b(que|seulement|uniquement|juste|tout chez|prefere|plutot)\b/.test(c)) {
      state.profile.forcedStore = store.id;
      if (!state.profile.stores.includes(store.id)) state.profile.stores.push(store.id);
      notes.push(`${store.emoji} OK, tout chez *${store.name}*.`);
      continue;
    }
    if (store && /\b(pas|sans|evite|jamais)\b/.test(c)) {
      state.profile.stores = state.profile.stores.filter((id) => id !== store.id);
      if (state.profile.forcedStore === store.id) state.profile.forcedStore = "";
      notes.push(`🚫 Plus de *${store.short}*.`);
      continue;
    }
    if (/\b(meilleur prix|moins cher|tous les drives|n'?importe quel drive|optimise)\b/.test(c)) {
      state.profile.forcedStore = "";
      notes.push(compareMessage());
      infoNotes++;
      continue;
    }
    const nDrives = c.match(/\b(\d|un|une|deux)\s+(drives?|magasins?)\b/);
    if (nDrives) {
      state.profile.maxStores = Math.min(3, NUMBER_WORDS[nDrives[1]] ?? +nDrives[1]);
      state.profile.forcedStore = "";
      notes.push(`🚗 Max *${state.profile.maxStores}* drive${state.profile.maxStores > 1 ? "s" : ""} à faire.`);
      continue;
    }
    if (/\b(compare|comparatif|prix des drives|promos?)\b/.test(c)) {
      notes.push(compareMessage());
      infoNotes++;
      continue;
    }

    if (/\b(liste|courses)\b/.test(c)) {
      notes.push(shoppingMessage());
      infoNotes++;
      continue;
    }
    if (/\b(menu|semaine|recap)\b/.test(c)) {
      notes.push(weekSummary("Ton menu 👇"));
      infoNotes++;
      continue;
    }
  }

  if (!notes.length) {
    return "Je n'ai pas tout compris 🤔 Essaie par exemple :\n• _change mardi_\n• _on sera 4 jeudi_\n• _pas de poisson_\n• _mets des tacos vendredi_\n• _budget 60_\n• _compare les drives_\n• _que chez Leclerc_ / _2 drives max_\n\n💡 Ajoute une clé API Claude dans *Profil* pour me parler librement.";
  }
  if (infoNotes === notes.length) return notes.join("\n\n");
  if (state.status !== "draft") state.status = "draft";
  const b = basket();
  notes.push(`🛒 Nouveau total : *${euro(b.total)}*${b.total > state.profile.budget ? ` ⚠️ (budget ${euro(state.profile.budget)})` : ""}\n${basketLine(b)}`);
  return notes.join("\n");
}

function weekSummary(title) {
  const lines = [title, ""];
  for (const d of state.plan.days) {
    lines.push(`*${cap(d.day)}*${d.people !== state.profile.people ? ` (${d.people} pers.)` : ""}`);
    for (const m of d.meals) lines.push(`${m.emoji} ${state.profile.slots.length > 1 ? cap(m.slot) + " : " : ""}${m.name}`);
  }
  const b = basket();
  lines.push("", `🛒 Courses : *${euro(b.total)}* pour ${state.profile.budget ? `un budget de ${euro(state.profile.budget)}` : "la semaine"}`, basketLine(b));
  lines.push("Dis-moi ce qui ne te plaît pas, ou réponds *valide* 👌");
  return lines.join("\n");
}

function shoppingMessage() {
  const b = basket();
  const lines = ["🛒 *Liste de courses*"];
  for (const g of b.byStore) {
    const s = storeById(g.id);
    lines.push("", `${s.emoji} *${s.name}* — ${euro(g.total)}`);
    for (const i of g.items) {
      lines.push(`• ${i.name} — ${i.choice.packs} × ${i.choice.product || i.choice.packLabel || formatQty(i.qty, i.unit)} (${euro(i.choice.price)})${i.choice.promo ? ` 🏷️ ${i.choice.promo}` : ""}`);
    }
  }
  lines.push("", `Total : *${euro(b.total)}*`);
  if (b.saving > 0.5) lines.push(`💸 ${euro(b.saving)} d'économie vs tout chez ${storeById(b.ref).short}`);
  return lines.join("\n");
}

function compareMessage() {
  const b = basket();
  const lines = ["📊 *Comparatif des drives* (panier complet)"];
  for (const s of b.singles) lines.push(`${storeById(s.id).emoji} ${storeById(s.id).short} : ${euro(s.total)}`);
  lines.push("", `✅ Meilleur choix : ${basketLine(b)}`);
  if (b.promos) lines.push(`🏷️ ${b.promos} produit${b.promos > 1 ? "s" : ""} en promo ou en lot`);
  return lines.join("\n");
}

function storeIn(str) {
  return STORES.find((s) => (s.id === "u"
    ? /\b(super ?u|systeme ?u|courses ?u|hyper ?u|magasins? u|chez u)\b/.test(str)
    : new RegExp(`\\b${norm(s.short)}\\b`).test(str)));
}

/* ---------- Mode IA (Claude) ---------- */

const ING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "qty", "unit"],
  properties: { name: { type: "string" }, qty: { type: "number" }, unit: { type: "string", enum: ["g", "ml", "pièce"] } },
};

const AI_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["reply", "budget", "avoidAdd", "forcedStore", "maxStores", "plan", "shopping"],
  properties: {
    reply: { type: "string", description: "Réponse courte façon WhatsApp, en français, formatage *gras* et _italique_ autorisé." },
    budget: { type: "number", description: "Budget hebdo en euros (inchangé sauf demande)." },
    avoidAdd: { type: "array", items: { type: "string" }, description: "Nouveaux ingrédients/aliments à exclure désormais." },
    forcedStore: { type: "string", enum: ["", ...STORES.map((s) => s.id)], description: "Drive imposé par l'utilisateur, vide = meilleur prix (inchangé sauf demande)." },
    maxStores: { type: "integer", description: "Nombre max de drives à faire, 1 à 3 (inchangé sauf demande)." },
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
      type: "array", description: "Une ligne par ingrédient de la semaine (même nom que dans les recettes), avec les offres de chaque drive.",
      items: {
        type: "object", additionalProperties: false, required: ["name", "rayon", "offers"],
        properties: {
          name: { type: "string" },
          rayon: { type: "string", enum: ["Fruits & légumes", "Boucherie", "Poissonnerie", "Frais", "Boulangerie", "Épicerie", "Divers"] },
          offers: {
            type: "array", description: "Meilleure offre de chaque drive pour cet ingrédient (une par drive au plus).",
            items: {
              type: "object", additionalProperties: false, required: ["store", "qty", "unit", "price", "product", "promo", "source"],
              properties: {
                store: { type: "string", enum: STORES.map((s) => s.id) },
                qty: { type: "number", description: "Contenance d'UN article (ou d'un lot entier)." },
                unit: { type: "string", enum: ["g", "ml", "pièce"] },
                price: { type: "number", description: "Prix payé pour UN article/lot en euros, promo immédiate déduite." },
                product: { type: "string", description: "Nom exact du produit, ex. 'Panzani Penne 500g' ou 'Lot 3x Lait demi-écrémé 1L'." },
                promo: { type: "string", description: "Promo ou lot en cours, ex. '2e à -50%', '3 pour 2', '-30% carte fidélité'. Vide si aucune." },
                source: { type: "string", enum: ["site", "estimation"] },
              },
            },
          },
        },
      },
    },
  },
};

function systemPrompt() {
  const stores = enabledStores();
  return `Tu es "Chef", l'assistant repas d'un foyer français, qui discute comme sur WhatsApp.
Ton job : composer les repas de la semaine, ajuster selon les messages ("change mardi", "on sera 4 jeudi", "pas de poisson"), et trouver les courses au meilleur prix entre les drives.
Drives comparés : ${stores.map((s) => `${s.name} (store="${s.id}", ${s.domain})`).join(", ")}.
Règles :
- Respecte le régime, les exclusions, le temps de préparation max et vise le budget hebdo de la liste de courses.
- Ne modifie que ce qui est demandé ; garde le reste du planning identique.
- Les quantités d'ingrédients d'un repas sont totales pour le nombre de personnes du jour.
- Dans "shopping", une ligne par ingrédient utilisé dans la semaine et, pour chaque drive, le produit le plus avantageux : marque distributeur, promo, lot ou grand format si la quantité est utile. Le prix est celui réellement payé (promo immédiate déduite) ; précise dans "promo" si elle exige la carte fidélité.
${state.profile.livePrices ? "- Utilise la recherche web sur les sites des drives pour relever les vrais prix et les promos en cours, en priorité sur les produits les plus chers (viande, poisson, fromage). source=\"site\" pour un prix lu sur le site du drive, \"estimation\" sinon. N'invente jamais une promo." : "- Sans recherche web, donne des prix estimés réalistes (source=\"estimation\") et laisse \"promo\" vide."}
- L'application calcule elle-même le panier optimal (un ou plusieurs drives) à partir de tes offres.
- "reply" : 1 à 6 lignes, chaleureux, emojis bienvenus.`;
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
- Drive imposé : ${p.forcedStore || "aucun (meilleur prix)"}
- Drives max à faire : ${p.maxStores}

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
    params.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 25, allowed_domains: enabledStores().map((s) => s.domain) }];
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
  state.profile.forcedStore = data.forcedStore;
  state.profile.maxStores = Math.max(1, Math.min(3, data.maxStores || state.profile.maxStores));
  state.status = /\bvalid/.test(norm(text)) ? "validated" : "draft";
  const b = basket();
  return `${data.reply}\n\n🛒 *${euro(b.total)}* — ${basketLine(b)}`;
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
  if (!state.plan) {
    el.innerHTML = `<div class="empty"><p>La liste apparaîtra avec ton menu.</p></div>`;
    return;
  }
  const b = basket();
  const chosen = new Set(b.byStore.map((g) => g.id));
  const best = b.singles[0]?.total ?? 0;
  let html = `<section class="compare" aria-label="Comparatif des drives">
    <div class="compare-head"><strong>Comparatif des drives</strong><small>panier complet chez un seul drive</small></div>
    <ul class="drives">${b.singles.map((x) => {
      const st = storeById(x.id);
      const pct = best ? Math.round((x.total / best - 1) * 100) : 0;
      return `<li class="${chosen.has(x.id) ? "on" : ""}">
        <button data-force="${x.id}" title="Tout prendre chez ${st.name}" aria-pressed="${state.profile.forcedStore === x.id}">
          <span>${st.emoji} ${st.short}</span><span>${euro(x.total)}${pct > 0 ? ` <small>+${pct}%</small>` : ""}</span>
        </button></li>`;
    }).join("")}</ul>
    <div class="best">
      <div>✅ <strong>${state.profile.forcedStore ? "Drive choisi" : "Panier optimal"}</strong> : ${b.byStore.map((g) => `${storeById(g.id).short} ${euro(g.total)}`).join(" + ")}</div>
      ${b.saving > 0.5 ? `<div class="saving">💸 ${euro(b.saving)} d'économie vs tout chez ${storeById(b.ref).short}${b.promos ? ` · 🏷️ ${b.promos} promo${b.promos > 1 ? "s" : ""}/lot${b.promos > 1 ? "s" : ""}` : ""}</div>` : ""}
      ${state.profile.forcedStore ? `<button class="btn ghost small-btn" data-force="">Revenir au meilleur prix</button>` : ""}
    </div>
  </section>`;

  for (const g of b.byStore) {
    const st = storeById(g.id);
    html += `<h3 class="store-head"><span>${st.emoji} ${st.name}</span><span>${euro(g.total)}</span></h3><ul class="items">`;
    for (const i of g.items) html += itemRow(i);
    html += "</ul>";
  }
  const home = b.items.filter((i) => state.checked[norm(i.name)]);
  if (home.length) {
    html += `<h3 class="store-head"><span>🏠 Déjà à la maison</span><span></span></h3><ul class="items">${home.map(itemRow).join("")}</ul>`;
  }
  const live = state.aiShopping?.some((x) => x.offers?.some((o) => o.source === "site"));
  html += `<p class="note">${live
    ? "Prix et promos relevés sur les sites des drives par l'IA ; les lignes « estimé » sont des estimations."
    : "Prix estimés (niveau de prix moyen de chaque enseigne). Ajoute ta clé Claude et active « vrais prix » dans Profil pour relever les prix, promos et lots en ligne."}
    Coche ce que tu as déjà : c'est retiré des paniers.</p>`;
  el.innerHTML = html;
}

function itemRow(i) {
  const key = norm(i.name);
  const c = i.choice;
  const others = i.offers.filter((o) => o !== c).sort((a, b) => a.price - b.price).slice(0, 2)
    .map((o) => `${storeById(o.store).short} ${euro(o.price)}`).join(" · ");
  return `<li class="${state.checked[key] ? "done" : ""}">
    <label><input type="checkbox" data-check="${escapeHtml(key)}" ${state.checked[key] ? "checked" : ""} aria-label="Déjà à la maison : ${escapeHtml(i.name)}">
      <span class="item-name">${escapeHtml(i.name)}${c?.promo ? ` <span class="promo">🏷️ ${escapeHtml(c.promo)}</span>` : ""}
        <small>${formatQty(i.qty, i.unit)}${c && (c.product || c.packLabel) ? ` · ${c.packs} × ${escapeHtml(c.product || c.packLabel)}` : ""}</small>
        ${others ? `<small class="others">ailleurs : ${others}</small>` : ""}
      </span>
    </label>
    <span class="price">${c ? euro(c.price) : "—"}<em class="src">${c?.source === "site" ? "prix site" : "estimé"}</em></span>
  </li>`;
}

function renderBar() {
  const b = basket();
  const total = b.total;
  const { budget } = state.profile;
  const pct = budget ? Math.min(100, (total / budget) * 100) : 0;
  $("#total").textContent = euro(total);
  $("#budget").textContent = `/ ${euro(budget)}${b.byStore.length ? " · " + b.byStore.map((g) => storeById(g.id).short).join(" + ") : ""}`;
  const meter = $("#meter > span");
  meter.style.width = pct + "%";
  meter.classList.toggle("over", total > budget);
  const btn = $("#validate");
  btn.disabled = !state.plan;
  btn.textContent = { draft: "Valider la liste", validated: "Remplir les paniers", ordered: "Paniers prêts 🚗" }[state.status];
  btn.classList.toggle("go", state.status !== "draft");
  $("#state-pill").textContent = { draft: "Brouillon", validated: "Validée ✓", ordered: "À aller chercher 🚗" }[state.status];
}

function renderStoreBoxes() {
  $("#stores-box").innerHTML = STORES.map((st) => `<label class="inline"><input type="checkbox" name="stores" value="${st.id}"> ${st.emoji} ${st.name}</label>`).join("");
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
  f.maxStores.value = p.maxStores;
  f.querySelectorAll('input[name="stores"]').forEach((c) => { c.checked = p.stores.includes(c.value); });
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
  const b = basket();
    $("#order-list").innerHTML = b.byStore.map((g) => {
    const st = storeById(g.id);
    return `<section class="order-store ${state.filled[g.id] ? "filled" : ""}">
      <header><strong>${st.emoji} ${st.name}</strong><span>${euro(g.total)}</span></header>
      <ul>${g.items.map((i) => `<li><a href="${st.search(i.choice.product || i.name)}" target="_blank" rel="noopener">
        <span>${escapeHtml(i.choice.product || i.name)} <small>× ${i.choice.packs}</small>${i.choice.promo ? ` <span class="promo">🏷️ ${escapeHtml(i.choice.promo)}</span>` : ""}</span>
        <span>${euro(i.choice.price)} ↗</span></a></li>`).join("")}</ul>
      <button type="button" class="btn ${state.filled[g.id] ? "ghost" : "primary"}" data-filled="${g.id}">${state.filled[g.id] ? "Panier rempli ✓" : `J'ai rempli le panier ${st.short}`}</button>
    </section>`;
  }).join("");
  $("#order-total").textContent = euro(b.total);
  $("#order-done").disabled = !b.byStore.every((g) => state.filled[g.id]);
  if (!$("#order").open) $("#order").showModal();
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
      return;
    }
    if (t.dataset.force !== undefined) {
      state.profile.forcedStore = t.dataset.force === state.profile.forcedStore ? "" : t.dataset.force;
      state.status = "draft";
      save(); renderAll();
      return;
    }
    if (t.dataset.filled) {
      state.filled[t.dataset.filled] = true;
      save(); openOrder();
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
      const b = basket();
      pushMsg("bot", `Top ! Liste validée : *${euro(b.total)}*\n${basketLine(b)}\nJe prépare les paniers 🛒`);
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
    const b = basket();
    pushMsg("bot", `🚗 Paniers prêts : ${b.byStore.map((g) => `${storeById(g.id).name} (${euro(g.total)})`).join(" + ")}.\nTu n'as plus qu'à valider le créneau de retrait et aller chercher. Bon appétit ! Dis *nouvelle semaine* quand tu veux recommencer.`);
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
    const stores = [...f.querySelectorAll('input[name="stores"]:checked')].map((c) => c.value);
    p.stores = stores.length ? stores : [STORES[0].id];
    if (!p.stores.includes(p.forcedStore)) p.forcedStore = "";
    p.maxStores = +f.maxStores.value;
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
  pushMsg("bot", "Salut 👋 Je suis ton *Chef perso*.\nJe prépare tes repas de la semaine, je cherche les courses au meilleur prix entre les drives (promos, lots), je remplis les paniers… et toi tu valides et tu vas chercher 🚗\n\nRéponds *go* ou appuie sur _Préparer ma semaine_ pour commencer !");
}

renderStoreBoxes();
bind();
renderChat();
renderAll();
greet();
let initialView = "chat";
try { initialView = sessionStorage.getItem("view") || "chat"; } catch { /* ignoré */ }
showView(initialView);
