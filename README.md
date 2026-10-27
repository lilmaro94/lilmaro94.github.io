# lilmaro94.github.io
Hebergement de la cle publique Tesla Fleet API pour Home Assistant

## Mon HelloFresh perso — `/repas/`

https://lilmaro94.github.io/repas/

Un chef IA qui prépare les repas de la semaine, fait la liste de courses aux prix Auchan,
et à qui on répond comme sur WhatsApp : « change mardi, on sera 4 jeudi ».

- **Discussion** façon WhatsApp : `change mardi`, `on sera 4 jeudi`, `pas de poisson`,
  `mets des tacos vendredi`, `budget 60`, `valide`…
- **Semaine** : 7 jours, midi et/ou soir, nombre de personnes par jour, bouton 🔄 par repas.
- **Courses** : liste agrégée par rayon, arrondie aux paquets du commerce, total vs budget.
- **Valider → Commander** : lien auchan.fr pour chaque produit, copie de la liste, envoi sur WhatsApp.
- **Profil** : foyer, budget, régime, temps max, goûts, exclusions.

Sans clé, un moteur local (27 recettes, prix moyens Auchan) comprend les commandes simples.
Avec une clé API Anthropic (Profil → Chef IA), Claude comprend n'importe quelle demande et peut
relever les vrais prix sur auchan.fr via la recherche web. La clé reste dans le navigateur.

Prochaine étape : un agent côté serveur connecté au compte Auchan et à l'API WhatsApp Business
pour remplir le panier tout seul après validation.
