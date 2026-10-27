# lilmaro94.github.io
Hebergement de la cle publique Tesla Fleet API pour Home Assistant

## Mon HelloFresh perso — `/repas/`

https://lilmaro94.github.io/repas/

Un chef IA qui prépare les repas de la semaine, cherche les courses au meilleur prix entre les drives
(promos, lots), prépare un panier par drive… et toi tu valides et tu vas chercher.
On lui répond comme sur WhatsApp : « change mardi, on sera 4 jeudi ».

- **Discussion** façon WhatsApp : `change mardi`, `on sera 4 jeudi`, `pas de poisson`,
  `mets des tacos vendredi`, `budget 60`, `compare les drives`, `que chez Leclerc`, `pas de Carrefour`,
  `2 drives max`, `valide`…
- **Semaine** : 7 jours, midi et/ou soir, nombre de personnes par jour, bouton 🔄 par repas.
- **Courses multi-drives** : E.Leclerc, Auchan, Intermarché, Courses U, Carrefour. Comparatif du panier
  complet par drive, puis **panier optimal** sur 1 à 3 drives (un 2e drive n'est retenu que s'il fait
  gagner au moins 3 €), promos et lots signalés, « ailleurs : … » pour chaque produit.
- **Valider → Remplir les paniers** : un panier par drive avec un lien vers chaque produit,
  « panier rempli » drive par drive, puis « Tout est prêt 🚗 » (à aller chercher).
  Envoi du menu et des courses sur WhatsApp.
- **Profil** : foyer, budget, régime, temps max, goûts, exclusions, drives à comparer, nombre de drives max.

Sans clé, un moteur local (27 recettes) comprend les commandes simples. Les prix sont alors **estimés**
(prix moyens + niveau de prix approximatif de chaque enseigne) : pas de promo, et toujours un seul drive.
Avec une clé API Anthropic (Profil → Chef IA), Claude comprend n'importe quelle demande et, avec
« vrais prix », relève les prix, promos et lots sur les sites des drives via la recherche web.
La clé reste dans le navigateur.

Prochaine étape (côté serveur) : un agent connecté aux comptes drive qui remplit les paniers tout seul,
et l'API WhatsApp Business pour discuter avec le chef directement dans WhatsApp.
