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
    momentsCapturedLabel: "moments captured and counting",
    eventCodePlaceholder: "Enter your event code",
    joinEvent: "Join",

    featuresEyebrow: "Everything in one place",
    featuresHeading: "More than a shared photo album",
    featuresIntro: "From the first scan to the final download, Moments keeps the event live, private when needed, and easy to manage.",
    featureSlideshowTitle: "Live event slideshow",
    featureSlideshowBody: "Turn any screen into a live gallery that refreshes as guests share new photos and videos.",
    featurePrivacyTitle: "Public or private events",
    featurePrivacyBody: "Open the gallery to everyone, or protect it with a PIN and a private invitation link.",
    featureResumableTitle: "Uploads that recover",
    featureResumableBody: "Large uploads are queued, retried, and resumed after weak connections or interruptions.",
    featureHighlightsTitle: "Reactions & highlights",
    featureHighlightsBody: "Guests can favorite the best moments while a highlights view brings the crowd's picks together.",
    featureExportTitle: "Download the whole story",
    featureExportBody: "Export the complete album—or only selected moments—as an organized ZIP file.",
    featureControlTitle: "Moderation & insights",
    featureControlBody: "Hide or remove content, track activity and storage, and control event retention from one dashboard.",
    contactUsShort: "Planning an event? Contact us",
    contactEyebrow: "Your event, your space",
    contactTitle: "Have something coming up?",
    contactBody: "Contact us and we'll create a Moments experience tailored to your wedding, celebration, launch, or gathering.",
    contactWhatsApp: "Contact us on WhatsApp",
    faqEyebrow: "Questions, answered",
    faqHeading: "How event photo sharing works",
    faqIntro: "The essentials hosts and guests need to know before the event starts.",
    faqWhatQuestion: "What is Moments?",
    faqWhatAnswer: "Moments is a browser-based event gallery. Hosts share one QR code, and guests use it to upload photos and videos into the same live feed.",
    faqAppQuestion: "Do guests need to install an app or create an account?",
    faqAppAnswer: "No. Guests scan the QR code, choose a display name, and share directly from their phone's browser.",
    faqPrivateQuestion: "Can an event gallery be private?",
    faqPrivateAnswer: "Yes. Hosts can choose a public gallery or require a PIN and private invitation link before anyone can view or upload moments.",
    faqUploadQuestion: "What happens if an upload is interrupted?",
    faqUploadAnswer: "Large uploads are saved to a queue, retried automatically, and resumed when a usable connection returns.",
    faqDownloadQuestion: "Can hosts download the event album?",
    faqDownloadAnswer: "Yes. Hosts can export the complete album or selected photos and videos as an organized ZIP file.",
    featuresHeadingLegacy: "Built to make every event a little more fun",
    featurePointsTitle: "Gamified points & leaderboard",
    featurePointsBody:
      "Every photo and video earns points, with a live leaderboard crowning the night's top photographer.",
    featureSharingTitle: "Instant photo & video sharing",
    featureSharingBody:
      "Guests capture moments straight from their phone and watch them land in the shared feed in real time.",
    featureScanTitle: "Scan & join instantly",
    featureScanBody:
      "No app to install — scan the event's QR code, pick a name, and start sharing in seconds.",

    marqueeHeading: "A glimpse of the night",
    momentCaptionFirstDance: "First dance",
    momentCaptionToast: "The toast",
    momentCaptionCake: "Cutting the cake",
    momentCaptionDanceFloor: "On the dance floor",
    momentCaptionGoldenHour: "Golden hour",
    momentCaptionSpeeches: "Speeches & laughs",

    adminSignInPrompt: "Sign in to manage events",
    usernamePlaceholder: "Username",
    passwordPlaceholder: "Password",
    incorrectCredentials: "Incorrect username or password",
    adminLoginLocked: "Too many attempts. Try again in 15 minutes.",
    serverUnreachable: "Couldn't reach the server — try again",
    signingIn: "Signing in…",
    signIn: "Sign in",

    adminTagline: "Create an event and provision its QR code.",
    startWithTemplate: "Start with an event template",
    templateHint: "Pre-fill the theme, description, and sensible media retention.",
    templateWedding: "Wedding",
    templateWeddingDescription: "Share every candid moment from the ceremony through the last dance.",
    templateWeddingTheme: "warm candlelight, elegant paper, pearl details",
    templateBirthday: "Birthday",
    templateBirthdayDescription: "Collect the surprises, cake, speeches, and dance-floor moments in one place.",
    templateBirthdayTheme: "warm celebration lights, cake, restrained confetti",
    templateGraduation: "Graduation",
    templateGraduationDescription: "Celebrate the milestone with portraits, proud families, and the moments between ceremonies.",
    templateGraduationTheme: "golden achievement, editorial portraits, subtle stars",
    templateCorporate: "Corporate",
    templateCorporateDescription: "A polished shared gallery for teams, launches, conferences, and awards.",
    templateCorporateTheme: "modern graphite, stage lighting, clean editorial lines",
    templateParty: "Party",
    templatePartyDescription: "A fast live feed for the best arrivals, music, friends, and late-night moments.",
    templatePartyTheme: "night photography, warm neon, energetic movement",
    logOut: "Log out",
    eventTitlePlaceholder: "Event title (e.g. Sarah & Tom's Wedding)",
    hostsPlaceholder: "Hosts / couple names",
    descriptionPlaceholder: "Description (optional)",
    eventExpiryOptional: "Automatic archive date (optional)",
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
    momentsSelected: "{count} selected",
    selectMoment: "Select",
    approveMoments: "Restore",
    hideMoments: "Hide",
    deleteMoments: "Delete",
    hiddenMoment: "Hidden",
    restoreMoment: "Restore",
    hideMoment: "Hide",
    deleteMoment: "Delete",
    downloadSelected: "Download selected",
    downloadAlbum: "Download full album",
    confirmDeleteMoments: "Permanently delete {count} selected moment(s) and their media?",
    eventRetention: "Retention & storage",
    expiresOn: "Archive automatically after",
    saveRetention: "Save",
    archiveNow: "Archive now",
    confirmArchiveEvent: "Archive this event now and permanently delete its stored media?",
    retentionHint: "Archiving removes event media from storage and closes the public event. Leave the date empty to keep it indefinitely.",
    eventPrivacy: "Privacy & invitations",
    publicEvent: "Public event",
    privateEvent: "Private event",
    privateEventHint: "Enter the event PIN or open the private invitation link from the host.",
    eventPin: "Event PIN",
    incorrectEventPin: "That PIN or invitation is not valid.",
    unlockingEvent: "Unlocking…",
    unlockEvent: "Open event",
    newPinOptional: "New PIN (optional)",
    newPinRevokesAccess: "Saving a new PIN signs every guest out and replaces the invitation link.",
    pinLengthHint: "Use 6 to 20 characters.",
    savePrivacy: "Save privacy",
    copyPrivateInvite: "Copy private invitation link",
    eventAnalytics: "Event analytics",
    analyticsMoments: "Moments",
    analyticsGuests: "Guests",
    analyticsReactions: "Favorites",
    analyticsStorage: "Storage",
    last14Days: "Uploads — last 14 days",
    noActivityYet: "No upload activity yet",
    analyticsBreakdown: "{photos} photos · {videos} videos · {hidden} hidden",

    downloadQr: "Download QR",
    printFlyer: "Print Flyer",
    flyerCta: "Caught the moment?",
    flyerCtaSubline: "Scan & show us what you captured!",
    flyerInstruction: "Scan the code above to join the feed and share your photos & videos.",
    flyerStyleLabel: "Flyer style",
    flyerStyleEditorial: "Editorial",
    flyerStylePoster: "Poster",
    flyerStyleDark: "Dark",
    flyerStyleLeaves: "Leaves",
    flyerStyleCelebration: "Celebration",

    enterNameToJoin: "Enter your name to join",
    joinTheFeed: "Join the Feed",
    joinRateLimited: "Too many people are joining from this network. Try again in a minute.",
    joinNicknameTaken: "This nickname is already taken in this event. Pick another one.",
    joinEventFull: "This event is full: it has as many guests as its host's plan allows.",
    joinAgain: "You're no longer joined to this event on this device. Pick a nickname to join again.",

    filesSelected: (v) =>
      Number(v.count) === 1 ? "{count} file selected" : "{count} files selected",
    tapToChoose: "Tap to capture or choose photos/videos",
    uploadHint: "Photos & videos up to 512MB — interrupted uploads resume automatically",
    addCaptionPlaceholder: "Add a caption (optional)",
    removeFile: "Remove {name}",
    optimizing: "Optimizing…",
    uploading: "Uploading…",
    shareMoment: (v) => (Number(v.count) > 1 ? "Share {count} Moments" : "Share Moment"),
    uploadPaused: "“{name}” is safely queued and will resume automatically",
    uploadManagerTitle: "Uploads",
    uploadStatus_queued: "Queued",
    uploadStatus_uploading: "Uploading",
    uploadStatus_paused: "Paused",
    uploadStatus_retrying: "Retrying",
    uploadStatus_completed: "Completed",
    uploadStatus_failed: "Failed",
    retryUpload: "Retry",
    cancelUpload: "Cancel",
    dismissUpload: "Dismiss",
    clearCompleted: "Clear completed",
    allUploadsComplete: "Everything is uploaded",
    uploadsSafeHint: "These moments are safely stored in the event gallery.",

    eventNotFound: "Event not found.",
    eventNotHosted: "This event is no longer hosted.",
    greetingName: "Hi {name}",
    yourPoints: "Your points:",
    leaveEvent: "Leave",
    leaveEventTitle: "Leave this event?",
    leaveEventBody:
      "The photos and videos you shared from this browser are deleted and your nickname is freed. This can't be undone.",
    leaveEventConfirm: "Leave and delete",
    leaveEventCancel: "Cancel",
    leaveEventLeaving: "Deleting…",
    leaveEventFailed: "Couldn't finish leaving. Some of what you shared may already be deleted; try again to finish.",
    leaveEventRateLimited: "Too many tries. Wait a moment, then try again.",
    noMomentsYetBeFirst: "No moments yet — be the first to share one!",
    uploadFailed: "Failed to upload {failed} of {total} file(s)",
    filesTooLarge: "{skipped} file(s) too large (max {maxMb}MB) and were skipped",
    loadMore: "Load more",
    loadingMore: "Loading…",
    endOfFeed: "You're all caught up",
    pagePrev: "Previous page",
    pageNext: "Next page",
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
    highlightsTab: "Highlights",
    noHighlightsYet: "Favorite moments will appear here.",
    openSlideshow: "Open live slideshow",
    liveSlideshow: "Live slideshow",
    pauseSlideshow: "Stop",
    resumeSlideshow: "Resume",
    fullscreen: "Fullscreen",
    closeSlideshow: "Back",
    slideshowWaiting: "Waiting for the first moment to arrive…",
    slideshowLoading: "Loading the slideshow…",
    slideshowRetrying: "Can't reach Moments right now. Trying again…",
    videoMoment: "Video moment",
    sharedBy: "Shared by {name}",
    previousMoment: "Previous moment",
    nextMoment: "Next moment",
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
    bannerProgressHint: "This usually takes about 45 seconds — hang tight.",
    bannerFallbackHeading: "Or pick a ready-made banner",
    bannerReviewHeading: "Review your banner — confirm or regenerate",
    bannerReviewAlt: "Generated event banner preview",
    confirmBanner: "Confirm",
    regenerateBanner: "Regenerate",
    sampleGolden: "Golden Hour",
    sampleBlush: "Blush",
    sampleMidnight: "Midnight",
    sampleSunset: "Sunset",
    sampleForest: "Forest",
    sampleConfetti: "Confetti",
    bannerWedding: "Wedding",
    bannerGala: "Gala",
    bannerBirthday: "Birthday",
    bannerCorporate: "Corporate",
    bannerGraduation: "Graduation",
    bannerParty: "Party",
    bannerOther: "Other",

    footerTagline: "Made for moments worth sharing.",
    footerPrivacy: "Privacy",
    footerTerms: "Terms",
  },
  fr: {
    appTagline:
      "Scannez un QR code sur place pour partager photos et vidéos instantanément avec tout le monde.",
    openAdminPanel: "Ouvrir le panneau admin",

    heroHeadline: "Chaque instant, partagé dès qu'il se produit.",
    heroSubhead:
      "Un seul QR code transforme les téléphones de vos invités en mur de photos en direct — sans application, sans inscription, sans attente.",
    momentsCapturedCounter: (v) => `${v.count} souvenirs capturés et ça continue`,
    momentsCapturedLabel: "souvenirs capturés et ça continue",
    eventCodePlaceholder: "Entrez votre code événement",
    joinEvent: "Rejoindre",

    featuresEyebrow: "Tout au même endroit",
    featuresHeading: "Bien plus qu'un album photo partagé",
    featuresIntro: "Du premier scan au téléchargement final, Moments garde votre événement vivant, privé si nécessaire et simple à gérer.",
    featureSlideshowTitle: "Diaporama en direct",
    featureSlideshowBody: "Transformez n'importe quel écran en galerie en direct, actualisée à mesure que les invités partagent leurs photos et vidéos.",
    featurePrivacyTitle: "Événement public ou privé",
    featurePrivacyBody: "Ouvrez la galerie à tous ou protégez-la avec un code et un lien d'invitation privé.",
    featureResumableTitle: "Envois qui reprennent",
    featureResumableBody: "Les fichiers volumineux sont mis en attente, réessayés et repris après une coupure ou une connexion faible.",
    featureHighlightsTitle: "Réactions et favoris",
    featureHighlightsBody: "Les invités aiment leurs meilleurs souvenirs et la vue Favoris rassemble les choix du public.",
    featureExportTitle: "Téléchargez toute l'histoire",
    featureExportBody: "Exportez l'album complet — ou seulement une sélection — dans un fichier ZIP organisé.",
    featureControlTitle: "Modération et statistiques",
    featureControlBody: "Masquez du contenu, suivez l'activité et le stockage, puis gérez la conservation depuis un seul tableau de bord.",
    contactUsShort: "Un événement en vue ? Contactez-nous",
    contactEyebrow: "Votre événement, votre espace",
    contactTitle: "Vous préparez quelque chose ?",
    contactBody: "Contactez-nous et nous créerons une expérience Moments adaptée à votre mariage, célébration, lancement ou rencontre.",
    contactWhatsApp: "Nous contacter sur WhatsApp",
    faqEyebrow: "Vos questions, nos réponses",
    faqHeading: "Comment fonctionne le partage de photos d'événement",
    faqIntro: "L'essentiel à connaître pour les hôtes et les invités avant le début de l'événement.",
    faqWhatQuestion: "Qu'est-ce que Moments ?",
    faqWhatAnswer: "Moments est une galerie d'événement accessible depuis le navigateur. L'hôte partage un QR code et les invités y ajoutent leurs photos et vidéos dans un fil commun en direct.",
    faqAppQuestion: "Les invités doivent-ils installer une application ou créer un compte ?",
    faqAppAnswer: "Non. Ils scannent le QR code, choisissent un nom et partagent directement depuis le navigateur de leur téléphone.",
    faqPrivateQuestion: "La galerie d'un événement peut-elle être privée ?",
    faqPrivateAnswer: "Oui. L'hôte peut ouvrir la galerie à tous ou demander un code et un lien d'invitation privé avant d'autoriser l'accès.",
    faqUploadQuestion: "Que se passe-t-il si un envoi est interrompu ?",
    faqUploadAnswer: "Les fichiers volumineux restent dans une file d'attente, sont réessayés automatiquement et reprennent dès qu'une connexion utilisable revient.",
    faqDownloadQuestion: "L'hôte peut-il télécharger l'album de l'événement ?",
    faqDownloadAnswer: "Oui. Il peut exporter l'album complet ou une sélection de photos et vidéos dans un fichier ZIP organisé.",
    featuresHeadingLegacy: "Pensé pour rendre chaque événement un peu plus amusant",
    featurePointsTitle: "Points ludiques & classement",
    featurePointsBody:
      "Chaque photo et vidéo rapporte des points, avec un classement en direct qui couronne le meilleur photographe de la soirée.",
    featureSharingTitle: "Partage instantané de photos et vidéos",
    featureSharingBody:
      "Les invités capturent l'instant depuis leur téléphone et le voient apparaître dans le fil partagé en temps réel.",
    featureScanTitle: "Scanner et rejoindre instantanément",
    featureScanBody:
      "Aucune application à installer — scannez le QR code de l'événement, choisissez un nom et commencez à partager en quelques secondes.",

    marqueeHeading: "Un aperçu de la soirée",
    momentCaptionFirstDance: "Première danse",
    momentCaptionToast: "Le toast",
    momentCaptionCake: "La pièce montée",
    momentCaptionDanceFloor: "Sur la piste",
    momentCaptionGoldenHour: "L'heure dorée",
    momentCaptionSpeeches: "Discours & rires",

    adminSignInPrompt: "Connectez-vous pour gérer les événements",
    usernamePlaceholder: "Identifiant",
    passwordPlaceholder: "Mot de passe",
    incorrectCredentials: "Identifiant ou mot de passe incorrect",
    adminLoginLocked: "Trop de tentatives. Réessayez dans 15 minutes.",
    serverUnreachable: "Impossible de contacter le serveur — réessayez",
    signingIn: "Connexion…",
    signIn: "Se connecter",

    adminTagline: "Créez un événement et générez son QR code.",
    startWithTemplate: "Commencer avec un modèle d'événement",
    templateHint: "Préremplissez le thème, la description et une durée de conservation adaptée.",
    templateWedding: "Mariage",
    templateWeddingDescription: "Partagez chaque instant spontané, de la cérémonie jusqu'à la dernière danse.",
    templateWeddingTheme: "lumière chaude des bougies, papier élégant, détails nacrés",
    templateBirthday: "Anniversaire",
    templateBirthdayDescription: "Rassemblez les surprises, le gâteau, les discours et les moments sur la piste.",
    templateBirthdayTheme: "lumières de fête chaleureuses, gâteau, confettis discrets",
    templateGraduation: "Remise de diplômes",
    templateGraduationDescription: "Célébrez cette étape avec les portraits, les familles fières et les instants entre les cérémonies.",
    templateGraduationTheme: "réussite dorée, portraits éditoriaux, étoiles subtiles",
    templateCorporate: "Entreprise",
    templateCorporateDescription: "Une galerie partagée soignée pour les équipes, lancements, conférences et récompenses.",
    templateCorporateTheme: "graphite moderne, éclairage de scène, lignes éditoriales épurées",
    templateParty: "Soirée",
    templatePartyDescription: "Un fil en direct pour les arrivées, la musique, les amis et les meilleurs moments de la nuit.",
    templatePartyTheme: "photo de nuit, néons chauds, mouvement énergique",
    logOut: "Déconnexion",
    eventTitlePlaceholder: "Titre de l'événement (ex. Mariage de Sarah & Tom)",
    hostsPlaceholder: "Noms des hôtes / des mariés",
    descriptionPlaceholder: "Description (optionnel)",
    eventExpiryOptional: "Date d'archivage automatique (optionnel)",
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
    momentsSelected: "{count} sélectionné(s)",
    selectMoment: "Sélectionner",
    approveMoments: "Restaurer",
    hideMoments: "Masquer",
    deleteMoments: "Supprimer",
    hiddenMoment: "Masqué",
    restoreMoment: "Restaurer",
    hideMoment: "Masquer",
    deleteMoment: "Supprimer",
    downloadSelected: "Télécharger la sélection",
    downloadAlbum: "Télécharger l'album complet",
    confirmDeleteMoments: "Supprimer définitivement {count} souvenir(s) et leurs médias ?",
    eventRetention: "Conservation et stockage",
    expiresOn: "Archiver automatiquement après le",
    saveRetention: "Enregistrer",
    archiveNow: "Archiver maintenant",
    confirmArchiveEvent: "Archiver cet événement maintenant et supprimer définitivement ses médias ?",
    retentionHint: "L'archivage supprime les médias stockés et ferme l'événement public. Laissez la date vide pour le conserver indéfiniment.",
    eventPrivacy: "Confidentialité et invitations",
    publicEvent: "Événement public",
    privateEvent: "Événement privé",
    privateEventHint: "Entrez le code de l'événement ou ouvrez le lien d'invitation privé envoyé par l'hôte.",
    eventPin: "Code de l'événement",
    incorrectEventPin: "Ce code ou cette invitation n'est pas valide.",
    unlockingEvent: "Ouverture…",
    unlockEvent: "Ouvrir l'événement",
    newPinOptional: "Nouveau code (optionnel)",
    newPinRevokesAccess: "Un nouveau code déconnecte tous les invités et remplace le lien d'invitation.",
    pinLengthHint: "Utilisez 6 à 20 caractères.",
    savePrivacy: "Enregistrer la confidentialité",
    copyPrivateInvite: "Copier le lien d'invitation privé",
    eventAnalytics: "Statistiques de l'événement",
    analyticsMoments: "Souvenirs",
    analyticsGuests: "Invités",
    analyticsReactions: "Favoris",
    analyticsStorage: "Stockage",
    last14Days: "Envois — 14 derniers jours",
    noActivityYet: "Aucune activité d'envoi",
    analyticsBreakdown: "{photos} photos · {videos} vidéos · {hidden} masqués",

    downloadQr: "Télécharger le QR code",
    printFlyer: "Imprimer l'affiche",
    flyerCta: "Instant capturé ?",
    flyerCtaSubline: "Scannez et montrez-nous ce que vous avez capturé !",
    flyerInstruction:
      "Scannez le code ci-dessus pour rejoindre le fil et partager vos photos et vidéos.",
    flyerStyleLabel: "Style de l'affiche",
    flyerStyleEditorial: "Éditorial",
    flyerStylePoster: "Poster",
    flyerStyleDark: "Sombre",
    flyerStyleLeaves: "Feuilles",
    flyerStyleCelebration: "Célébration",

    enterNameToJoin: "Entrez votre nom pour participer",
    joinTheFeed: "Rejoindre le fil",
    joinRateLimited: "Trop de personnes rejoignent depuis ce réseau. Réessayez dans une minute.",
    joinNicknameTaken: "Ce pseudo est déjà pris dans cet événement. Choisissez-en un autre.",
    joinEventFull: "Cet événement est complet : il a autant d'invités que le permet l'offre de son organisateur.",
    joinAgain: "Vous n'êtes plus inscrit à cet événement sur cet appareil. Choisissez un pseudo pour le rejoindre à nouveau.",

    filesSelected: (v) =>
      Number(v.count) === 1 ? "{count} fichier sélectionné" : "{count} fichiers sélectionnés",
    tapToChoose: "Appuyez pour prendre ou choisir des photos/vidéos",
    uploadHint: "Photos et vidéos jusqu'à 512 Mo — les envois interrompus reprennent automatiquement",
    addCaptionPlaceholder: "Ajouter une légende (optionnel)",
    removeFile: "Retirer {name}",
    optimizing: "Optimisation…",
    uploading: "Envoi en cours…",
    shareMoment: (v) =>
      Number(v.count) > 1 ? "Partager {count} souvenirs" : "Partager ce souvenir",
    uploadPaused: "« {name} » est en attente et reprendra automatiquement",
    uploadManagerTitle: "Envois",
    uploadStatus_queued: "En attente",
    uploadStatus_uploading: "Envoi en cours",
    uploadStatus_paused: "En pause",
    uploadStatus_retrying: "Nouvelle tentative",
    uploadStatus_completed: "Terminé",
    uploadStatus_failed: "Échec",
    retryUpload: "Réessayer",
    cancelUpload: "Annuler",
    dismissUpload: "Masquer",
    clearCompleted: "Effacer les terminés",
    allUploadsComplete: "Tous les envois sont terminés",
    uploadsSafeHint: "Ces souvenirs sont enregistrés en sécurité dans la galerie.",

    eventNotFound: "Événement introuvable.",
    eventNotHosted: "Cet événement n'est plus hébergé.",
    greetingName: "Salut {name}",
    yourPoints: "Tes points :",
    leaveEvent: "Quitter",
    leaveEventTitle: "Quitter cet événement ?",
    leaveEventBody:
      "Les photos et vidéos que tu as partagées depuis ce navigateur sont supprimées et ton pseudo est libéré. C'est définitif.",
    leaveEventConfirm: "Quitter et supprimer",
    leaveEventCancel: "Annuler",
    leaveEventLeaving: "Suppression…",
    leaveEventFailed: "Impossible de terminer. Une partie de ce que tu as partagé est peut-être déjà supprimée ; réessaie pour finir.",
    leaveEventRateLimited: "Trop d'essais. Attends un instant, puis réessaie.",
    noMomentsYetBeFirst: "Aucun souvenir pour l'instant — soyez le premier à en partager un !",
    uploadFailed: "Échec de l'envoi de {failed} fichier(s) sur {total}",
    filesTooLarge: "{skipped} fichier(s) trop volumineux (max {maxMb}Mo), ignorés",
    loadMore: "Charger plus",
    loadingMore: "Chargement…",
    endOfFeed: "Vous êtes à jour",
    pagePrev: "Page précédente",
    pageNext: "Page suivante",
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
    highlightsTab: "Favoris",
    noHighlightsYet: "Les souvenirs favoris apparaîtront ici.",
    openSlideshow: "Ouvrir le diaporama en direct",
    liveSlideshow: "Diaporama en direct",
    pauseSlideshow: "Stop",
    resumeSlideshow: "Reprendre",
    fullscreen: "Plein écran",
    closeSlideshow: "Retour",
    slideshowWaiting: "En attente du premier souvenir…",
    slideshowLoading: "Chargement du diaporama…",
    slideshowRetrying: "Impossible de joindre Moments pour le moment. Nouvelle tentative…",
    videoMoment: "Souvenir vidéo",
    sharedBy: "Partagé par {name}",
    previousMoment: "Souvenir précédent",
    nextMoment: "Souvenir suivant",
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
    bannerProgressHint: "Cela prend généralement une quarantaine de secondes — un instant.",
    bannerFallbackHeading: "Ou choisissez une bannière prête à l'emploi",
    bannerReviewHeading: "Vérifiez votre bannière — confirmez ou régénérez",
    bannerReviewAlt: "Aperçu de la bannière générée",
    confirmBanner: "Confirmer",
    regenerateBanner: "Régénérer",
    sampleGolden: "Heure dorée",
    sampleBlush: "Rosé",
    sampleMidnight: "Minuit",
    sampleSunset: "Coucher de soleil",
    sampleForest: "Forêt",
    sampleConfetti: "Confettis",
    bannerWedding: "Mariage",
    bannerGala: "Gala",
    bannerBirthday: "Anniversaire",
    bannerCorporate: "Entreprise",
    bannerGraduation: "Remise de diplômes",
    bannerParty: "Soirée",
    bannerOther: "Autre",

    footerTagline: "Conçu pour les instants qui valent d'être partagés.",
    footerPrivacy: "Confidentialité",
    footerTerms: "Conditions",
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
  en: { Wedding: "Wedding", Gala: "Gala", Birthday: "Birthday", Graduation: "Graduation", Corporate: "Corporate", Party: "Party", Other: "Other" },
  fr: { Wedding: "Mariage", Gala: "Gala", Birthday: "Anniversaire", Graduation: "Remise de diplômes", Corporate: "Entreprise", Party: "Soirée", Other: "Autre" },
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
