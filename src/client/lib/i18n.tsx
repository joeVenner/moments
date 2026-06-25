import { createContext, useContext, useState, type ReactNode } from "react";

export type Lang = "en" | "fr";

type Vars = Record<string, string | number>;
type Entry = string | ((vars: Vars) => string);

const STORAGE_KEY = "moments:lang";

const dict: Record<Lang, Record<string, Entry>> = {
  en: {
    appTagline:
      "Scan a QR code at your event to share photos and videos instantly with everyone there.",
    openAdminPanel: "Open Admin Panel",

    heroHeadline: "Every moment, shared the instant it happens.",
    heroSubhead:
      "One QR code turns your guests' phones into a live photo wall — no app, no sign-up, no waiting.",
    momentsCapturedCounter: (v) => `${v.count} moments captured and counting`,

    featuresHeading: "Built to make every event a little more fun",
    featurePointsTitle: "Gamified points & leaderboard",
    featurePointsBody:
      "Every photo and video earns points, with a live leaderboard crowning the night's top photographer.",
    featureSharingTitle: "Instant photo & video sharing",
    featureSharingBody:
      "Guests capture moments straight from their phone and watch them land in the shared feed in real time.",
    featureScanTitle: "Scan & join instantly",
    featureScanBody:
      "No app to install — scan the event's QR code, pick a name, and start sharing in seconds.",

    adminSignInPrompt: "Sign in to manage events",
    usernamePlaceholder: "Username",
    passwordPlaceholder: "Password",
    incorrectCredentials: "Incorrect username or password",
    serverUnreachable: "Couldn't reach the server — try again",
    signingIn: "Signing in…",
    signIn: "Sign in",

    adminTagline: "Create an event and provision its QR code.",
    logOut: "Log out",
    eventTitlePlaceholder: "Event title (e.g. Sarah & Tom's Wedding)",
    hostsPlaceholder: "Hosts / couple names",
    descriptionPlaceholder: "Description (optional)",
    coverPhotoLabel: "Cover photo (optional)",
    tapToChoosePhoto: "Tap to choose a photo",
    changePhoto: "Change photo",
    removePhoto: "Remove photo",
    creating: "Creating…",
    createEvent: "Create Event",
    failedToCreateEvent: "Failed to create event",
    noEventsYet: "No events yet — create one above.",
    viewDetails: "View details",
    hideDetails: "Hide details",
    collectedMoments: "Collected Moments",

    momentsCollected: (v) =>
      Number(v.count) === 1
        ? "{count} moment collected · {points} points total"
        : "{count} moments collected · {points} points total",
    noMomentsCollected: "No moments collected yet.",

    downloadQr: "Download QR",

    enterNameToJoin: "Enter your name to join",
    joinTheFeed: "Join the Feed",

    filesSelected: (v) =>
      Number(v.count) === 1 ? "{count} file selected" : "{count} files selected",
    tapToChoose: "Tap to capture or choose photos/videos",
    uploadHint: "JPG, PNG, MP4 — up to 25MB each",
    addCaptionPlaceholder: "Add a caption (optional)",
    removeFile: "Remove {name}",
    optimizing: "Optimizing…",
    uploading: "Uploading…",
    shareMoment: (v) => (Number(v.count) > 1 ? "Share {count} Moments" : "Share Moment"),

    eventNotFound: "Event not found.",
    greetingName: "Hi {name}",
    yourPoints: "Your points:",
    noMomentsYetBeFirst: "No moments yet — be the first to share one!",
    uploadFailed: "Failed to upload {failed} of {total} file(s)",
    pointsAdded: (v) =>
      Number(v.points) === 1 ? "+{points} Point Added!" : "+{points} Points Added!",
    milestoneReached: "Milestone!",
    milestonePointsReached: "{points} points reached!",

    livePreview: "Live Preview",
    livePreviewSubtitle: "What guests will see",
    previewPlaceholderTitle: "Your Event Title",
    previewPlaceholderHosts: "Hosts' names",

    chooseAvatar: "Choose your avatar",
    shuffleAvatar: "Shuffle",

    participantsJoined: (v) =>
      Number(v.count) === 1 ? "{count} person here" : "{count} people here",

    feedTab: "Feed",
    leaderboardTab: "Leaderboard",
    topPhotographers: "Top Photographers",
    momentsLabel: (v) => (Number(v.count) === 1 ? "{count} moment" : "{count} moments"),
    ptsLabel: "pts",
    noLeaderboardYet: "No one's uploaded yet — be the first!",
    winnerAnnouncement: "{name} is leading the pack!",

    aiSelfiePrompt: "Share a selfie of the happy couple — we'll turn it into a custom banner",
    generateAiBanner: "Generate AI Banner",
    generatingBanner: "Generating your banner…",
    aiBannerUnavailable: "AI banner generation isn't set up yet — using your photo as the cover instead.",
    aiBannerFailed: "Couldn't generate an AI banner — using your photo as the cover instead.",
    selfieTooLarge: "Image too large — please choose a photo under 8MB",
    bannerThemePlaceholder: "Theme (e.g. rustic garden, neon city)",
  },
  fr: {
    appTagline:
      "Scannez un QR code sur place pour partager photos et vidéos instantanément avec tout le monde.",
    openAdminPanel: "Ouvrir le panneau admin",

    heroHeadline: "Chaque instant, partagé dès qu'il se produit.",
    heroSubhead:
      "Un seul QR code transforme les téléphones de vos invités en mur de photos en direct — sans application, sans inscription, sans attente.",
    momentsCapturedCounter: (v) => `${v.count} souvenirs capturés et ça continue`,

    featuresHeading: "Pensé pour rendre chaque événement un peu plus amusant",
    featurePointsTitle: "Points ludiques & classement",
    featurePointsBody:
      "Chaque photo et vidéo rapporte des points, avec un classement en direct qui couronne le meilleur photographe de la soirée.",
    featureSharingTitle: "Partage instantané de photos et vidéos",
    featureSharingBody:
      "Les invités capturent l'instant depuis leur téléphone et le voient apparaître dans le fil partagé en temps réel.",
    featureScanTitle: "Scanner et rejoindre instantanément",
    featureScanBody:
      "Aucune application à installer — scannez le QR code de l'événement, choisissez un nom et commencez à partager en quelques secondes.",

    adminSignInPrompt: "Connectez-vous pour gérer les événements",
    usernamePlaceholder: "Identifiant",
    passwordPlaceholder: "Mot de passe",
    incorrectCredentials: "Identifiant ou mot de passe incorrect",
    serverUnreachable: "Impossible de contacter le serveur — réessayez",
    signingIn: "Connexion…",
    signIn: "Se connecter",

    adminTagline: "Créez un événement et générez son QR code.",
    logOut: "Déconnexion",
    eventTitlePlaceholder: "Titre de l'événement (ex. Mariage de Sarah & Tom)",
    hostsPlaceholder: "Noms des hôtes / des mariés",
    descriptionPlaceholder: "Description (optionnel)",
    coverPhotoLabel: "Photo de couverture (optionnel)",
    tapToChoosePhoto: "Appuyez pour choisir une photo",
    changePhoto: "Changer de photo",
    removePhoto: "Retirer la photo",
    creating: "Création…",
    createEvent: "Créer l'événement",
    failedToCreateEvent: "Échec de la création de l'événement",
    noEventsYet: "Aucun événement pour l'instant — créez-en un ci-dessus.",
    viewDetails: "Voir les détails",
    hideDetails: "Masquer les détails",
    collectedMoments: "Souvenirs collectés",

    momentsCollected: (v) =>
      Number(v.count) === 1
        ? "{count} souvenir collecté · {points} points au total"
        : "{count} souvenirs collectés · {points} points au total",
    noMomentsCollected: "Aucun souvenir collecté pour l'instant.",

    downloadQr: "Télécharger le QR code",

    enterNameToJoin: "Entrez votre nom pour participer",
    joinTheFeed: "Rejoindre le fil",

    filesSelected: (v) =>
      Number(v.count) === 1 ? "{count} fichier sélectionné" : "{count} fichiers sélectionnés",
    tapToChoose: "Appuyez pour prendre ou choisir des photos/vidéos",
    uploadHint: "JPG, PNG, MP4 — jusqu'à 25 Mo chacun",
    addCaptionPlaceholder: "Ajouter une légende (optionnel)",
    removeFile: "Retirer {name}",
    optimizing: "Optimisation…",
    uploading: "Envoi en cours…",
    shareMoment: (v) =>
      Number(v.count) > 1 ? "Partager {count} souvenirs" : "Partager ce souvenir",

    eventNotFound: "Événement introuvable.",
    greetingName: "Salut {name}",
    yourPoints: "Tes points :",
    noMomentsYetBeFirst: "Aucun souvenir pour l'instant — soyez le premier à en partager un !",
    uploadFailed: "Échec de l'envoi de {failed} fichier(s) sur {total}",
    pointsAdded: (v) =>
      Number(v.points) === 1 ? "+{points} point ajouté !" : "+{points} points ajoutés !",
    milestoneReached: "Étape franchie !",
    milestonePointsReached: "{points} points atteints !",

    livePreview: "Aperçu en direct",
    livePreviewSubtitle: "Ce que verront les invités",
    previewPlaceholderTitle: "Le titre de votre événement",
    previewPlaceholderHosts: "Noms des hôtes",

    chooseAvatar: "Choisissez votre avatar",
    shuffleAvatar: "Changer",

    participantsJoined: (v) =>
      Number(v.count) === 1 ? "{count} personne ici" : "{count} personnes ici",

    feedTab: "Fil",
    leaderboardTab: "Classement",
    topPhotographers: "Meilleurs photographes",
    momentsLabel: (v) => (Number(v.count) === 1 ? "{count} souvenir" : "{count} souvenirs"),
    ptsLabel: "pts",
    noLeaderboardYet: "Personne n'a encore partagé — soyez le premier !",
    winnerAnnouncement: "{name} est en tête !",

    aiSelfiePrompt: "Partagez un selfie des mariés — on en fait une bannière sur mesure",
    generateAiBanner: "Générer la bannière IA",
    generatingBanner: "Génération de votre bannière…",
    aiBannerUnavailable: "La génération IA n'est pas encore configurée — votre photo sera utilisée comme couverture.",
    aiBannerFailed: "Impossible de générer la bannière IA — votre photo sera utilisée comme couverture.",
    selfieTooLarge: "Image trop volumineuse — choisissez une photo de moins de 8 Mo",
    bannerThemePlaceholder: "Thème (ex. jardin champêtre, ville néon)",
  },
};

