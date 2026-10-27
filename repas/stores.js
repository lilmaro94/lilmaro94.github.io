// Drives comparés. `index` = niveau de prix approximatif relatif à Auchan, utilisé seulement
// en mode local quand aucun prix réel n'a été relevé (ordre de grandeur des comparatifs publics).
export const STORES = [
  { id: "leclerc", name: "E.Leclerc Drive", short: "Leclerc", emoji: "🔵", index: 0.95, domain: "e.leclerc",
    search: (q) => `https://www.e.leclerc/recherche?q=${encodeURIComponent(q)}` },
  { id: "auchan", name: "Auchan Drive", short: "Auchan", emoji: "🔴", index: 1.0, domain: "auchan.fr",
    search: (q) => `https://www.auchan.fr/recherche?text=${encodeURIComponent(q)}` },
  { id: "intermarche", name: "Intermarché Drive", short: "Intermarché", emoji: "🟥", index: 1.01, domain: "intermarche.com",
    search: (q) => `https://www.intermarche.com/recherche/${encodeURIComponent(q)}` },
  { id: "u", name: "Courses U", short: "U", emoji: "🟦", index: 1.02, domain: "coursesu.com",
    search: (q) => `https://www.coursesu.com/recherche?q=${encodeURIComponent(q)}` },
  { id: "carrefour", name: "Carrefour Drive", short: "Carrefour", emoji: "🔷", index: 1.04, domain: "carrefour.fr",
    search: (q) => `https://www.carrefour.fr/s?q=${encodeURIComponent(q)}` },
];

export const storeById = (id) => STORES.find((s) => s.id === id);
