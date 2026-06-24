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
    pointsAdded: "+{points} Points Added!",
  },
  fr: {
    appTagline:
      "Scannez un QR code sur place pour partager photos et vidéos instantanément avec tout le monde.",
    openAdminPanel: "Ouvrir le panneau admin",

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
    pointsAdded: "+{points} points ajoutés !",
  },
};

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