export const quotes: Record<Lang, string[]> = {
  en: [
    "Every great photographer was once an amateur with great friends.",
    "The best photos happen when no one's posing.",
    "Behind every great shot is someone who almost missed the moment.",
    "Capturing memories, one tap at a time.",
    "The real award is the chaos you documented.",
  ],
  fr: [
    "Tout grand photographe a d'abord été un amateur entouré d'amis formidables.",
    "Les meilleures photos arrivent quand personne ne pose.",
    "Derrière chaque beau souvenir, quelqu'un a failli rater l'instant.",
    "Capturer des souvenirs, un instant à la fois.",
    "Le vrai trophée, c'est le chaos que vous avez immortalisé.",
  ],
};

export function randomQuote(lang: Lang): string {
  const list = quotes[lang];
  return list[Math.floor(Math.random() * list.length)];
}

const eventTypeLabels: Record<Lang, Record<string, string>> = {
  en: { Wedding: "Wedding", Gala: "Gala", Birthday: "Birthday", Corporate: "Corporate", Other: "Other" },
  fr: { Wedding: "Mariage", Gala: "Gala", Birthday: "Anniversaire", Corporate: "Entreprise", Other: "Autre" },
};

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ""));
}

function detectInitialLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "fr") return stored;
  return navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, vars?: Vars) => string;
  eventTypeLabel: (type: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  function setLang(next: Lang) {
    localStorage.setItem(STORAGE_KEY, next);
    setLangState(next);
  }

  function t(key: string, vars?: Vars): string {
    const entry = dict[lang][key] ?? dict.en[key] ?? key;
    const template = typeof entry === "function" ? entry(vars ?? {}) : entry;
    return interpolate(template, vars);
  }

  function eventTypeLabel(type: string): string {
    return eventTypeLabels[lang][type] ?? type;
  }

  return (
    <I18nContext.Provider value={{ lang, setLang, t, eventTypeLabel }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
