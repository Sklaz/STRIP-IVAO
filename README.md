# E-Strips

E-Strips est un tableau de fiches de vol pour la simulation du contrôle aérien. Il suit le trafic IVAO de l’aérodrome actif et se lance sur ton ordinateur.

## Installation Windows x64

1. Télécharge `E-Strips-Windows.zip` dans la rubrique **Releases** du dépôt GitHub.
2. Clique droit sur le ZIP et choisis **Extraire tout**.
3. Ouvre le dossier extrait et double-clique sur **Lancer E-Strips.cmd**. Garde la fenêtre de lancement ouverte pendant ta session.

Le navigateur s’ouvre sur [E-Strips en local](http://127.0.0.1:4310/). Le ZIP contient Node.js et les dépendances. Une connexion Internet est nécessaire pour recevoir le trafic IVAO et consulter les publications en ligne.

## Installation depuis les sources

Installe [Node.js](https://nodejs.org/en/download) 22.13 ou une version plus récente. Télécharge ou clone le dépôt, puis ouvre un terminal dans le dossier qui contient `package.json`.

```powershell
npm.cmd ci
npm.cmd start
```

Sous macOS ou Linux, utilise `npm ci` puis `npm start`. Ouvre ensuite [E-Strips en local](http://127.0.0.1:4310/).

## Sauvegardes

Garde la même adresse dans ton navigateur pour retrouver tes sauvegardes et ton historique. Pour transférer tes préférences vers un autre ordinateur, ouvre **Paramètres → Profil de configuration**. Le profil contient les baies, les couleurs et les réglages IVAO. L’export de session est disponible séparément pour transférer aussi les fiches et les données de l’aérodrome.

## Assistant ATC

L’horloge locale utilise les coordonnées de l’aérodrome et la bibliothèque embarquée `@photostructure/tz-lookup` 11.7.0 (CC0). Le navigateur applique les règles du fuseau horaire à la date affichée. [Bibliothèque de fuseaux horaires](https://github.com/photostructure/tz-lookup/tree/11.7.0)

**Poser la question** fonctionne sans clé API. L’assistant répond directement aux demandes prises en charge, par exemple « fréquence approche », « altitude de transition », « LDA piste 26 gauche », « liste des approches de précision » ou « QNH et vent ». Il cite la publication et la section dont provient la donnée, ou les cartes correspondantes. Les données de piste et les cartes de l’eAIP du SIA couvrent la France métropolitaine. Les METAR et TAF sont consultés auprès de l’Aviation Weather Center. [eAIP du SIA](https://www.sia.aviation-civile.gouv.fr/produits-numeriques-en-libre-disposition/eaip.html) · [API de l’Aviation Weather Center](https://aviationweather.gov/data/api/)

Pour faire rédiger les réponses sur ton PC, installe Ollama pour Windows et télécharge un modèle, par exemple avec `ollama pull qwen2.5:7b`. Copie `.env.example` vers `.env`, renseigne `OLLAMA_MODEL=qwen2.5:7b` et relance `npm.cmd start`. L’assistant contacte le moteur à l’adresse locale `127.0.0.1:11434`. [Ollama pour Windows](https://docs.ollama.com/windows)

Pour activer la recherche Web sur les sites AIS et IVAO reconnus, renseigne aussi `OPENAI_API_KEY` dans `.env`. Ce service reçoit la question et le code OACI quand une recherche supplémentaire est nécessaire. Si seul OpenAI est configuré, le service reçoit aussi le contexte choisi et les passages utiles pour la synthèse. L’historique reste dans le navigateur, séparé par code OACI. [Recherche Web OpenAI](https://developers.openai.com/api/docs/guides/tools-web-search)

L’assistant charge automatiquement le document associé au bouton **MANEX** de l’aérodrome. Il conserve une copie des MANEX consultés dans `.atc-ai-data/manex`. En cas de coupure réseau, il indique la date de la copie qu’il utilise. [Catalogue IVAO France](https://wiki.ivao.fr/books/manex-aeroports-civils)

Tu peux aussi compléter le MANEX avec des PDF ou extraits TXT dans **Documentation de l’aérodrome**. Indique le lien éditeur et les dates de validité lorsqu’ils figurent dans la publication. La bibliothèque locale est enregistrée dans `.atc-ai-data`. Pour une carte ou un document numérisé, choisis le PDF et le numéro de page dans **Contexte et sources**. Seule cette page est transmise pour l’analyse visuelle. [Entrées PDF OpenAI](https://developers.openai.com/api/docs/guides/file-inputs)

La recherche en ligne consulte une liste de domaines AIS et, pour une demande explicitement IVAO, sa documentation de simulation. L’indexation du Web varie selon les publications. Pour les NOTAM en vigueur, consulte le briefing officiel ou importe un bulletin pertinent et daté. Une date déclarée lors de l’import permet d’afficher un avertissement de validité et ne constitue pas une vérification de la version auprès de l’éditeur. Cet assistant est destiné à la simulation et à l’apprentissage. [SIA France](https://www.sia.aviation-civile.gouv.fr/nousconnaitre) · [Recherche Web OpenAI](https://developers.openai.com/api/docs/guides/tools-web-search)
